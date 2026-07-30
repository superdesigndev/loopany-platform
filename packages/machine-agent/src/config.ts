/**
 * The machine agent's configuration - and, with it, most of the safety story.
 *
 * This process holds the real credentials: whatever `gh` is logged in as, and
 * whatever the instruction executor can reach. So the questions "which
 * repositories may it touch?", "may it merge into a default branch?", "what may it
 * execute, and where?" are answered HERE, on the machine, and not by the server
 * that sent the work order. That is the whole point of splitting the two: a server
 * bug - or a tampered directive row - cannot widen what this agent is willing to
 * do, because the boundary is read from this machine's environment.
 *
 * ── every guard FAILS CLOSED ────────────────────────────────────────────────
 *
 * An UNSET allowlist allows NOTHING. Not "everything", which is the tempting
 * default and the one that turns a demo into an incident. The same inversion runs
 * through all of it: no repo allowlist ⇒ no GitHub effect; no executor configured ⇒
 * no run; no run root ⇒ no run. Merging into a repo's DEFAULT BRANCH additionally
 * requires its own explicit flag on top of the allowlist, because "I allowlisted the
 * repo so I could try a scratch merge" and "I meant for this to be able to land on
 * main" are different intentions and must be expressed differently.
 *
 * Nothing here is ever committed. `LOOPANY_AGENT_TOKEN` is a shared secret with the
 * server; the GitHub credential is `gh`'s own and this process never reads, logs or
 * forwards it.
 */

/** How an instruction work order is executed on this machine. */
export interface RunConfig {
  /**
   * The EXECUTOR: the binary that receives an instruction on stdin and carries it
   * out. In production this is a coding agent (`claude`, `codex`, …); in a demo or a
   * probe it is a bounded script. EMPTY means this machine executes no instructions
   * at all, which is the fail-closed default.
   *
   * Captain decision 12 makes agent execution the DEFAULT path for external
   * effects, and this is the seam that makes that true: one executor, any
   * instruction, no per-action code.
   */
  command?: string;
  /** Fixed arguments prepended to every invocation (`-p`, `exec`, a script path). */
  args: string[];
  /**
   * The JAIL. Every run's working directory resolves inside this absolute path, and
   * a work order asking for anything outside it is refused. EMPTY means no run may
   * execute - a run with nowhere safe to run has nowhere to run.
   */
  root?: string;
  /** Ceiling on a work order's declared timeout. */
  maxTimeoutMs: number;
  /** Captured output kept per run, in bytes. Bounded: the output becomes a report
   *  doc and an event payload, and a run that printed a gigabyte is not describing
   *  something a person will read. */
  maxOutputBytes: number;
  /**
   * Directory holding the `graph` binary, PREPENDED to a run's PATH.
   *
   * A run drives the seven verbs by name (`graph task create`), so the machine
   * decides which binary that is - the same division every other guard here
   * keeps. UNSET means a run has no `graph` on its PATH, which fails the honest
   * way: the command is not found, rather than found and pointed somewhere else.
   */
  graphBinDir?: string;
}

export interface AgentConfig {
  /** Base URL of the Loopany server holding the channel. */
  serverUrl: string;
  /** The shared secret for `/api/agent/*`. */
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
  /** Is this agent the workspace's SENSOR? On unless explicitly turned off: since
   *  captain decision 10 nothing else observes the outside world, so an agent that
   *  silently did not sense would leave the graph permanently stale. */
  sensing: boolean;
  /** How often to sweep the watch list. Much slower than the directive poll: a PR's
   *  state is not a millisecond-latency concern, and every sweep spends shared
   *  GitHub rate-limit budget. */
  sensingIntervalMs: number;
  run: RunConfig;
}

export const DEFAULT_POLL_MS = 3_000;
export const DEFAULT_SENSING_INTERVAL_MS = 2 * 60 * 1000;
export const DEFAULT_RUN_MAX_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_RUN_MAX_OUTPUT_BYTES = 256 * 1024;

class ConfigError extends Error {}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

/** A flag that is ON unless explicitly turned off. Used only where OFF is the
 *  dangerous-by-omission answer - sensing, where silence means a stale graph. */
function flagUnlessOff(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
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

/**
 * Split a fixed-argument string into an argv.
 *
 * Whitespace-separated with support for quoted segments, which is enough for the
 * real shapes (`-p`, `exec --json`, `"/path/with spaces/runner.sh"`) and deliberately
 * NOT a shell: no expansion, no substitution, no operators. The executor is spawned
 * with a fixed argument vector, so anything cleverer here would only be a way to
 * smuggle a second command into a config line.
 */
export function parseArgs(raw: string | undefined): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of (raw ?? "").matchAll(pattern)) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value) out.push(value);
  }
  return out;
}

function positive(raw: string | undefined, fallback: number, floor = 1): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n >= floor ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    serverUrl: req(env, "LOOPANY_AGENT_SERVER_URL").replace(/\/+$/, ""),
    token: req(env, "LOOPANY_AGENT_TOKEN"),
    agent: env.LOOPANY_AGENT_ID?.trim() || `machine-agent-${process.pid}`,
    ...(env.LOOPANY_AGENT_MACHINE?.trim() ? { machine: env.LOOPANY_AGENT_MACHINE.trim() } : {}),
    ...(env.LOOPANY_AGENT_TEAM?.trim() ? { teamId: env.LOOPANY_AGENT_TEAM.trim() } : {}),
    pollMs: positive(env.LOOPANY_AGENT_POLL_MS, DEFAULT_POLL_MS, 500),
    allowedRepos: parseRepoAllowlist(env.LOOPANY_AGENT_ALLOWED_REPOS),
    allowDefaultBranch: flag(env, "LOOPANY_AGENT_ALLOW_DEFAULT_BRANCH"),
    commentOnly: flag(env, "LOOPANY_AGENT_COMMENT_ONLY"),
    sensing: flagUnlessOff(env, "LOOPANY_AGENT_SENSING"),
    sensingIntervalMs: positive(env.LOOPANY_AGENT_SENSING_MS, DEFAULT_SENSING_INTERVAL_MS, 5_000),
    run: {
      ...(env.LOOPANY_AGENT_EXEC_COMMAND?.trim() ? { command: env.LOOPANY_AGENT_EXEC_COMMAND.trim() } : {}),
      args: parseArgs(env.LOOPANY_AGENT_EXEC_ARGS),
      ...(env.LOOPANY_AGENT_RUN_ROOT?.trim() ? { root: env.LOOPANY_AGENT_RUN_ROOT.trim() } : {}),
      maxTimeoutMs: positive(env.LOOPANY_AGENT_RUN_MAX_TIMEOUT_MS, DEFAULT_RUN_MAX_TIMEOUT_MS, 1_000),
      maxOutputBytes: positive(env.LOOPANY_AGENT_RUN_MAX_OUTPUT_BYTES, DEFAULT_RUN_MAX_OUTPUT_BYTES, 1_024),
      ...(env.LOOPANY_AGENT_GRAPH_BIN_DIR?.trim() ? { graphBinDir: env.LOOPANY_AGENT_GRAPH_BIN_DIR.trim() } : {}),
    },
  };
}

/** One block describing the posture this agent is running with. Printed at start,
 *  because "what was it allowed to do?" should never require reading the env of a
 *  process that has since exited. */
export function describeConfig(c: AgentConfig): string {
  const repos = c.allowedRepos.size ? [...c.allowedRepos].sort().join(", ") : "(none - every GitHub effect will refuse)";
  const executor = c.run.command ? [c.run.command, ...c.run.args].join(" ") : "(none - every run will refuse)";
  return [
    `server        ${c.serverUrl}`,
    `agent         ${c.agent}${c.machine ? ` on ${c.machine}` : ""}`,
    `poll          ${c.pollMs}ms · sensing ${c.sensing ? `every ${Math.round(c.sensingIntervalMs / 1000)}s` : "OFF"}`,
    `repos         ${repos}`,
    `merge         ${c.commentOnly ? "DISABLED (comment-only)" : "allowed on allowlisted repos"}`,
    `default base  ${c.allowDefaultBranch ? "ALLOWED" : "refused"}`,
    `executor      ${executor}`,
    `run root      ${c.run.root ?? "(none - every run will refuse)"}`,
    `run limits    ${Math.round(c.run.maxTimeoutMs / 1000)}s · ${Math.round(c.run.maxOutputBytes / 1024)}KB captured`,
    `graph cli     ${c.run.graphBinDir ?? "(not on a run's PATH - the seven verbs are unavailable)"}`,
  ].join("\n  ");
}
