/**
 * `loopany setup hooks` — SessionStart hook install (P7). Every filesystem touch is
 * injected via SetupDeps, so NO test reads/writes the real ~/.claude.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runSetup } from "./setup.js";

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
});
