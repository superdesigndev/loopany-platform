/**
 * `loopany skill {status,install}` — a thin verb wrapping the same best-effort
 * install path `loopany new` runs at loop creation. The manual escape hatch: lets
 * a user (re)install the loopany agent skill on demand, anywhere, or check where
 * it's installed.
 *
 *   loopany skill              # same as `loopany skill install`
 *   loopany skill install      # install into ./.claude/skills/loopany (project, cwd)
 *   loopany skill install -g   # install into ~/.claude/skills/loopany (global)
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
  const global = args.includes("-g") || args.includes("--global");

  if (sub === "status") {
    const project = isInstalledAt(process.cwd());
    const home = isInstalledAt(os.homedir());
    process.stdout.write(`loopany skill status:\n`);
    process.stdout.write(`  project (${path.join(process.cwd(), ".claude/skills/loopany")}): ${project ? "installed" : "not installed"}\n`);
    process.stdout.write(`  global  (${path.join(os.homedir(), ".claude/skills/loopany")}): ${home ? "installed" : "not installed"}\n`);
    process.stdout.write(`  bundled source: ${bundledSkillAvailable() ? "available" : "missing"}\n`);
    return 0;
  }

  if (sub === "install") {
    const r = await installSkill({ global });
    process.stdout.write(r.line + "\n");
    return r.ok ? 0 : 1;
  }

  process.stderr.write("loopany: usage: loopany skill [status|install] [-g|--global]\n");
  return 2;
}
