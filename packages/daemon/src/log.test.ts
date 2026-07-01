/**
 * `loopany log`, exercised with every external touch INJECTED (cwd, fetch, output,
 * server, token) so nothing reads a real ~/.loopany or hits the network. Proves it
 * resolves the loop for the current workdir, forwards an explicit loop arg, and
 * wires to the device-token-scoped `/api/machine/log` endpoint.
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

  test("resolves the loop for the current workdir and prints its runs", async () => {
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": {
        body: { loops: [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }] },
      },
      "/api/machine/log": {
        body: {
          ok: true,
          name: "Here",
          runs: [
            { id: "r1", ts: "2026-06-01T00:00:02Z", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: 1500, error: null, message: "did the thing", sessionId: "sess-r1", state: { mrr: 42 }, sample: null, transcript: "$ Bash echo hi", transcriptTruncated: false },
          ],
        },
      },
    });
    const cap = capture({ cwd: () => loopDir, fetchFn });
    const code = await runLog([], cap);
    expect(code).toBe(0);
    // Listed loops, then queried the resolved loop id.
    expect(calls.some((u) => u.includes("/api/machine/log?") && u.includes("loopId=loop-here"))).toBe(true);
    expect(cap.stdout()).toContain("did the thing");
    expect(cap.stdout()).toContain("$ Bash");
    // The compact human render surfaces the session id so the reader can find the JSONL.
    expect(cap.stdout()).toContain("session: sess-r1");
    // …and the metrics the run reported, as a compact k=v line.
    expect(cap.stdout()).toContain("metrics: mrr=42");
  });

  test("a subdirectory of the loop workdir still resolves to that loop", async () => {
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-here", name: "Here", workdir: loopDir, taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "Here", runs: [] } },
    });
    const cap = capture({ cwd: () => path.join(loopDir, "nested", "deep"), fetchFn });
    expect(await runLog([], cap)).toBe(0);
    expect(calls.some((u) => u.includes("loopId=loop-here"))).toBe(true);
    expect(cap.stdout()).toContain("no runs yet");
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

  test("an explicit loop id is forwarded without needing a workdir match", async () => {
    const { fetchFn, calls } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { body: { ok: true, name: "X", runs: [] } },
    });
    const cap = capture({ cwd: () => "/unrelated/dir", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(0);
    expect(calls.some((u) => u.includes("loopId=loop-x"))).toBe(true);
  });

  test("--limit and --json are forwarded / honored", async () => {
    const runs = [{ id: "r1", ts: "t", role: "exec", phase: "done", outcome: "exec", status: null, durationMs: null, error: null, message: null, sessionId: "sess-r1", state: { mrr: 42 }, sample: null, transcript: "", transcriptTruncated: false }];
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

  test("a server error on the log call surfaces and exits 1", async () => {
    const { fetchFn } = stubFetch({
      "/api/machine/loop": { body: { loops: [{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }] } },
      "/api/machine/log": { ok: false, status: 404, body: { error: "no such loop on this machine" } },
    });
    const cap = capture({ cwd: () => "/unrelated", fetchFn });
    expect(await runLog(["loop-x"], cap)).toBe(1);
    expect(cap.stderr()).toContain("no such loop");
  });
});
