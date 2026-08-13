import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const DAEMON_AGENT_PROFILES = ["claude", "codex", "grok"] as const;
export type DaemonAgentProfile = (typeof DAEMON_AGENT_PROFILES)[number];

const ENV_BIN: Record<DaemonAgentProfile, string> = {
  claude: "LOOPANY_CLAUDE_BIN",
  codex: "LOOPANY_CODEX_BIN",
  grok: "LOOPANY_GROK_BIN",
};

/** Resolve the same executable names runner.ts will spawn, without executing
 * third-party code. The result is public capability metadata only. */
export function detectAgentProfiles(env: NodeJS.ProcessEnv = process.env): DaemonAgentProfile[] {
  return DAEMON_AGENT_PROFILES.filter((profile) => executableExists(env[ENV_BIN[profile]] || profile, env));
}

function executableExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : (env.PATH || "").split(delimiter).filter(Boolean).flatMap((dir) => extensions.map((ext) => join(dir, command + ext)));
  return candidates.some((candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
}
