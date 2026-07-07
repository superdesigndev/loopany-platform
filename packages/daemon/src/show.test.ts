/**
 * `loopany show` OUT of a run (F1) — resolves the loop client-side (like `log`), then
 * forwards `show <id>` to the unified dispatch on the device credential and prints the
 * server's rendered envelope `text`. Every touch is injected.
 */
import { describe, expect, test } from "vitest";

import { runShow, type ShowDeps } from "./show.js";

function stub(loops: any[], showFor: (argv: string[]) => { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; argv: string[] }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const u = String(url);
    const argv: string[] = init?.body ? (JSON.parse(init.body).argv ?? []) : [];
    calls.push({ url: u, argv });
    if (u.includes("/api/machine/cli") && argv[0] === "loops") return { ok: true, status: 200, json: async () => ({ ok: true, loops }) };
    if (u.includes("/api/machine/cli") && argv[0] === "show") {
      const r = showFor(argv);
      return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
    }
    return { ok: false, status: 404, json: async () => ({ error: "no route" }) };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function capture(extra: ShowDeps = {}) {
  let out = "";
  let err = "";
  return {
    deps: { server: "https://srv.test", token: "dk_dev", fetchFn: extra.fetchFn, cwd: () => "/unrelated", out: (s: string) => void (out += s), err: (s: string) => void (err += s), ...extra } as ShowDeps,
    stdout: () => out,
    stderr: () => err,
  };
}

describe("runShow", () => {
  test("explicit id → forwards `show <id>` and prints the server envelope text", async () => {
    const toon = "loop:\n  id: loop-x\n  name: X\n  cron: 0 8 * * *\nnextFire: 2026-07-13 06:00:00 PDT";
    const { fetchFn, calls } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }], () => ({ ok: true, body: { ok: true, text: toon, exitCode: 0 } }));
    const cap = capture({ fetchFn });
    expect(await runShow(["loop-x"], cap.deps)).toBe(0);
    expect(calls[1]!.argv).toEqual(["show", "loop-x"]);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("--json + --full are forwarded on the show argv (the roundtrip envelope transport)", async () => {
    const { fetchFn, calls } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }], () => ({ ok: true, body: { ok: true, text: "{\"id\":\"loop-x\"}", exitCode: 0 } }));
    const cap = capture({ fetchFn });
    expect(await runShow(["loop-x", "--json", "--full"], cap.deps)).toBe(0);
    expect(calls[1]!.argv).toEqual(["show", "loop-x", "--json", "--full"]);
  });

  test("resolves the cwd loop when no id is given", async () => {
    const { fetchFn, calls } = stub([{ id: "loop-here", name: "Here", workdir: "/work/here", taskFile: null }], () => ({ ok: true, body: { ok: true, text: "loop:\n  id: loop-here", exitCode: 0 } }));
    const cap = capture({ fetchFn, cwd: () => "/work/here" });
    expect(await runShow([], cap.deps)).toBe(0);
    expect(calls[1]!.argv).toEqual(["show", "loop-here"]);
  });

  test("--server-url <url> is consumed as a flag value, not the positional loop id", async () => {
    const { fetchFn, calls } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }], () => ({ ok: true, body: { ok: true, text: "loop:\n  id: loop-x", exitCode: 0 } }));
    const cap = capture({ fetchFn });
    // The URL must NOT be mistaken for the loop id; `loop-x` still resolves.
    expect(await runShow(["--server-url", "https://srv.test", "loop-x"], cap.deps)).toBe(0);
    expect(calls[1]!.argv).toEqual(["show", "loop-x"]);
  });

  test("not connected → exit 2, no fetch", async () => {
    const { fetchFn, calls } = stub([], () => ({ ok: true, body: {} }));
    const cap = capture({ fetchFn, server: "", token: undefined });
    expect(await runShow(["loop-x"], cap.deps)).toBe(2);
    expect(calls).toHaveLength(0);
    expect(cap.stderr()).toContain("isn't connected");
  });

  test("F5: an explicit nonexistent loop id → structured NOT_FOUND to STDOUT, exit 1", async () => {
    const { fetchFn } = stub([{ id: "loop-real", name: "Real", workdir: "/elsewhere", taskFile: null }], () => ({ ok: true, body: {} }));
    const cap = capture({ fetchFn });
    const code = await runShow(["loop-zzzz-00000000"], cap.deps);
    expect(code).toBe(1);
    expect(cap.stdout()).toContain("code: NOT_FOUND");
    expect(cap.stdout()).toContain('error: "no loop \\"loop-zzzz-00000000\\" on this machine');
    expect(cap.stderr()).toBe("");
  });

  test("an unknown flag on show → exit 2 (uniform with loops/log/edit)", async () => {
    const { fetchFn, calls } = stub([{ id: "loop-x", name: "X", workdir: "/elsewhere", taskFile: null }], () => ({ ok: true, body: {} }));
    const cap = capture({ fetchFn });
    expect(await runShow(["loop-x", "--bogus"], cap.deps)).toBe(2);
    expect(cap.stderr()).toContain("unknown flag --bogus");
    expect(calls).toHaveLength(0); // rejected before any fetch
  });
});
