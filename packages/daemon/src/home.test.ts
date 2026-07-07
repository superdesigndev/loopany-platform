/**
 * Bare `loopany` OUT of a run — the content-first home (P8). The daemon is a text
 * sink: it posts local context to the server `home` verb and prints `body.text`. All
 * network/process touches are injected; nothing hits ~/.loopany or the network.
 */
import { describe, expect, test } from "vitest";

import { runHome, type HomeDeps } from "./home.js";

function stub(handler: (url: string, argv: string[]) => { ok: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; argv: string[] }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const argv: string[] = init?.body ? (JSON.parse(init.body).argv ?? []) : [];
    calls.push({ url: String(url), argv });
    const r = handler(String(url), argv);
    return { ok: r.ok, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function capture(extra: HomeDeps = {}) {
  let out = "";
  return {
    deps: {
      server: "https://srv.test",
      token: "dk_dev",
      cwd: () => "/work/here",
      homedir: () => "/home/u",
      localPid: () => 4821,
      binPath: () => "/home/u/.local/bin/loopany",
      serverDisplay: () => "https://srv.test",
      out: (s: string) => void (out += s),
      ...extra,
    } as HomeDeps,
    stdout: () => out,
  };
}

describe("runHome", () => {
  test("not connected (no credential/server) → the DEFINITIVE local not-connected home, exit 0, no fetch", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn, server: "", token: undefined });
    expect(await runHome(cap.deps)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(cap.stdout()).toContain("machine: not connected — run `loopany up`");
    expect(cap.stdout()).toContain("description:");
  });

  test("F7: the local not-connected home LEADS with `bin:` — the durable path when known", async () => {
    const { fetchFn } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn, server: "", token: undefined, binPath: () => "/home/u/.local/bin/loopany" });
    await runHome(cap.deps);
    expect(cap.stdout().split("\n")[0]).toBe("bin: /home/u/.local/bin/loopany");
  });

  test("F7: the local not-connected home LEADS with the honest bin fallback when non-durable (npx-without-global)", async () => {
    const { fetchFn } = stub(() => ({ ok: true, body: {} }));
    const cap = capture({ fetchImpl: fetchFn, server: "", token: undefined, binPath: () => null });
    await runHome(cap.deps);
    expect(cap.stdout().split("\n")[0]).toBe("bin: (not on PATH — run `npm i -g @crewlet/loopany`)");
  });

  test("posts `home` with the daemon-supplied context and prints the server `text` verbatim", async () => {
    const toon = "bin: /home/u/.local/bin/loopany\nmachine: online · daemon pid 4821 · https://srv.test\nloops[1]{name,cron,enabled,nextFire,lastOutcome}:\n  Docs Sweep,\"0 6 * * 1\",on,—,—";
    const { fetchFn, calls } = stub((url, argv) =>
      url.includes("/api/machine/cli") && argv[0] === "home"
        ? { ok: true, body: { ok: true, text: toon, exitCode: 0 } }
        : { ok: false, status: 404, body: {} },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runHome(cap.deps)).toBe(0);
    // The context the SERVER can't know is passed as flags on the home argv.
    expect(calls[0]!.argv).toEqual([
      "home",
      "--cwd", "/work/here",
      "--home", "/home/u",
      "--bin", "/home/u/.local/bin/loopany",
      "--pid", "4821",
      "--server", "https://srv.test",
    ]);
    expect(cap.stdout()).toBe(toon + "\n");
  });

  test("omits absent context (no bin/pid) and still posts cwd/home", async () => {
    const { fetchFn, calls } = stub(() => ({ ok: true, body: { text: "x", exitCode: 0 } }));
    const cap = capture({ fetchImpl: fetchFn, binPath: () => null, localPid: () => undefined, serverDisplay: () => "" });
    await runHome(cap.deps);
    expect(calls[0]!.argv).toEqual(["home", "--cwd", "/work/here", "--home", "/home/u"]);
  });

  test("hung/unreachable server (fetch rejects, e.g. a bounded-fetch timeout) → DEFINITIVE degraded home, exit 0", async () => {
    const fetchFn = (async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as unknown as typeof fetch;
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runHome(cap.deps)).toBe(0);
    expect(cap.stdout()).toContain("machine: configured");
    expect(cap.stdout()).toContain("server unreachable right now");
    expect(cap.stdout()).toContain("timeout");
    expect(cap.stdout()).not.toContain("code: ERROR");
  });

  test("older server (no `home` verb → 404) that STILL renders `text`: text-sinks the legacy endpoint's render", async () => {
    // A batch-1+ legacy `/api/machine/loop` GET renders `text`; the daemon prints it as a
    // degraded home over the 404→legacy path (Batch 7 removed the structured-render home).
    const legacyToon = "count: 1\nloops[1]{id,name,cron,enabled,nextFire}:\n  loop-1,Cookie,\"0 8 * * *\",on,—";
    const { fetchFn } = stub((url) =>
      url.includes("/api/machine/cli")
        ? { ok: false, status: 404, body: {} }
        : { ok: true, body: { ok: true, loops: [{ id: "loop-1" }], text: legacyToon } },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runHome(cap.deps)).toBe(0);
    expect(cap.stdout()).toBe(legacyToon + "\n");
  });

  test("too-old server (a `home`/loops reply with NO `text`): a DEFINITIVE 'server too old' home, exit 0, never alarming", async () => {
    // Batch 7: no structured-render fallback. The home stays never-empty/never-alarm on
    // the SessionStart hot path, so it renders a definitive too-old home (exit 0), not the
    // SERVER_TOO_OLD error other verbs print.
    const { fetchFn } = stub((url) =>
      url.includes("/api/machine/cli") ? { ok: false, status: 404, body: {} } : { ok: true, body: { loops: [{ id: "loop-1" }] } },
    );
    const cap = capture({ fetchImpl: fetchFn });
    expect(await runHome(cap.deps)).toBe(0);
    expect(cap.stdout()).toContain("server too old for this CLI");
    expect(cap.stdout()).toContain("update the Loopany server");
    expect(cap.stdout()).not.toContain("error:");
  });
});
