/**
 * `loopany log`, exercised with every external touch INJECTED (cwd, fetch, output,
 * server, token) so nothing reads a real ~/.loopany or hits the network. Proves it
 * resolves the loop for the current workdir, forwards an explicit loop arg, and wires
 * to the run log.
 *
 * The `runLog` describe below uses a fetch stub that 404s any path but the two legacy
 * routes (`/api/machine/loop`, `/api/machine/log`), so it exercises the **404 → legacy
 * fallback** half of the compat matrix (a pre-unified server). Batch 7 made the daemon a
 * pure text sink, so a realistic batch-1+ legacy server returns `text` on its endpoints
 * (the methods render it); the legacy stubs below carry `text` accordingly, and the
 * default render is the server's `text`. A legacy response WITHOUT `text` (a truly
 * ancient pre-text server) surfaces the definitive SERVER_TOO_OLD error. The `runLog —
 * unified /api/machine/cli` describe at the bottom covers the **NEW server** primary path.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { runLog, type LogDeps } from "./log.js";

/** Capture stdout/stderr; default a connected machine (server + token present). */
function capture(extra: LogDeps = {}): LogDeps & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    server: "https://srv.test",
    token: "dk_test",
    stdout: () => out,
    stderr: () => err,
    ...extra,
  };
}

/** A fetch stub: records requested URLs, replies from a per-path map. */
function stubFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(String(url));
    // Match by pathname (ignore the query string) for the list, by prefix for log.
    const u = new URL(String(url));
    const key = u.pathname;
    const r = routes[key] ?? { ok: false, status: 404, body: { error: "no route" } };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const loopDir = path.join(os.tmpdir(), "loopany-log-test-workdir");

describe("runLog", () => {
  test("not connected → error, exit 2, no fetch", async () => {
    const { fetchFn, calls } = stubFetch({});
    const cap = capture({ server: "", token: undefined, fetchFn });
    const code = await runLog([], cap);
    expect(code).toBe(2);
    expect(cap.stderr()).toContain("isn't connected");
    expect(calls).toHaveLength(0);
  });

  test("resolves the loop for the current workdir and prints the server survey (text sink over the legacy fallback)", async () => {
    const survey = `loop: "Here" (loop-here)\ncount: 1 of 1 total\nruns[1]{ts,role,outcome,cost,metrics,session,message}:\n  2026-06-01 00:00,exec,exec,—,mrr=42,sess-r1,"did the thing"\nsummary: showing 1 of 1`;
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": {
        body: { loops: [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }] },
      },
      "/api/machine/log": {
        body: {
          ok: true,
          name: "Here",
          runs: [
            { id: "r1", ts: "2026-06-01T00:00:02Z", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: 1500, error: null, message: "did the thing", sessionId: "sess-r1", state: { mrr: 42 }, transcript: "$ Bash echo hi", transcriptTruncated: false },
          ],
          text: survey,
          exitCode: 0,
        },
      },
    });
    const cap = capture({ cwd: () => loopDir, fetchFn });
    const code = await runLog([], cap);
    expect(code).toBe(0);
    // Listed loops, then queried the resolved loop id.
    expect(calls.some((u) => u.includes("/api/machine/log?") && u.includes("loopId=loop-here"))).toBe(true);
    // Text sink: the server's rendered survey is printed verbatim, not a daemon render.
    expect(cap.stdout()).toBe(survey + "\n");
    // The default survey is CONCISE — the verbose transcript is NOT inlined.
    expect(cap.stdout()).not.toContain("$ Bash");
  });

  test("--transcript (alias --full) inlines the clipped transcript", async () => {
    const routes = {
      "/api/machine/loop": {
        body: { loops: [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }] },
      },
      "/api/machine/log": {
        body: {
          ok: true,
          name: "Here",
          runs: [
            { id: "r1", ts: "2026-06-01T00:00:02Z", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: 1500, error: null, message: "did the thing", sessionId: "sess-r1", state: { mrr: 42 }, transcript: "$ Bash echo hi", transcriptTruncated: false },
          ],
        },
      },
    };
    for (const flag of ["--transcript", "--full"]) {
      const { fetchFn } = stubFetch(routes);
      const cap = capture({ cwd: () => loopDir, fetchFn });
      expect(await runLog([flag], cap)).toBe(0);
      // With the flag the transcript is inlined; the concise fields remain.
      expect(cap.stdout()).toContain("$ Bash");
      expect(cap.stdout()).toContain("session: sess-r1");
      expect(cap.stdout()).toContain("metrics: mrr=42");
    }
  });

  test("a subdirectory of the loop workdir still resolves to that loop", async () => {
    const survey = `loop: "Here" (loop-here)\ncount: 0 of 0 total\nruns: []`;
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "Here", runs: [], text: survey, exitCode: 0 } },
    });
    const cap = capture({ cwd: () => path.join(loopDir, "nested", "deep"), fetchFn });
    expect(await runLog([], cap)).toBe(0);
    expect(calls.some((u) => u.includes("loopId=loop-here"))).toBe(true);
    expect(cap.stdout()).toBe(survey + "\n");
  });

  test("no folder match → exit 2 with a hint to pass a loop id", async () => {
    const { fetchFn } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-other", name: "Other", workdir: "/somewhere/else", taskFile: null }] } },
    });
    const cap = capture({ cwd: () => loopDir, fetchFn });
    const code = await runLog([], cap);
    expect(code).toBe(2);
    expect(cap.stderr()).toContain("loop id");
  });

  test("F5: an explicit nonexistent loop id → structured NOT_FOUND to STDOUT, exit 1 (not prose/exit 2)", async () => {
    const { fetchFn } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-real", name: "Real", workdir: "/elsewhere", taskFile: null }] } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    const code = await runLog(["loop-zzzz-00000000"], cap);
    expect(code).toBe(1); // an error, not a usage failure
    // P6: `error:`/`code:` to STDOUT (never a prose `loopany:` line on stderr).
    expect(cap.stdout()).toContain("code: NOT_FOUND");
    expect(cap.stdout()).toContain('error: "no loop \\"loop-zzzz-00000000\\" on this machine');
    expect(cap.stdout()).toContain("run `loopany loops`"); // actionable guidance kept
    expect(cap.stderr()).toBe("");
  });

  test("an unknown flag on log → exit 2 (uniform with loops/edit), no server fetch for the log call", async () => {
    const { fetchFn } = stubFetch({});
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["--bogus"], cap)).toBe(2);
    expect(cap.stderr()).toContain("unknown flag --bogus");
  });

  test("an explicit loop id is forwarded without needing a workdir match", async () => {
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs: [], text: "runs: []", exitCode: 0 } },
    });
    const cap = capture({ cwd: () => "/unrelated/dir", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(0);
    expect(calls.some((u) => u.includes("loopId=loop-x"))).toBe(true);
  });

  test("--limit and --json are forwarded / honored", async () => {
    const runs = [{ id: "r1", ts: "t", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: null, error: null, message: null, sessionId: "sess-r1", state: { mrr: 42 }, transcript: "", transcriptTruncated: false }];
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x", "--limit", "3", "--json"], cap)).toBe(0);
    expect(calls.some((u) => u.includes("limit=3"))).toBe(true);
    // --json prints raw JSON, not the human header — including the session id.
    expect(cap.stdout()).toContain('"id": "r1"');
    expect(cap.stdout()).toContain('"sessionId": "sess-r1"');
    // Metrics flow through verbatim in --json output too.
    expect(cap.stdout()).toContain('"mrr": 42');
    expect(cap.stdout()).not.toContain("recent run");
  });

  test("--limit=5 (the --k=v form) parses like --limit 5 instead of erroring as an unknown flag", async () => {
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs: [], text: "runs: []", exitCode: 0 } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x", "--limit=5"], cap)).toBe(0);
    expect(cap.stderr()).not.toContain("unknown flag");
    expect(calls.some((u) => u.includes("limit=5"))).toBe(true);
  });

  test("--json before the loop id keeps the id positional (boolean flag, no swallow)", async () => {
    const runs = [{ id: "r1", ts: "t", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: null, error: null, message: null, transcript: "", transcriptTruncated: false }];
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    // --json must NOT consume "loop-x" as its value; the id stays positional.
    expect(await runLog(["--json", "loop-x"], cap)).toBe(0);
    expect(calls.some((u) => u.includes("loopId=loop-x"))).toBe(true);
    // json mode still active → raw JSON, not the human header.
    expect(cap.stdout()).toContain('"id": "r1"');
    expect(cap.stdout()).not.toContain("recent run");
  });

  test("a server error on the log call surfaces its rendered `text` and exits 1", async () => {
    // A real server renders the error as `error:`/`code:` TOON in `text` (finalizeCli on
    // the unified path; the methods on the legacy path). The daemon text-sinks it.
    const errText = `error: "no such loop on this machine"\ncode: NOT_FOUND`;
    const { fetchFn } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { ok: false, status: 404, body: { error: "no such loop on this machine", text: errText, exitCode: 1 } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(1);
    expect(cap.stdout()).toContain("no such loop");
    expect(cap.stdout()).toContain("code: NOT_FOUND");
  });

  test("a too-old server (a log reply with NO `text`) surfaces the definitive SERVER_TOO_OLD error, exit 1", async () => {
    const { fetchFn } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs: [] } }, // no `text`
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(1);
    expect(cap.stdout()).toContain("code: SERVER_TOO_OLD");
    expect(cap.stdout()).toContain("too old for this CLI");
  });
});

/**
 * NEW server: the unified `/api/machine/cli` POST dispatch answers BOTH the loops-list
 * (to resolve the workdir → loop id, client-side) and the log fetch. This is the
 * primary path; the describe above covers the 404 → legacy fallback.
 */
function stubUnified(loops: LoopStub[], runsFor: (argv: string[]) => { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; argv: string[] }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const u = String(url);
    const argv: string[] = init?.body ? (JSON.parse(init.body).argv ?? []) : [];
    calls.push({ url: u, argv });
    if (u.includes("/api/machine/cli") && argv[0] === "loops") {
      return { ok: true, status: 200, json: async () => ({ ok: true, loops }) };
    }
    if (u.includes("/api/machine/cli") && argv[0] === "log") {
      const r = runsFor(argv);
      return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
    }
    return { ok: false, status: 404, json: async () => ({ error: "no route" }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

type LoopStub = { id: string; name: string; workdir: string | null; taskFile: string | null };

describe("runLog — unified /api/machine/cli (new server)", () => {
  const oneRun = [{ id: "r1", ts: "2026-06-01T00:00:02Z", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: 1500, error: null, message: "did the thing", sessionId: "sess-r1", state: { mrr: 42 }, transcript: "$ Bash echo hi", transcriptTruncated: false }];

  test("resolves the workdir loop and posts `loops` then `log <id>` to the unified endpoint", async () => {
    const survey = `loop: "Here" (loop-here)\ncount: 1 of 1 total\nsummary: showing 1 of 1`;
    const { fetchFn, calls } = stubUnified(
      [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }],
      () => ({ ok: true, body: { ok: true, name: "Here", runs: oneRun, text: survey, exitCode: 0 } }),
    );
    const cap = capture({ cwd: () => loopDir, fetchFn });
    expect(await runLog([], cap)).toBe(0);
    // Both round-trips went to the unified dispatch (POST {argv}), never the legacy GETs.
    expect(calls.every((c) => c.url.includes("/api/machine/cli"))).toBe(true);
    expect(calls[0]!.argv).toEqual(["loops"]);
    expect(calls[1]!.argv).toEqual(["log", "loop-here"]);
    // Text sink: the server survey prints verbatim.
    expect(cap.stdout()).toBe(survey + "\n");
  });

  test("an explicit loop id + --limit forwards through the unified `log` argv", async () => {
    const survey = `loop: "X" (loop-x)\ncount: 0 of 0 total\nruns: []`;
    const { fetchFn, calls } = stubUnified(
      [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }],
      () => ({ ok: true, body: { ok: true, name: "X", runs: [], text: survey, exitCode: 0 } }),
    );
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x", "--limit", "3"], cap)).toBe(0);
    expect(calls[1]!.argv).toEqual(["log", "loop-x", "--limit", "3"]);
    expect(cap.stdout()).toBe(survey + "\n");
  });

  test("text sink: the default (non-transcript) log prints the server `text` verbatim, not its own render", async () => {
    const toon = "loop: X (loop-x)\ncount: 1 of 1 total\nruns[1]{ts,role,outcome,cost,metrics,session,message}:\n  2026-06-01 00:00,exec,ok,—,mrr=42,sess-r1,\"did the thing\"\nsummary: showing 1 of 1 · 1 ok";
    const { fetchFn } = stubUnified(
      [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }],
      () => ({ ok: true, body: { ok: true, name: "X", runs: oneRun, text: toon, exitCode: 0 } }),
    );
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(0);
    expect(cap.stdout()).toBe(toon + "\n");
    // NOT the structured concise render (that is the old-server fallback only).
    expect(cap.stdout()).not.toContain("● ");
  });

  test("--transcript keeps the structured render (server survey stays concise) even when `text` is present", async () => {
    const toon = "loop: X (loop-x)\ncount: 1 of 1 total";
    const { fetchFn } = stubUnified(
      [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }],
      () => ({ ok: true, body: { ok: true, name: "X", runs: oneRun, text: toon, exitCode: 0 } }),
    );
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x", "--transcript"], cap)).toBe(0);
    // The transcript render inlines the run body from the structured runs.
    expect(cap.stdout()).toContain("$ Bash echo hi");
    expect(cap.stdout()).not.toBe(toon + "\n");
  });
});
