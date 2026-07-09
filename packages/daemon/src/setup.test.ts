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
  const codexPath = path.join("/home/u", ".codex", "hooks.json");
  const grokPath = path.join("/home/u", ".grok", "hooks", "loopany.json");
  return { deps, files, out: () => out.join(""), err: () => err.join(""), settingsPath, codexPath, grokPath };
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
    // Codex now has a concrete installer → its own SessionStart hook in ~/.codex/hooks.json.
    expect(f.out()).toContain("Codex,installed");
    const cx = sessionStart(f.files.get(f.codexPath)!);
    expect(cx).toHaveLength(1);
    expect(cx[0].hooks[0]).toEqual({ type: "command", command: "/home/u/.local/bin/loopany" });
    // The report tells the user about Codex's enable + trust prerequisites.
    expect(f.out()).toContain("hooks = true");
    expect(f.out()).toContain("trust the loopany hook");
    // Grok Build also has a concrete installer → ~/.grok/hooks/loopany.json (its own file).
    expect(f.out()).toContain("Grok Build,installed");
    const gk = sessionStart(f.files.get(f.grokPath)!);
    expect(gk).toHaveLength(1);
    expect(gk[0].hooks[0]).toEqual({ type: "command", command: "/home/u/.local/bin/loopany" });
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

// ---- Codex SessionStart installer (~/.codex/hooks.json) ------------------------
// Mirrors the Claude-hook tests: idempotent install, merge preserves the user's other
// hooks/events, and --remove uninstalls ONLY ours. Codex's hooks.json shares Claude's
// `{ hooks: { SessionStart: [...] } }` schema, so both flow through one merge routine.
describe("runSetup hooks — Codex (~/.codex/hooks.json)", () => {
  function codexSessionStart(f: ReturnType<typeof fakeFs>): any[] {
    return sessionStart(f.files.get(f.codexPath)!);
  }

  test("is idempotent: a second install does not duplicate the Codex entry (refreshes it)", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], f.deps);
    await runSetup(["hooks"], f.deps);
    expect(codexSessionStart(f)).toHaveLength(1);
    expect(f.out()).toContain("Codex,refreshed");
  });

  test("preserves the user's OTHER Codex hooks — other SessionStart entries AND other events", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "gh-axi", timeout: 10 }], matcher: "" }],
        Stop: [{ hooks: [{ type: "command", command: "/opt/notify.sh" }] }],
      },
    });
    const f = fakeFs({ [path.join("/home/u", ".codex", "hooks.json")]: existing });
    await runSetup(["hooks"], f.deps);
    const root = JSON.parse(f.files.get(f.codexPath)!);
    // Our entry was added alongside the pre-existing gh-axi SessionStart hook.
    expect(root.hooks.SessionStart).toHaveLength(2);
    expect(root.hooks.SessionStart.some((e: any) => e.hooks[0].command === "gh-axi")).toBe(true);
    expect(root.hooks.SessionStart.some((e: any) => e.hooks[0].command === "/home/u/.local/bin/loopany")).toBe(true);
    // The gh-axi entry kept its matcher/timeout, and the unrelated Stop event is untouched.
    expect(root.hooks.SessionStart.find((e: any) => e.hooks[0].command === "gh-axi").matcher).toBe("");
    expect(root.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "/opt/notify.sh" }] }]);
  });

  test("--remove uninstalls only our Codex entry, preserving the rest", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "gh-axi", timeout: 10 }], matcher: "" },
          { hooks: [{ type: "command", command: "/home/u/.local/bin/loopany" }] },
        ],
      },
    });
    const f = fakeFs({ [path.join("/home/u", ".codex", "hooks.json")]: existing });
    expect(await runSetup(["hooks", "--remove"], f.deps)).toBe(0);
    const cx = codexSessionStart(f);
    expect(cx).toHaveLength(1);
    expect(cx[0].hooks[0].command).toBe("gh-axi");
    expect(f.out()).toContain("Codex,removed");
  });

  test("--remove drops an empty SessionStart key but keeps other events", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/home/u/.local/bin/loopany" }] }],
        Stop: [{ hooks: [{ type: "command", command: "/opt/notify.sh" }] }],
      },
    });
    const f = fakeFs({ [path.join("/home/u", ".codex", "hooks.json")]: existing });
    await runSetup(["hooks", "--remove"], f.deps);
    const root = JSON.parse(f.files.get(f.codexPath)!);
    expect(root.hooks.SessionStart).toBeUndefined();
    expect(root.hooks.Stop).toBeDefined();
    expect(f.out()).toContain("Codex,removed");
  });

  test("--remove on a clean Codex config reports `not installed`", async () => {
    const f = fakeFs();
    await runSetup(["hooks", "--remove"], f.deps);
    expect(f.out()).toContain("Codex,not installed");
    // The remove report omits the enable/trust note (it's install-only guidance).
    expect(f.out()).not.toContain("hooks = true");
  });

  test("an unparseable Codex hooks.json is treated as fresh (only SessionStart is touched)", async () => {
    const f = fakeFs({ [path.join("/home/u", ".codex", "hooks.json")]: "{not json" });
    expect(await runSetup(["hooks"], f.deps)).toBe(0);
    expect(codexSessionStart(f)).toHaveLength(1);
  });
});

// ---- Grok SessionStart installer (~/.grok/hooks/loopany.json) ------------------
// Mirrors the Claude/Codex hook tests: idempotent install, merge preserves anything
// already in our file, and --remove uninstalls it. Grok's global hooks live one-file-
// per-tool and are ALWAYS trusted — no enable/trust gate — so no such note is expected.
describe("runSetup hooks — Grok Build (~/.grok/hooks/loopany.json)", () => {
  function grokSessionStart(f: ReturnType<typeof fakeFs>): any[] {
    return sessionStart(f.files.get(f.grokPath)!);
  }

  test("installs a SessionStart hook into a fresh ~/.grok/hooks/loopany.json", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], f.deps);
    const gk = grokSessionStart(f);
    expect(gk).toHaveLength(1);
    expect(gk[0].hooks[0]).toEqual({ type: "command", command: "/home/u/.local/bin/loopany" });
    expect(f.out()).toContain("Grok Build,installed");
  });

  test("is idempotent: a second install refreshes rather than duplicates", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], f.deps);
    await runSetup(["hooks"], f.deps);
    expect(grokSessionStart(f)).toHaveLength(1);
    expect(f.out()).toContain("Grok Build,refreshed");
  });

  test("--remove uninstalls only our Grok entry, reporting `removed`", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "orca-status" }] },
          { hooks: [{ type: "command", command: "/home/u/.local/bin/loopany" }] },
        ],
      },
    });
    const f = fakeFs({ [path.join("/home/u", ".grok", "hooks", "loopany.json")]: existing });
    expect(await runSetup(["hooks", "--remove"], f.deps)).toBe(0);
    const gk = grokSessionStart(f);
    expect(gk).toHaveLength(1);
    expect(gk[0].hooks[0].command).toBe("orca-status");
    expect(f.out()).toContain("Grok Build,removed");
  });

  test("--remove on a clean Grok config reports `not installed`", async () => {
    const f = fakeFs();
    await runSetup(["hooks", "--remove"], f.deps);
    expect(f.out()).toContain("Grok Build,not installed");
  });

  test("Grok needs NO enable/trust note — global hooks are always trusted (unlike Codex)", async () => {
    const f = fakeFs();
    await runSetup(["hooks"], f.deps);
    // The only enable/trust guidance in the report is Codex's; no grok equivalent exists.
    expect(f.out()).not.toContain("~/.grok/config");
    expect(f.out()).not.toContain("trust the grok hook");
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

  test("surfaces Codex's enable/trust prerequisite on the automatic path too", async () => {
    const f = fakeFs();
    await refreshHooks({ ...f.deps, command: undefined, resolveCommand: () => "/opt/node/bin/loopany" });
    expect(f.out()).toContain("hooks = true");
    expect(f.out()).toContain("trusted on first session");
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
