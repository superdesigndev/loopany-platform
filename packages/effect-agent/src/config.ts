/**
 * The effect agent's configuration - and, with it, most of the safety story.
 *
 * This process holds real GitHub credentials (whatever `gh` is logged in as), so
 * the questions "which repositories may it touch?" and "may it merge into a
 * default branch?" are answered HERE, on the machine, and not by the server that
 * sent the work order. That is the whole point of splitting the two: a server bug
 * - or a tampered directive row - cannot widen what this agent is willing to do,
 * because the boundary is read from this machine's environment.
 *
 * ── every guard FAILS CLOSED ────────────────────────────────────────────────
 *
 * An UNSET allowlist allows NOTHING. Not "everything", which is the tempting
 * default and the one that turns a demo into an incident. Merging into a repo's
 * DEFAULT BRANCH additionally requires its own explicit flag on top of the
 * allowlist, because "I allowlisted the repo so I could try a scratch merge" and
 * "I meant for this to be able to land on main" are different intentions and must
 * be expressed differently.
 *
 * Nothing here is ever committed. `LOOPANY_EFFECT_AGENT_TOKEN` is a shared secret
 * with the server; the GitHub credential is `gh`'s own and this process never
 * reads, logs or forwards it.
 */

export interface AgentConfig {
  /** Base URL of the Loopany server holding the directive channel. */
  serverUrl: string;
  /** The shared secret for `/api/effects/*`. */
  token: string;
  /** This agent instance's id - recorded as the claim holder. */
  agent: string;
  /** The machine name, matched against a directive's `targetMachine`. */
  machine?: string;
  /** Graph team to poll for. */
  teamId?: string;
  pollMs: number;
  /** Repos this agent may act on, `owner/name`, lower-cased. EMPTY = none. */
  allowedRepos: Set<string>;
  /** May a merge target the repo's DEFAULT branch? Off unless explicitly on. */
  allowDefaultBranch: boolean;
  /** Refuse every `github-merge` outright, whatever the allowlist says - the
   *  comment-only posture, useful for a machine that should never land code. */
  commentOnly: boolean;
}

export const DEFAULT_POLL_MS = 3_000;

class ConfigError extends Error {}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

function flag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

/** `owner/name, owner/other` → a lower-cased set. Anything that is not an
 *  `owner/name` pair is DROPPED rather than half-matched: an allowlist entry the
 *  agent cannot interpret must never widen what it permits. */
export function parseRepoAllowlist(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const v = piece.trim().toLowerCase();
    if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v)) out.add(v);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const pollRaw = Number(env.LOOPANY_EFFECT_POLL_MS?.trim());
  return {
    serverUrl: (env.LOOPANY_EFFECT_SERVER_URL?.trim() || req("LOOPANY_EFFECT_SERVER_URL")).replace(/\/+$/, ""),
    token: env.LOOPANY_EFFECT_AGENT_TOKEN?.trim() || req("LOOPANY_EFFECT_AGENT_TOKEN"),
    agent: env.LOOPANY_EFFECT_AGENT_ID?.trim() || `effect-agent-${process.pid}`,
    ...(env.LOOPANY_EFFECT_MACHINE?.trim() ? { machine: env.LOOPANY_EFFECT_MACHINE.trim() } : {}),
    ...(env.LOOPANY_EFFECT_TEAM?.trim() ? { teamId: env.LOOPANY_EFFECT_TEAM.trim() } : {}),
    pollMs: Number.isFinite(pollRaw) && pollRaw >= 500 ? Math.floor(pollRaw) : DEFAULT_POLL_MS,
    allowedRepos: parseRepoAllowlist(env.LOOPANY_EFFECT_ALLOWED_REPOS),
    allowDefaultBranch: flag("LOOPANY_EFFECT_ALLOW_DEFAULT_BRANCH"),
    commentOnly: flag("LOOPANY_EFFECT_COMMENT_ONLY"),
  };
}

/** One line describing the posture this agent is running with. Printed at start,
 *  because "what was it allowed to do?" should never require reading the env of a
 *  process that has since exited. */
export function describeConfig(c: AgentConfig): string {
  const repos = c.allowedRepos.size ? [...c.allowedRepos].sort().join(", ") : "(none - every effect will refuse)";
  return [
    `server        ${c.serverUrl}`,
    `agent         ${c.agent}${c.machine ? ` on ${c.machine}` : ""}`,
    `poll          ${c.pollMs}ms`,
    `repos         ${repos}`,
    `merge         ${c.commentOnly ? "DISABLED (comment-only)" : "allowed on allowlisted repos"}`,
    `default base  ${c.allowDefaultBranch ? "ALLOWED" : "refused"}`,
  ].join("\n  ");
}
