/**
 * `loopany skill {status,install}` — a thin verb wrapping the same best-effort
 * install path `loopany up` / `loopany new` run. The manual escape hatch: lets a
 * user (re)install the loopany agent skill on demand, or check where it's installed.
 *
 * User (global) scope is THE scope now — Claude Code discovers it from any workdir,
 * matching the daemon's per-machine reach. Project scope is a rarely-needed escape.
 *
 *   loopany skill              # same as `loopany skill install`
 *   loopany skill install      # install into ~/.claude/skills/loopany (user/global)
 *   loopany skill install -g   # same (accepted, redundant)
 *   loopany skill install --project  # escape hatch: install into ./.claude/skills/loopany (cwd)
 *   loopany skill status       # report where the skill is installed + bundle state
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bundledSkillAvailable, installSkill } from "./skill-install.js";

function isInstalledAt(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".claude", "skills", "loopany", "SKILL.md")).isFile();
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
    const home = isInstalledAt(os.homedir());
    const local = isInstalledAt(process.cwd());
    process.stdout.write(`loopany skill status:\n`);
    process.stdout.write(`  user (${path.join(os.homedir(), ".claude/skills/loopany")}): ${home ? "installed" : "not installed"}\n`);
    process.stdout.write(`  project (${path.join(process.cwd(), ".claude/skills/loopany")}): ${local ? "installed (would shadow user scope)" : "not installed"}\n`);
    process.stdout.write(`  bundled source: ${bundledSkillAvailable() ? "available" : "missing"}\n`);
    return 0;
  }

  if (sub === "install") {
    // Default (global) ignores cwd; --project targets the current directory.
    const r = await installSkill(project ? { cwd: process.cwd() } : { global: true });
    process.stdout.write(r.line + "\n");
    return r.ok ? 0 : 1;
  }

  process.stderr.write("loopany: usage: loopany skill [status|install] [--project]\n");
  return 2;
}
