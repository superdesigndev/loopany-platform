/**
 * Default profile SEEDING at `init`. A fresh workspace's `config.json` starts
 * with no `profiles`, so `tick --spawn` would leave every agent run pending
 * ("no profile for assignee"). To make the common case work out of the box, a
 * FRESH init probes PATH for the known coding-agent binaries and seeds a profile
 * for each one found, keyed by the agent name (which is the assignee name a loop
 * uses).
 *
 * The invocations mirror the production daemon's `runner.ts buildAgentSpawn`
 * (unattended BYOA one-shot form): claude on argv `-p`, codex `exec`, grok `-p`.
 * These are the launch shapes an unattended local run needs; a user is free to
 * hand-edit `config.json` afterward.
 *
 * Seeding runs ONLY when init CREATES the config (never on a re-init over an
 * existing one - that would clobber a user's hand-tuned profiles). PATH probing
 * is an INJECTABLE seam (`ProbeFn`) so a test never depends on what happens to
 * be installed on the machine running it.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Profile, Profiles } from "./spawn.js";

/** The agents we know how to launch, in a stable seed order. The KEY is both the
 *  PATH binary probed AND the assignee/profile name written. Flag sets mirror
 *  `daemon/src/runner.ts buildAgentSpawn`'s unattended one-shot form. */
const KNOWN_AGENTS: ReadonlyArray<{ name: string; profile: Profile }> = [
  {
    name: "claude",
    profile: { cmd: "claude", args: ["-p", "{{prompt}}", "--dangerously-skip-permissions"] },
  },
  {
    name: "codex",
    profile: {
      cmd: "codex",
      args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "{{prompt}}"],
    },
  },
  {
    name: "grok",
    profile: { cmd: "grok", args: ["-p", "{{prompt}}"] },
  },
];

/** Whether a binary is resolvable on PATH. Injected in tests so the seed is
 *  deterministic regardless of the host's installed agents. */
export type ProbeFn = (bin: string) => boolean;

/** The default PATH probe: is `bin` an executable file on any PATH entry? Windows
 *  PATHEXT is honored so `claude.cmd`/`.exe` resolve. Best-effort - any error is
 *  a "not found" (never throws). */
export const realProbe: ProbeFn = (bin: string): boolean => {
  const pathVar = process.env.PATH ?? "";
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, bin + ext), constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
};

/** Probe PATH and build the `profiles` block for every known agent found. The
 *  returned list of seeded NAMES lets the caller echo what happened (never silent
 *  magic). An empty map + empty list means no agent binary was on PATH. */
export function seedProfiles(probe: ProbeFn = realProbe): { profiles: Profiles; seeded: string[] } {
  const profiles: Record<string, Profile> = {};
  const seeded: string[] = [];
  for (const agent of KNOWN_AGENTS) {
    if (!probe(agent.name)) continue;
    profiles[agent.name] = agent.profile;
    seeded.push(agent.name);
  }
  return { profiles, seeded };
}
