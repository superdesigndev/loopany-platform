/**
 * `adscaile skill {status,install}` — a thin verb wrapping the same best-effort
 * install path `adscaile up` / `adscaile new` run. The manual escape hatch: lets a
 * user (re)install the adscaile agent skill on demand, or check where it's installed.
 *
 * User (global) scope is THE scope now — your coding agent(s) discover it from any
 * workdir, matching the daemon's per-machine reach. Project scope is a rarely-needed
 * escape. The install targets EVERY agent in `SKILL_TARGET_AGENTS` (Claude Code +
 * Codex today), and `status` reports each one's location honestly.
 *
 *   adscaile skill              # same as `adscaile skill install`
 *   adscaile skill install      # install for each known agent at user scope (~/…)
 *   adscaile skill install -g   # same (accepted, redundant)
 *   adscaile skill install --project  # escape hatch: install under the cwd instead
 *   adscaile skill status       # report each agent's install location + bundle state
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundledSkillAvailable, installSkill, SKILL_TARGET_AGENTS } from "./skill-install.js";

/** The `adscaile` skill dir for one agent, under a scope root. */
function skillDirFor(root: string, skillsRoot: readonly string[]): string {
  return path.join(root, ...skillsRoot, "adscaile");
}

function isInstalledAt(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

export async function runSkill(args: string[]): Promise<number> {
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : "install";
  // Global is the default; `--project` (or `--local`) is the only way to force cwd.
  // `-g`/`--global` stays accepted (now redundant) for muscle-memory / scripts.
  const project = args.includes("--project") || args.includes("--local");

  if (sub === "status") {
    process.stdout.write(`adscaile skill status:\n`);
    // One honest line per agent × scope (user + project), derived from the same
    // target list the installer uses, so the two surfaces cannot drift.
    for (const t of SKILL_TARGET_AGENTS) {
      const userDir = skillDirFor(os.homedir(), t.skillsRoot);
      const projectDir = skillDirFor(process.cwd(), t.skillsRoot);
      process.stdout.write(`  ${t.label} user (${userDir}): ${isInstalledAt(userDir) ? "installed" : "not installed"}\n`);
      process.stdout.write(`  ${t.label} project (${projectDir}): ${isInstalledAt(projectDir) ? "installed (would shadow user scope)" : "not installed"}\n`);
    }
    process.stdout.write(`  bundled source: ${bundledSkillAvailable() ? "available" : "missing"}\n`);
    return 0;
  }

  if (sub === "install") {
    // Default (global) ignores cwd; --project targets the current directory.
    const r = await installSkill(project ? { cwd: process.cwd() } : { global: true });
    process.stdout.write(r.line + "\n");
    return r.ok ? 0 : 1;
  }

  process.stderr.write("adscaile: usage: adscaile skill [status|install] [--project]\n");
  return 2;
}
