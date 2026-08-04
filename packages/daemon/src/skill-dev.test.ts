/**
 * The `loopany-dev` skill — a SECOND, strictly separate distribution beside the
 * shipping `loopany` one.
 *
 * The whole point is separation, so that is what this pins: a different
 * front-matter name (which is the only thing the `skills` CLI keys on, and
 * therefore the only thing that keeps one install from landing on the other), a
 * different source directory, a different install target, and — because it
 * teaches a LOCAL dev stack — absence from the npm tarball.
 *
 * Nothing here spawns npx or touches a real skills directory: the installer's
 * runner is injected and every path assertion is on the computed target.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  bundledDevSkillDir,
  bundledSkillAvailable,
  bundledSkillDir,
  DEV_SKILL,
  installArgs,
  installSkill,
  PROD_SKILL,
  SKILL_TARGET_AGENTS,
  targetSkillDirs,
  type Runner,
} from "./skill-install.js";

// Vite statically rewrites a LITERAL `new URL('./x', import.meta.url)` into an
// asset URL, which fileURLToPath then rejects — keep the relative path in a
// variable (the repo-wide rule for source-reading guards).
const relRoot = "..";
const packageRoot = fileURLToPath(new URL(relRoot, import.meta.url));
const devSkillRoot = path.join(packageRoot, "skill-dev");

describe("the two skills are separate distributions", () => {
  test("distinct names, distinct source dirs", () => {
    expect(PROD_SKILL.name).toBe("loopany");
    expect(DEV_SKILL.name).toBe("loopany-dev");
    expect(DEV_SKILL.dir).not.toBe(PROD_SKILL.dir);
    expect(bundledDevSkillDir("/pkg/src")).toBe(path.join("/pkg", "skill-dev"));
    expect(bundledSkillDir("/pkg/src")).toBe(path.join("/pkg", "skill"));
  });

  test("installing the dev skill can never land on the prod one's directory", () => {
    const dev = targetSkillDirs({ global: true, skill: DEV_SKILL });
    const prod = targetSkillDirs({ global: true });
    expect(dev).toEqual(["~/.claude/skills/loopany-dev", "~/.agents/skills/loopany-dev"]);
    expect(prod).toEqual(["~/.claude/skills/loopany", "~/.agents/skills/loopany"]);
    expect(dev.some((d) => prod.includes(d))).toBe(false);
  });

  test("it reaches the same agents, by the same repeated `-a` invocation", () => {
    const args = installArgs("/repo/packages/daemon/skill-dev", true);
    expect(args).toEqual(["--yes", "skills", "add", "/repo/packages/daemon/skill-dev", "-a", "claude-code", "-a", "codex", "-y", "--copy", "-g"]);
    expect(args.filter((a) => a === "-a")).toHaveLength(SKILL_TARGET_AGENTS.length);
  });

  test("installSkill({skill: DEV_SKILL}) installs from skill-dev/ into the loopany-dev dirs", async () => {
    let seen: string[] = [];
    const runner: Runner = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installSkill({ skill: DEV_SKILL, global: true, runner });
    expect(r.ok).toBe(true);
    expect(seen).toContain(devSkillRoot);
    expect(r.line).toContain("loopany-dev");
    expect(r.line).toContain("~/.claude/skills/loopany-dev");
    // The status line names WHICH skill, so two installs are never confusable.
    expect(r.line.startsWith("loopany skill (loopany-dev):")).toBe(true);
  });

  test("a --project install targets the cwd, not the real user scope", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
    const r = await installSkill({ skill: DEV_SKILL, cwd: "/tmp/throwaway", runner });
    expect(r.line).toContain(path.join("/tmp/throwaway", ".claude/skills/loopany-dev"));
    expect(r.line).not.toContain(path.join("~", ".claude"));
  });
});

describe("the shipped artifact", () => {
  test("the source is committed in this repo and is a real skill", () => {
    expect(bundledSkillAvailable(devSkillRoot)).toBe(true);
  });

  test("its front matter declares the loopany-dev name — the separation is IN the file", () => {
    const skill = fs.readFileSync(path.join(devSkillRoot, "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name: loopany-dev$/m);
    expect(skill).toMatch(/^description: .+/m);
  });

  test("it teaches the kernel model, the artifact format and the run-now ruling", () => {
    const skill = fs.readFileSync(path.join(devSkillRoot, "SKILL.md"), "utf8");
    const loops = fs.readFileSync(path.join(devSkillRoot, "references", "loops.md"), "utf8");
    const work = fs.readFileSync(path.join(devSkillRoot, "references", "work.md"), "utf8");
    // event-sourced kernel objects
    expect(skill).toMatch(/event-sourced/i);
    expect(skill).toContain("loop retire");
    // the loop artifact format
    for (const key of ["title", "key", "cron", "workdir", "charter"]) expect(loops).toContain(key);
    expect(loops).toMatch(/Omitted ⇒ the loop has no cadence/);
    expect(loops).toMatch(/ABSOLUTE path that must already exist/);
    expect(loops).toContain("LOOPANY_ROOTS");
    // the grammar
    for (const verb of ["loop create", "loop list", "loop show", "loop evolve", "loop update", "loop run-now"]) {
      expect(loops + skill).toContain(verb);
    }
    for (const verb of ["task create", "task update", "task close", "doc create", "doc update", "loopany inbox", "loopany answer"]) {
      expect(work).toContain(verb);
    }
    // run-now + paused, post-rw14
    expect(loops).toContain("A PAUSED loop DOES fire, and stays paused");
    expect(loops).toMatch(/RETIRED loop is refused/);
  });

  test("it says, unmissably, that this CLI is for a local dev stack and never production", () => {
    const skill = fs.readFileSync(path.join(devSkillRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("Never production");
    expect(skill).toContain("scripts/loopany-dev");
    expect(skill).toContain("LOOPANY_RUNS_V2=1");
  });

  test("it NEVER ships in the npm tarball — it teaches a dev stack, not a user's machine", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("skill");
    expect(pkg.files).not.toContain("skill-dev");
  });

  test("the `loopany-dev` wrapper refuses a non-local server by construction", () => {
    const wrapper = fs.readFileSync(path.join(packageRoot, "..", "..", "scripts", "loopany-dev"), "utf8");
    expect(wrapper).toContain("refusing to run against");
    expect(wrapper).toContain("http://127.0.0.1:*");
    expect(wrapper).toContain("export LOOPANY_RUNS_V2=1");
    // The env script prints a banner; it must go to stderr or it corrupts the
    // CLI's machine-readable TOON on stdout.
    expect(wrapper).toContain("rewrite-local-run.env.sh\" 1>&2");
  });
});
