/**
 * The best-effort `npx skills` install path, exercised with the runner INJECTED so
 * nothing spawns npx or touches the network. Covers the exact argv (verified
 * against the current `skills` CLI), project-vs-global scope, idempotent-overwrite
 * success, and the never-throws fallback on every failure mode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import {
  installArgs,
  installSkill,
  bundledSkillAvailable,
  SKILL_TARGET_AGENTS,
  targetSkillDirs,
  type Runner,
} from "./skill-install.js";

// A throwaway bundled-skill dir so the presence check passes without a real build.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "adscaile-skill-"));
fs.writeFileSync(path.join(fixtureDir, "SKILL.md"), "---\nname: adscaile\n---\n# x\n");

afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

const ok: Runner = async () => ({ code: 0, stdout: "installed", stderr: "" });

describe("installArgs", () => {
  test("project scope (default) — verified multi-agent invocation", () => {
    // Repeated `-a <id>` flags, one per known agent (the comma form `-a a,b` is
    // rejected by the `skills` CLI as a single bogus agent name).
    expect(installArgs("/b/skill")).toEqual([
      "--yes", "skills", "add", "/b/skill", "-a", "claude-code", "-a", "codex", "-y", "--copy",
    ]);
  });

  test("global appends -g", () => {
    expect(installArgs("/b/skill", true)).toEqual([
      "--yes", "skills", "add", "/b/skill", "-a", "claude-code", "-a", "codex", "-y", "--copy", "-g",
    ]);
  });

  test("targets exactly the two CodingAgent values, never `-a '*'`", () => {
    const args = installArgs("/b/skill");
    expect(SKILL_TARGET_AGENTS.map((t) => t.id)).toEqual(["claude-code", "codex"]);
    // one `-a` per agent, and the litter-everything wildcard never appears
    expect(args.filter((a) => a === "-a")).toHaveLength(SKILL_TARGET_AGENTS.length);
    expect(args).not.toContain("*");
  });
});

describe("targetSkillDirs", () => {
  test("global → each agent's ~ skill dir", () => {
    expect(targetSkillDirs({ global: true })).toEqual([
      "~/.claude/skills/adscaile",
      "~/.agents/skills/adscaile",
    ]);
  });

  test("project cwd → each agent's dir under the cwd", () => {
    expect(targetSkillDirs({ cwd: "/loops/cookie" })).toEqual([
      path.join("/loops/cookie", ".claude/skills/adscaile"),
      path.join("/loops/cookie", ".agents/skills/adscaile"),
    ]);
  });

  test("default (no cwd) → cwd-relative, keeps the ./ prefix", () => {
    expect(targetSkillDirs()).toEqual([
      "./.claude/skills/adscaile",
      "./.agents/skills/adscaile",
    ]);
  });
});

describe("installSkill", () => {
  test("success → ok + project location line", async () => {
    let seen: string[] = [];
    const runner: Runner = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(true);
    expect(r.line).toContain("./.claude/skills/adscaile"); // Claude Code
    expect(r.line).toContain("./.agents/skills/adscaile"); // Codex
    expect(seen).toEqual(installArgs(fixtureDir, false));
  });

  test("global → ~/.claude location line + -g passed", async () => {
    let seen: string[] = [];
    const runner: Runner = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: fixtureDir, global: true, runner });
    expect(r.ok).toBe(true);
    expect(r.line).toContain("~/.claude/skills/adscaile"); // Claude Code
    expect(r.line).toContain("~/.agents/skills/adscaile"); // Codex
    expect(seen).toContain("-g");
  });

  test("cwd → threaded into the runner + reflected in the install location line", async () => {
    let seenCwd: string | undefined = "UNSET";
    const runner: Runner = async (_cmd, _args, opts) => {
      seenCwd = opts?.cwd;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: fixtureDir, cwd: "/loops/cookie", runner });
    expect(r.ok).toBe(true);
    expect(seenCwd).toBe("/loops/cookie"); // the project install runs IN the loop workdir
    expect(r.line).toContain(path.join("/loops/cookie", ".claude/skills/adscaile"));
    expect(r.line).toContain(path.join("/loops/cookie", ".agents/skills/adscaile"));
  });

  test("global ignores cwd — targets ~/.claude and runs with no cwd", async () => {
    let seenCwd: string | undefined = "UNSET";
    const runner: Runner = async (_cmd, _args, opts) => {
      seenCwd = opts?.cwd;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: fixtureDir, cwd: "/loops/cookie", global: true, runner });
    expect(r.ok).toBe(true);
    expect(r.line).toContain("~/.claude/skills/adscaile");
    expect(seenCwd).toBeUndefined();
  });

  test("bundled skill absent → skipped, never runs the command", async () => {
    let ran = false;
    const runner: Runner = async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ dir: path.join(fixtureDir, "does-not-exist"), runner });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/bundled skill not found/);
    expect(ran).toBe(false);
  });

  test("non-zero exit → skipped with the reason, never throws", async () => {
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "EACCES: permission denied\nmore" });
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("EACCES: permission denied");
    expect(r.line).not.toContain("more"); // only the first stderr line
  });

  test("runner that throws is swallowed → skipped, never throws", async () => {
    const runner: Runner = async () => {
      throw new Error("spawn npx ENOENT");
    };
    const r = await installSkill({ dir: fixtureDir, runner });
    expect(r.ok).toBe(false);
    expect(r.line).toContain("spawn npx ENOENT");
  });

  test("fixture is detected as an available bundled skill", () => {
    expect(bundledSkillAvailable(fixtureDir)).toBe(true);
    expect(bundledSkillAvailable(path.join(fixtureDir, "nope"))).toBe(false);
  });

  // sanity: the default-runner success shape used elsewhere
  test("ok runner success", async () => {
    const r = await installSkill({ dir: fixtureDir, runner: ok });
    expect(r.ok).toBe(true);
  });
});
