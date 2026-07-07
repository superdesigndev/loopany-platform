/**
 * `loopany setup hooks` — SessionStart hook install (P7). Every filesystem touch is
 * injected via SetupDeps, so NO test reads/writes the real ~/.claude.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveDurableCommand } from "./bin-shim.js";
import { refreshHooks, runSetup } from "./setup.js";

/** An in-memory settings file keyed by absolute path, backing the fs seams. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    readFile: (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    writeFile: (p: string, s: string) => void files.set(p, s),
    mkdir: () => {},
    homedir: () => "/home/u",
    command: "/home/u/.local/bin/loopany",
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
  };
  const settingsPath = path.join("/home/u", ".claude", "settings.json");
  return { deps, files, out: () => out.join(""), err: () => err.join(""), settingsPath };
}

function sessionStart(json: string): any[] {
  return (JSON.parse(json).hooks?.SessionStart ?? []) as any[];
}

describe("runSetup hooks", () => {
  test("installs a SessionStart command hook into a fresh ~/.claude/settings.json", async () => {
    const f = fakeFs();
    expect(await runSetup(["hooks"], f.deps)).toBe(0);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
    expect(ss[0].hooks[0]).toEqual({ type: "command", command: "/home/u/.local/bin/loopany" });
    expect(f.out()).toContain("integrations[");
    expect(f.out()).toContain("Claude Code,installed");
    // Codex has no session-hook installer yet → reported as skipped, not silently dropped.
    expect(f.out()).toContain("Codex,skipped");
  });

  test("is idempotent: a second install does not duplicate the entry (refreshes it)", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], f.deps);
    await runSetup(["hooks"], f.deps);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
    expect(f.out()).toContain("Claude Code,refreshed");
  });

  test("preserves OTHER SessionStart entries (only our loopany entry is managed)", async () => {
    const existing = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/opt/other-tool" }] }] },
    });
    const f = fakeFs({ [path.join("/home/u", ".claude", "settings.json")]: existing });
    await runSetup(["hooks"], f.deps);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(2);
    expect(ss.some((e) => e.hooks[0].command === "/opt/other-tool")).toBe(true);
    expect(ss.some((e) => e.hooks[0].command === "/home/u/.local/bin/loopany")).toBe(true);
  });

  test("--remove uninstalls our entry (and only ours), reporting `removed`", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "/opt/other-tool" }] },
          { hooks: [{ type: "command", command: "/home/u/.local/bin/loopany" }] },
        ],
      },
    });
    const f = fakeFs({ [path.join("/home/u", ".claude", "settings.json")]: existing });
    expect(await runSetup(["hooks", "--remove"], f.deps)).toBe(0);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
    expect(ss[0].hooks[0].command).toBe("/opt/other-tool");
    expect(f.out()).toContain("Claude Code,removed");
  });

  test("--remove on a clean settings reports `not installed` and writes nothing new", async () => {
    const f = fakeFs();
    await runSetup(["hooks", "--remove"], f.deps);
    expect(f.out()).toContain("Claude Code,not installed");
  });

  test("an unparseable settings.json is treated as fresh (we only touch SessionStart)", async () => {
    const f = fakeFs({ [path.join("/home/u", ".claude", "settings.json")]: "{not json" });
    expect(await runSetup(["hooks"], f.deps)).toBe(0);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
  });

  test("bare `loopany setup` prints what setup does + the hooks sub-action (exit 0)", async () => {
    const f = fakeFs();
    expect(await runSetup([], f.deps)).toBe(0);
    expect(f.out()).toContain("loopany setup hooks");
    expect(f.files.size).toBe(0); // nothing written
  });

  test("an unknown setup subcommand → exit 2", async () => {
    const f = fakeFs();
    expect(await runSetup(["bogus"], f.deps)).toBe(2);
    expect(f.err()).toContain("unknown setup command");
  });

  test("no durable `loopany`: the explicit verb still installs (bare) but warns", async () => {
    const f = fakeFs();
    // Drop the injected shim path so resolution runs; report no durable bin.
    const deps = { ...f.deps, command: undefined, resolveCommand: () => null };
    expect(await runSetup(["hooks"], deps)).toBe(0);
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
    expect(ss[0].hooks[0].command).toBe("loopany"); // bare fallback
    expect(f.err()).toContain("no durable `loopany` on PATH");
    expect(f.err()).toContain("npm i -g @crewlet/loopany");
  });
});

describe("refreshHooks (automatic up/update path)", () => {
  test("no durable `loopany` → installs NO hook and prints skip guidance", async () => {
    const f = fakeFs();
    await refreshHooks({ ...f.deps, command: undefined, resolveCommand: () => null });
    expect(f.files.size).toBe(0); // never wrote a settings.json
    expect(f.out()).toContain("skipped the SessionStart hook");
    expect(f.out()).toContain("npm i -g @crewlet/loopany");
  });

  test("durable `loopany` → installs the hook with the resolved command", async () => {
    const f = fakeFs();
    await refreshHooks({ ...f.deps, command: undefined, resolveCommand: () => "/opt/node/bin/loopany" });
    const ss = sessionStart(f.files.get(f.settingsPath)!);
    expect(ss).toHaveLength(1);
    expect(ss[0].hooks[0].command).toBe("/opt/node/bin/loopany");
    expect(f.out()).toContain("SessionStart home view");
  });
});

// ---- F6: hook-gating parity via the REAL resolveDurableCommand -----------------
// The automatic (`refreshHooks`) and explicit (`runSetup(["hooks"])`) paths BOTH derive
// the hook command from the same `resolveDurableCommand`. The E2E bug: `npx …` PREPENDS
// its throwaway `…/_npx/…/.bin` onto PATH, so the durability probe saw a `loopany` there
// and wrongly concluded "durable" — the bin shim was skipped (ephemeral, correct) while
// the bin-dependent hook installed anyway. These pin that the two paths now AGREE.
describe("F6: hook-gating parity — the npx-ephemeral case gates BOTH paths", () => {
  // `resolveDurableCommand` wired to an npx-only PATH (the exact E2E scenario): the only
  // `loopany` lives in an ephemeral `/_npx/` bin dir, and there is no durable shim.
  const npxBin = "/home/u/.npm/_npx/abc123/node_modules/.bin";
  const ephemeralResolve = () =>
    resolveDurableCommand({ env: { PATH: npxBin }, homedir: () => "/home/u", exists: (p) => p === path.join(npxBin, "loopany") });

  test("resolveDurableCommand treats the npx-only PATH as NOT durable (null)", () => {
    expect(ephemeralResolve()).toBeNull();
  });

  test("the AUTOMATIC path skips the hook (no settings.json written) — matches the skipped bin shim", async () => {
    const f = fakeFs();
    await refreshHooks({ ...f.deps, command: undefined, resolveCommand: ephemeralResolve });
    expect(f.files.size).toBe(0);
    expect(f.out()).toContain("skipped the SessionStart hook");
  });

  test("the EXPLICIT path installs (user asked) but WARNS before the bare fallback — parity of decision", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], { ...f.deps, command: undefined, resolveCommand: ephemeralResolve });
    // Explicit verb honors the ask (bare fallback) but never silently — it warns.
    expect(f.err()).toContain("no durable `loopany` on PATH");
    expect(sessionStart(f.files.get(f.settingsPath)!)[0].hooks[0].command).toBe("loopany");
  });

  test("a DURABLE global on a real PATH gates BOTH paths ON (parity in the healthy case)", async () => {
    const realResolve = () =>
      resolveDurableCommand({ env: { PATH: "/usr/local/bin" }, homedir: () => "/home/u", exists: (p) => p === "/usr/local/bin/loopany" });
    expect(realResolve()).toBe("/usr/local/bin/loopany");
    const auto = fakeFs();
    await refreshHooks({ ...auto.deps, command: undefined, resolveCommand: realResolve });
    expect(sessionStart(auto.files.get(auto.settingsPath)!)[0].hooks[0].command).toBe("/usr/local/bin/loopany");
    const explicit = fakeFs();
    await runSetup(["hooks"], { ...explicit.deps, command: undefined, resolveCommand: realResolve });
    expect(explicit.err()).toBe(""); // no warning — it IS durable
    expect(sessionStart(explicit.files.get(explicit.settingsPath)!)[0].hooks[0].command).toBe("/usr/local/bin/loopany");
  });
});
