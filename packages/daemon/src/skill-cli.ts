/**
 * `loopany skill {status,install}` — a thin verb wrapping the same best-effort
 * install path `loopany up` / `loopany new` run. The manual escape hatch: lets a
 * user (re)install the loopany agent skill on demand, or check where it's installed.
 *
 * User (global) scope is THE scope now — your coding agent(s) discover it from any
 * workdir, matching the daemon's per-machine reach. Project scope is a rarely-needed
 * escape. The install targets EVERY agent in `SKILL_TARGET_AGENTS` (Claude Code +
 * Codex today), and `status` reports each one's location honestly.
 *
 *   loopany skill              # same as `loopany skill install`
 *   loopany skill install      # install for each known agent at user scope (~/…)
 *   loopany skill install -g   # same (accepted, redundant)
 *   loopany skill install --project  # escape hatch: install under the cwd instead
 *   loopany skill install --dev      # install the SEPARATE `loopany-dev` skill
 *   loopany skill status       # report each agent's install location + bundle state
 *
 * `--dev` selects the rewrite line's `loopany-dev` skill (`skill-dev/` in this
 * repo). It is a DIFFERENT distribution, not a variant: a different front-matter
 * name means a different install directory, so installing it can never overwrite,
 * edit or shadow the production `loopany` skill — the two sit side by side and an
 * agent picks by name. `status` reports both, so "which one is on this machine?"
 * is answerable without guessing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundledSkillAvailable, bundledDevSkillDir, DEV_SKILL, installSkill, PROD_SKILL, SKILL_TARGET_AGENTS, type SkillPackage } from "./skill-install.js";

/** One skill's dir for one agent, under a scope root. */
function skillDirFor(root: string, skillsRoot: readonly string[], name: string): string {
  return path.join(root, ...skillsRoot, name);
}

function isInstalledAt(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/** Both distributions, reported together — `loopany-dev` exists precisely so the
 *  two can coexist, so status that showed one would answer half the question. */
const SKILLS: readonly SkillPackage[] = [PROD_SKILL, DEV_SKILL];

export async function runSkill(args: string[]): Promise<number> {
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "install";
  // Global is the default; `--project` (or `--local`) is the only way to force cwd.
  // `-g`/`--global` stays accepted (now redundant) for muscle-memory / scripts.
  const project = args.includes("--project") || args.includes("--local");
  const dev = args.includes("--dev");

  if (sub === "status") {
    process.stdout.write(`loopany skill status:\n`);
    // One honest line per skill × agent × scope (user + project), derived from the
    // same target list the installer uses, so the two surfaces cannot drift.
    for (const skill of SKILLS) {
      for (const t of SKILL_TARGET_AGENTS) {
        const userDir = skillDirFor(os.homedir(), t.skillsRoot, skill.name);
        const projectDir = skillDirFor(process.cwd(), t.skillsRoot, skill.name);
        const label = skill === PROD_SKILL ? t.label : `${t.label} [${skill.name}]`;
        process.stdout.write(`  ${label} user (${userDir}): ${isInstalledAt(userDir) ? "installed" : "not installed"}\n`);
        process.stdout.write(`  ${label} project (${projectDir}): ${isInstalledAt(projectDir) ? "installed (would shadow user scope)" : "not installed"}\n`);
      }
    }
    process.stdout.write(`  bundled source: ${bundledSkillAvailable() ? "available" : "missing"}\n`);
    process.stdout.write(`  bundled source [${DEV_SKILL.name}]: ${bundledSkillAvailable(bundledDevSkillDir()) ? "available" : "missing"}\n`);
    return 0;
  }

  if (sub === "install") {
    // Default (global) ignores cwd; --project targets the current directory.
    const r = await installSkill({
      ...(dev ? { skill: DEV_SKILL } : {}),
      ...(project ? { cwd: process.cwd() } : { global: true }),
    });
    process.stdout.write(r.line + "\n");
    return r.ok ? 0 : 1;
  }

  process.stderr.write("loopany: usage: loopany skill [status|install] [--project] [--dev]\n");
  return 2;
}
