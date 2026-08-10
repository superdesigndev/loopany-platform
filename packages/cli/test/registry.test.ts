/**
 * The workspace REGISTRY - the bridge the resident daemon reads to auto-tick
 * local kernels. These drive registry.ts + seedProfiles.ts directly, plus the
 * `init`/`register`/`unregister` verbs through `run(argv, deps)`, all against an
 * injected `registryHome` (never the real ~/.loopany) and an injected PATH probe
 * (never the host's installed agents).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRegistry,
  registerWorkspace,
  registryPath,
  seedProfiles,
  unregisterWorkspace,
  type CliDeps,
  type CliOutcome,
  run,
} from "../src/index.js";

describe("registry (read/register/unregister)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "loopany-reg-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("a missing file reads as an empty list (never throws)", () => {
    expect(readRegistry({ home })).toEqual([]);
  });

  it("corrupt bytes / non-array / bad shape all read as empty (tolerant)", () => {
    const path = registryPath({ home });
    // Ensure the dir exists via a first register, then corrupt the file.
    registerWorkspace({ dir: "/tmp/a", bin: "/b" }, { home });
    for (const junk of ["not json", "{}", '"a string"', "[1,2,3]", '[{"dir":123}]']) {
      writeFileSync(path, junk);
      expect(readRegistry({ home })).toEqual([]);
    }
  });

  it("register writes an entry and read returns it (resolved dir)", () => {
    registerWorkspace({ dir: "/repo/one", bin: "/bin/loopany-kernel.mjs" }, { home });
    expect(readRegistry({ home })).toEqual([{ dir: "/repo/one", bin: "/bin/loopany-kernel.mjs" }]);
  });

  it("register DEDUPES by resolved dir (a re-register replaces, never appends)", () => {
    registerWorkspace({ dir: "/repo/one", bin: "/old/bin.mjs" }, { home });
    registerWorkspace({ dir: "/repo/two", bin: "/bin.mjs" }, { home });
    // Re-register /repo/one with a NEW bin (e.g. a global install after a dev run).
    const after = registerWorkspace({ dir: "/repo/one/", bin: "/new/bin.mjs" }, { home });
    const dirs = after.map((e) => e.dir).sort();
    expect(dirs).toEqual(["/repo/one", "/repo/two"]);
    expect(after.find((e) => e.dir === "/repo/one")?.bin).toBe("/new/bin.mjs");
  });

  it("the file is valid JSON on disk (atomic write leaves no temp)", () => {
    registerWorkspace({ dir: "/repo/one", bin: "/b.mjs" }, { home });
    const parsed = JSON.parse(readFileSync(registryPath({ home }), "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("unregister removes a dir and reports removed; unknown dir is a no-op", () => {
    registerWorkspace({ dir: "/repo/one", bin: "/b.mjs" }, { home });
    registerWorkspace({ dir: "/repo/two", bin: "/b.mjs" }, { home });
    const gone = unregisterWorkspace("/repo/one", { home });
    expect(gone.removed).toBe(true);
    expect(readRegistry({ home }).map((e) => e.dir)).toEqual(["/repo/two"]);

    const noop = unregisterWorkspace("/repo/absent", { home });
    expect(noop.removed).toBe(false);
    expect(readRegistry({ home }).map((e) => e.dir)).toEqual(["/repo/two"]);
  });
});

describe("seedProfiles (PATH probe seam)", () => {
  it("seeds a profile for every agent the probe finds, keyed + ordered by name", () => {
    const found = new Set(["claude", "grok"]);
    const { profiles, seeded } = seedProfiles((bin) => found.has(bin));
    expect(seeded).toEqual(["claude", "grok"]); // stable KNOWN_AGENTS order
    expect(profiles.claude?.cmd).toBe("claude");
    expect(profiles.claude?.args).toContain("{{prompt}}");
    expect(profiles.grok?.cmd).toBe("grok");
    expect(profiles.codex).toBeUndefined();
  });

  it("no agents on PATH ⇒ empty map + empty list (never throws)", () => {
    const { profiles, seeded } = seedProfiles(() => false);
    expect(profiles).toEqual({});
    expect(seeded).toEqual([]);
  });

  it("the codex profile mirrors the daemon's unattended exec form", () => {
    const { profiles } = seedProfiles((bin) => bin === "codex");
    expect(profiles.codex?.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "{{prompt}}",
    ]);
  });
});

describe("init/register/unregister verbs (through run)", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-init-reg-"));
    home = mkdtempSync(join(tmpdir(), "loopany-init-home-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const deps = (over?: Partial<CliDeps>): CliDeps => ({
    cwd: dir,
    now: "2026-08-10T12:00:00.000Z",
    env: {},
    registryHome: home,
    binPath: "/fake/bin/loopany-kernel.mjs",
    probe: () => false,
    ...over,
  });
  const call = (argv: string[], over?: Partial<CliDeps>): CliOutcome => {
    const out = run(argv, deps(over));
    if (out.exitCode !== 0) throw new Error(`\`${argv.join(" ")}\` exited ${out.exitCode}: ${out.stderr}`);
    return out;
  };

  it("init auto-registers the workspace with the recorded bin", () => {
    call(["init"]);
    const entries = readRegistry({ home });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.dir).toBe(dir);
    expect(entries[0]?.bin).toBe("/fake/bin/loopany-kernel.mjs");
  });

  it("init --no-register skips registration but still seeds profiles", () => {
    const out = call(["init", "--no-register"], { probe: (bin) => bin === "claude" });
    expect(out.stdout).toContain("registry: skipped (--no-register)");
    expect(out.stdout).toContain("profiles seeded: claude");
    // The registry is untouched.
    expect(readRegistry({ home })).toEqual([]);
    // But the workspace config (with profiles) was still written.
    const cfg = JSON.parse(readFileSync(join(dir, ".loopany", "config.json"), "utf8"));
    expect(cfg.profiles.claude.cmd).toBe("claude");
  });

  it("init --no-register --json reports registered:false + registerSkipped", () => {
    const out = call(["init", "--no-register", "--json"], { probe: () => false });
    const body = JSON.parse(out.stdout) as { registered: boolean; registerSkipped?: boolean };
    expect(body.registered).toBe(false);
    expect(body.registerSkipped).toBe(true);
    expect(readRegistry({ home })).toEqual([]);
  });

  it("init seeds profiles from the probe and echoes what was seeded", () => {
    const out = call(["init"], { probe: (bin) => bin === "claude" });
    expect(out.stdout).toContain("profiles seeded: claude");
    const cfg = JSON.parse(readFileSync(join(dir, ".loopany", "config.json"), "utf8"));
    expect(cfg.profiles.claude.cmd).toBe("claude");
  });

  it("init with no agents on PATH says so (never silent)", () => {
    const out = call(["init"]);
    expect(out.stdout).toContain("profiles seeded: none (no agent binaries found on PATH)");
    const cfg = JSON.parse(readFileSync(join(dir, ".loopany", "config.json"), "utf8"));
    expect(cfg.profiles).toBeUndefined();
  });

  it("re-init NEVER clobbers existing profiles (seed is create-only)", () => {
    call(["init"], { probe: (bin) => bin === "claude" });
    // Second init over the same workspace with a DIFFERENT probe result.
    const out = call(["init"], { probe: (bin) => bin === "codex" });
    expect(out.stdout).toContain("already initialized");
    // The original claude profile survives; no codex was seeded on top.
    const cfg = JSON.parse(readFileSync(join(dir, ".loopany", "config.json"), "utf8"));
    expect(cfg.profiles.claude.cmd).toBe("claude");
    expect(cfg.profiles.codex).toBeUndefined();
  });

  it("init --json reports registered + profilesSeeded", () => {
    const out = call(["init", "--json"], { probe: (bin) => bin === "grok" });
    const body = JSON.parse(out.stdout) as { registered: boolean; profilesSeeded: string[] };
    expect(body.registered).toBe(true);
    expect(body.profilesSeeded).toEqual(["grok"]);
  });

  it("register records the REPO ROOT (parent of .loopany), not the .loopany dir", () => {
    call(["init"]);
    // Drop the registry, then re-register explicitly.
    unregisterWorkspace(dir, { home });
    expect(readRegistry({ home })).toEqual([]);
    const out = call(["register"]);
    expect(out.stdout).toContain(dir);
    expect(readRegistry({ home })).toEqual([
      { dir, bin: "/fake/bin/loopany-kernel.mjs" },
    ]);
  });

  it("unregister drops the workspace; a second unregister is a clean no-op", () => {
    call(["init"]);
    const first = call(["unregister"]);
    expect(first.stdout).toContain("unregistered");
    expect(readRegistry({ home })).toEqual([]);
    const second = call(["unregister"]);
    expect(second.stdout).toContain("was not registered");
  });

  it("register outside a workspace is a NO_WORKSPACE usage/driver error", () => {
    const out = run(["register"], deps({ cwd: home })); // home has no .loopany
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("NO_WORKSPACE");
  });
});
