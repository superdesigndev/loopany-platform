/**
 * Callback mode — the in-run `loopany <verb>` path (run token in env). Proves it now
 * funnels through the unified `/api/machine/cli` dispatch carrying the RUN token, that
 * it inlines the file flags before posting, and that it falls back to the legacy
 * `/agent-api/loop` when an OLD server 404s the unified endpoint. Global `fetch` is
 * stubbed and the run env is set, so nothing hits the network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate ~/.loopany BEFORE config.ts loads (LOOPANY_DIR is read at import) so the
// not-configured test can't accidentally resolve a real stored server url.
vi.hoisted(() => {
  process.env.LOOPANY_HOME = "/tmp/loopany-callback-test-home-does-not-exist";
});

import { runCallback } from "./callback.js";

type Call = { url: string; init: any };

/** Stub global fetch with a per-request handler; record every call. */
function stubFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as Response;
  });
  return calls;
}

describe("runCallback — unified dispatch", () => {
  const prevToken = process.env.LOOPANY_RUN_TOKEN;
  const prevServer = process.env.LOOPANY_SERVER_URL;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.LOOPANY_RUN_TOKEN = "run-tok-1";
    process.env.LOOPANY_SERVER_URL = "https://srv.test";
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (prevToken === undefined) delete process.env.LOOPANY_RUN_TOKEN;
    else process.env.LOOPANY_RUN_TOKEN = prevToken;
    if (prevServer === undefined) delete process.env.LOOPANY_SERVER_URL;
    else process.env.LOOPANY_SERVER_URL = prevServer;
  });

  const stdout = () => outSpy.mock.calls.map((c) => String(c[0])).join("");
  const stderr = () => errSpy.mock.calls.map((c) => String(c[0])).join("");

  test("posts argv to /api/machine/cli with the RUN token; renders text + exitCode", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { text: "reported.", exitCode: 0 } }));
    const code = await runCallback(["report", "--status", "nothing-new"]);
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("https://srv.test/api/machine/cli");
    expect(JSON.parse(calls[0]!.init.body).argv).toEqual(["report", "--status", "nothing-new"]);
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer run-tok-1");
    expect(stdout()).toContain("reported.");
  });

  test("a non-zero server exitCode is propagated to the process exit code", async () => {
    stubFetch(() => ({ status: 200, body: { text: "loopany: bad flag", exitCode: 2 } }));
    expect(await runCallback(["report", "--bogus"])).toBe(2);
    expect(stdout()).toContain("bad flag");
  });

  test("inlines a --message-file into --message before posting (shared client)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-cb-"));
    const msgFile = path.join(dir, "msg.txt");
    fs.writeFileSync(msgFile, "a long human message body");
    const calls = stubFetch(() => ({ status: 200, body: { text: "ok", exitCode: 0 } }));
    await runCallback(["report", "--status", "new", "--message-file", msgFile]);
    const argv = JSON.parse(calls[0]!.init.body).argv;
    expect(argv).toEqual(["report", "--status", "new", "--message", "a long human message body"]);
  });

  test("an unreadable file flag fails with exit 1, posts nothing", async () => {
    const calls = stubFetch(() => ({ status: 200, body: {} }));
    const code = await runCallback(["report", "--message-file", "/no/such/path.txt"]);
    expect(code).toBe(1);
    expect(stderr()).toContain("cannot read");
    expect(calls).toHaveLength(0);
  });

  test("falls back to legacy /agent-api/loop when the server 404s the unified dispatch", async () => {
    const calls = stubFetch((url) =>
      url.includes("/api/machine/cli")
        ? { status: 404, body: { error: "not found" } }
        : { status: 200, body: { text: "reported (legacy).", exitCode: 0 } },
    );
    const code = await runCallback(["report", "--status", "new", "--message", "hi"]);
    expect(code).toBe(0);
    expect(calls[0]!.url).toContain("/api/machine/cli");
    expect(calls[1]!.url).toBe("https://srv.test/agent-api/loop");
    expect(JSON.parse(calls[1]!.init.body).argv).toEqual(["report", "--status", "new", "--message", "hi"]);
    expect(calls[1]!.init.headers.Authorization).toBe("Bearer run-tok-1");
    expect(stdout()).toContain("reported (legacy).");
  });

  test("F2: in-run `loopany log` prints the server's TOON survey text on the EXISTING daemon", async () => {
    // Batch 1 makes the server's `/api/machine/cli` `log` response carry a `text`
    // field ALONGSIDE the structured `runs` (superset body). This UNCHANGED 0.11
    // callback already prints `body.text` — so the moment the server ships, in-run
    // `loopany log` (which printed nothing before, F2) starts working with no daemon
    // release. This e2e proves that contract at the callback boundary.
    const survey = [
      'loop: "Docs Sweep" (loop-abc)',
      "count: 1 of 12 total",
      "runs[1]{ts,role,outcome,cost,metrics,session,message}:",
      '  "2026-07-05 06:00",exec,ok/nothing-new,$0.08,drift=0,sess-abc,"no drift"',
      "summary: showing 1 of 12 · 1 ok · last exec ok/nothing-new 2026-07-05 06:00",
      "help[2]:",
      "  Run `loopany log loop-abc --full` to inline each run's transcript",
    ].join("\n");
    const calls = stubFetch(() => ({
      status: 200,
      // The real superset body: structured fields + the new `text`/`exitCode`.
      body: { ok: true, loopId: "loop-abc", name: "Docs Sweep", runs: [{ id: "r1" }], text: survey, exitCode: 0 },
    }));
    const code = await runCallback(["log"]);
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("https://srv.test/api/machine/cli");
    expect(JSON.parse(calls[0]!.init.body).argv).toEqual(["log"]);
    // The key F2 assertion: stdout is NON-EMPTY and carries the survey.
    expect(stdout().length).toBeGreaterThan(0);
    expect(stdout()).toContain('loop: "Docs Sweep" (loop-abc)');
    expect(stdout()).toContain("runs[1]{ts,role,outcome,cost,metrics,session,message}:");
    expect(stdout()).toContain("summary:");
  });

  test("no server url → control channel not configured (exit 2, no fetch)", async () => {
    delete process.env.LOOPANY_SERVER_URL;
    const calls = stubFetch(() => ({ status: 200, body: {} }));
    const code = await runCallback(["report"]);
    expect(code).toBe(2);
    expect(stderr()).toContain("control channel not configured");
    expect(calls).toHaveLength(0);
  });
});
