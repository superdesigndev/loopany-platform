/**
 * THE DEV ENTRY SURFACE — the local converged workspace home and help.
 *
 *   1. bare `loopany` routed to the LEGACY home, which queries the legacy tables
 *      and renders an empty machine dashboard beside a live kernel;
 *   2. `loopany --help` never named the kernel verb family at all, so the whole
 *      surface was undiscoverable from the one screen a user looks at;
 * Everything here is driven through injected seams — no network, no ~/.loopany,
 * no subprocess. The retired `LOOPANY_RUNS_V2` switch is gone entirely (S5):
 * `LOOPANY_DEV_HOME` is the ONE marker, and it is presentation-only.
 */
import { describe, expect, test } from "vitest";

import { printHelp } from "./help.js";
import { renderKernelHome, runKernelHome } from "./kernel-home.js";
import { classify } from "./route.js";

// ------------------------------------------------------------------ 1. the route

describe("bare `loopany` picks the local workspace home only from its presentation marker", () => {
  test("the production command keeps the production home, flag or no flag", () => {
    expect(classify([], {})).toEqual({ kind: "home" });
    // No env key other than LOOPANY_DEV_HOME can move it.
    expect(classify([], { LOOPANY_DEV_HOME: "0" })).toEqual({ kind: "home" });
  });

  test("the loopany-dev presentation marker selects the converged workspace home", () => {
    expect(classify([], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "kernel-home" });
  });

  test("the marker never hijacks a verb — only the bare command changes presentation", () => {
    expect(classify(["loops"], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "interactive", argv: ["loops"] });
    expect(classify(["loop", "list"], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "kernel", argv: ["loop", "list"] });
    expect(classify(["--help"], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "help" });
  });

  test("in a RUN the callback still wins", () => {
    expect(classify([], { LOOPANY_DEV_HOME: "1", LOOPANY_RUN_TOKEN: "rk_x" })).toEqual({ kind: "callback", argv: ["home"] });
  });
});

// ----------------------------------------------------------------- 1. the render

const LOOPS_BODY = {
  loops: [
    { id: "loop-4c1d77", title: "Housekeeper", status: "active", nextFire: "2026-08-05T07:00:00+08:00" },
    { id: "loop-8e3311", title: "Twin", status: "paused", nextFire: null },
    { id: "loop-000001", title: "On demand", status: "active", nextFire: null },
  ],
  recentRuns: [
    { id: "run-a", loopId: "loop-4c1d77", state: "success", finishedAt: "2026-08-04T07:04:00Z", summary: "swept 3 chores" },
    { id: "run-b", loopId: "loop-8e3311", state: "failure", finishedAt: "2026-08-04T06:00:00Z", summary: null },
  ],
};

const inboxOk = (counts: Record<string, number>) => ({ status: 200, body: { counts } });

describe("the kernel home render", () => {
  test("prints the roster, the inbox floor and the newest runs", () => {
    const text = renderKernelHome({
      bin: "/usr/local/bin/loopany",
      server: "http://127.0.0.1:3155",
      loops: LOOPS_BODY,
      inbox: inboxOk({ question: 2, total: 2 }),
    });
    expect(text).toContain("bin: /usr/local/bin/loopany");
    expect(text).toContain("stack: prod-poll · http://127.0.0.1:3155");
    expect(text).toContain("loops[3]{id,title,status,next_fire}:");
    expect(text).toContain('loop-4c1d77,Housekeeper,active,"2026-08-05T07:00:00+08:00"');
    expect(text).toContain("inbox: 2 waiting — 2 questions");
    expect(text).toContain("runs[2]{at,loop,state,summary}:");
    expect(text).toContain('"2026-08-04T07:04:00Z",loop-4c1d77,success,"swept 3 chores"');
  });

  test("a blank next_fire always says WHY — paused vs no cadence at all", () => {
    const text = renderKernelHome({ bin: null, server: "http://127.0.0.1:3155", loops: LOOPS_BODY, inbox: inboxOk({ total: 0 }) });
    expect(text).toContain('loop-8e3311,Twin,paused,"— (paused)"');
    expect(text).toContain('"— (no cadence — runs on demand only)"');
    // The pre-rendered annotation must never leak its NUL sentinel into stdout.
    expect(text).not.toContain(String.fromCharCode(0));
  });

  test("an empty stack teaches the production creation flow and task-file rule", () => {
    const text = renderKernelHome({ bin: null, server: "http://127.0.0.1:3155", loops: { loops: [], recentRuns: [] }, inbox: inboxOk({ total: 0 }) });
    expect(text).toContain("loops: []");
    expect(text).toContain("loopany new --json");
    expect(text).toContain("task file's `## Spec`");
  });

  test("a failed inbox read is SAID, never rendered as a reassuring zero", () => {
    const text = renderKernelHome({ bin: null, server: "s", loops: LOOPS_BODY, inbox: { error: "socket hang up" } });
    expect(text).toContain("inbox: — (unavailable: socket hang up)");
    expect(text).not.toContain("nothing needs you");
  });

  test("a refused inbox read carries the kernel's own sentence", () => {
    const text = renderKernelHome({ bin: null, server: "s", loops: LOOPS_BODY, inbox: { status: 401, body: { message: "an enrolled device credential or signed-in human session is required" } } });
    expect(text).toContain("inbox: — (unavailable: an enrolled device credential or signed-in human session is required)");
  });
});

// ------------------------------------------------------------------ 1. the fetch

function homeDeps(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const seen: { url: string; init?: RequestInit }[] = [];
  let out = "";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { seen, out: () => out, deps: { fetchImpl, binPath: () => "/bin/loopany", out: (s: string) => void (out += s) } };
}

describe("runKernelHome — the reads and the degraded paths", () => {
  test("reads BOTH kernel surfaces with the enrolled device credential", async () => {
    const h = homeDeps((url) => (url.endsWith("/api/inbox") ? { status: 200, body: { counts: { total: 0 } } } : { status: 200, body: LOOPS_BODY }));
    const code = await runKernelHome({ ...h.deps, server: "http://127.0.0.1:3155/", env: { LOOPANY_TOKEN: "dk_secret" } });
    expect(code).toBe(0);
    expect(h.seen.map((r) => r.url).sort()).toEqual([
      "http://127.0.0.1:3155/api/inbox",
      "http://127.0.0.1:3155/api/views/loops",
    ]);
    for (const r of h.seen) {
      expect((r.init?.headers as Record<string, string>).Authorization).toBe("Bearer dk_secret");
    }
    expect(h.out()).toContain("loops[3]");
  });

  test("a session cookie DOES ride along (the same credential `loopany inbox` uses)", async () => {
    const h = homeDeps(() => ({ status: 200, body: { counts: { total: 0 }, loops: [], recentRuns: [] } }));
    await runKernelHome({ ...h.deps, server: "http://127.0.0.1:3155", env: { LOOPANY_SESSION: "tok.sig" } });
    expect((h.seen[0]!.init!.headers as Record<string, string>).Cookie).toBe("better-auth.session_token=tok.sig");
  });

  test("no server configured → a DEFINITIVE not-connected home at exit 0, no fetch", async () => {
    const h = homeDeps(() => ({ status: 200, body: {} }));
    const code = await runKernelHome({ ...h.deps, server: "", env: {} });
    expect(code).toBe(0);
    expect(h.seen).toHaveLength(0);
    expect(h.out()).toContain("stack: prod-poll · not connected");
    expect(h.out()).toContain("LOOPANY_SERVER_URL");
  });

  test("an unreachable stack degrades — never hangs, never empty, never exits non-zero", async () => {
    let out = "";
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const code = await runKernelHome({ fetchImpl, binPath: () => null, out: (s) => void (out += s), server: "http://127.0.0.1:3155", env: {} });
    expect(code).toBe(0);
    expect(out).toContain("unreachable right now (fetch failed)");
    expect(out).toContain("bin: (not on PATH");
  });

  test("a refusal keeps the home SHAPE and prints the kernel's teaching verbatim", async () => {
    const h = homeDeps(() => ({ status: 401, body: { message: "an enrolled device credential or signed-in human session is required", code: "UNAUTHORIZED", hint: "connect this machine or sign in" } }));
    const code = await runKernelHome({ ...h.deps, server: "http://127.0.0.1:3155", env: {} });
    expect(code).toBe(0);
    expect(h.out()).toContain("code: UNAUTHORIZED");
    expect(h.out()).toContain("connect this machine or sign in");
    expect(h.out()).toContain("LOOPANY_SESSION");
  });
});

// ------------------------------------------------------------------- 2. the help

describe("`loopany --help` names the converged workspace family", () => {
  const screen = () => {
    let out = "";
    printHelp((s) => void (out += s), "9.9.9");
    return out;
  };

  test("carries a delimited workspace section and production loop pointers", () => {
    const out = screen();
    expect(out).toContain("Converged workspace verbs");
    for (const verb of [
      "`loops` / `show` / `new` / `edit`",
      "task list", "task show", "task create", "task update", "task close",
      "doc show|create|update", "mirror attach|detach", "inbox", "answer <task-id>",
    ]) {
      expect(out, `the help screen must name \`${verb}\``).toContain(verb);
    }
  });

  test("points at per-verb --help rather than restating the grammar", () => {
    expect(screen()).toContain("loopany <verb> --help");
  });

  test("states that retired kernel loop commands are teaching-only", () => {
    const out = screen();
    expect(out).toContain("Retired `loop *` kernel commands");
    expect(out).toContain("write nothing");
  });

  test("still carries the whole legacy surface (this is an addition, not a replacement)", () => {
    const out = screen();
    for (const legacy of ["up [--foreground]", "setup hooks", "show [<id>]", "loops [--fields a,b]", "edit <id>"]) {
      expect(out).toContain(legacy);
    }
  });
});

describe("the local marker cannot redirect production commands", () => {
  test("the loopany-dev marker is presentation-only", () => {
    expect(classify(["loops"], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "interactive", argv: ["loops"] });
  });

  test("kernel loop commands remain teaching routes under the local marker", () => {
    expect(classify(["loop", "retire", "loop-x"], { LOOPANY_DEV_HOME: "1" })).toEqual({ kind: "kernel", argv: ["loop", "retire", "loop-x"] });
  });
});
