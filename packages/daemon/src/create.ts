/**
 * `loopany new` — create a loop from a config file the agent wrote.
 *
 * Folds SKILL.md §3 (hand IANA-timezone detection) and §4 (hand-built JSON +
 * curl) into one command. The agent's config carries only real intent —
 * name · cron · workflow|task · workdir · taskFile · stateSchema · notify. This
 * command fills the fixed envelope the agent shouldn't have to think about:
 *   - timezone: auto-detected IANA (config/--tz override), so the cadence fires
 *     in the user's local time, not the server's (UTC in prod),
 *   - claim:    the connect-key, so the web New-loop dialog resolves,
 *   - auth:     Bearer this machine's stored device token,
 * then POSTs to the gateway's existing /api/machine/loop. The server stays the
 * sole validator; we pre-check the obvious local mistakes for a clear message.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEVICE_FILE, LOOPANY_DIR, flag, readStored, resolveServerUrl } from "./config.js";
import { type InstallOpts, type InstallOutcome, installSkill } from "./skill-install.js";

/**
 * Best-effort IANA zone for THIS machine. `Intl` is the portable primary (works
 * in containers with no /etc/localtime symlink); the symlink is a fallback for
 * the rare host whose Intl data is misconfigured. Empty ⇒ caller asks for --tz.
 */
function detectTimezone(): string {
  let intlZone = "";
  try {
    intlZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (intlZone && intlZone !== "UTC") return intlZone;
  } catch {
    /* fall through */
  }
  try {
    const link = fs.readlinkSync("/etc/localtime");
    const m = link.match(/zoneinfo\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    /* fall through */
  }
  // No symlink zone: fall back to whatever Intl gave us ("UTC" genuine or
  // default) rather than nothing — trust it over an empty string.
  return intlZone || "";
}

/** A cron must be a 5-field string before we bother the server with it. */
function cronLooksValid(cron: unknown): cron is string {
  return typeof cron === "string" && cron.trim().split(/\s+/).length === 5;
}

/** The coding agents LoopAny can record a loop against (TS-only; cheap to widen). */
export type CodingAgent = "claude-code" | "codex";

/** Coerce an arbitrary declared value (--agent flag / config.agent) to a known
 *  agent, or null when it's absent/unrecognized (so it can't override a measurement
 *  and the server falls back to its own default). */
export function coerceAgent(v: unknown): CodingAgent | null {
  return v === "claude-code" || v === "codex" ? v : null;
}

/**
 * Best-effort fingerprint of the coding agent hosting THIS `loopany new` process,
 * read from the env the host agent exported into our shell. This MEASURES the real
 * host (it can't be fooled by a wrong dialog selection), but it's best-effort: a
 * host that runs us without its marker env (e.g. Codex under bypass-sandbox mode)
 * is undetectable here, so callers fall back to the declared/selected value.
 *
 * Fingerprints (verified against the live Claude Code env + current Codex CLI docs,
 * `CODEX_SANDBOX*` per openai/codex AGENTS.md, not memory):
 *   - Claude Code: `CLAUDECODE` (also exports many `CLAUDE_CODE_*`).
 *   - Codex CLI:  `CODEX_SANDBOX` / `CODEX_SANDBOX_NETWORK_DISABLED` (set for its
 *     shell tool under the sandbox). We deliberately ignore `CODEX_COMPANION_*`,
 *     which a Claude Code session can also export and would misattribute.
 */
export function detectAgentFromEnv(env: NodeJS.ProcessEnv): CodingAgent | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  return null;
}

/**
 * Resolve the recorded agent by the agreed precedence:
 *   measured CLI env-fingerprint > declared (--agent / config.agent) > undefined.
 * Returns undefined when nothing is known so the server applies its own default
 * (claude-code) — we never invent a value the host didn't actually evidence.
 */
export function resolveAgent(env: NodeJS.ProcessEnv, declared: unknown): CodingAgent | undefined {
  return detectAgentFromEnv(env) ?? coerceAgent(declared) ?? undefined;
}

/**
 * Resolve the absolute directory this loop's agent will run in — the place the
 * skill should be installed at creation. Mirrors the daemon's own resolution
 * (runner.resolveWorkdir / watcher.resolveWatchDir): an explicit `workdir`
 * (tilde-expanded, made absolute) when set, else the per-loop daemon scratch dir
 * `~/.loopany/work/<loopId>`. Never `process.cwd()` — `loopany new` may be invoked
 * from anywhere, and we want the loop's real workdir. Returns "" when there's no
 * explicit workdir AND no loopId, so the scratch path can't collapse to the shared
 * `~/.loopany/work` parent (the caller then skips the install). The dir is NOT
 * created here — announceSkillInstall ensures it exists before installing.
 */
export function resolveLoopWorkdir(workdir: unknown, loopId: string): string {
  if (typeof workdir === "string" && workdir.trim()) {
    const expanded = workdir.startsWith("~/") ? path.join(os.homedir(), workdir.slice(2)) : workdir;
    return path.resolve(expanded);
  }
  if (!loopId.trim()) return "";
  return path.join(LOOPANY_DIR, "work", loopId);
}

/** Tests inject these to assert the post-create skill install without network/npx. */
export interface CreateDeps {
  fetchImpl?: typeof fetch;
  installer?: (opts: InstallOpts) => Promise<InstallOutcome>;
  stdout?: (s: string) => void;
}

export async function runCreate(args: string[], deps: CreateDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const installer = deps.installer ?? installSkill;
  const write = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const configPath = flag(args, "config");
  if (!configPath) {
    process.stderr.write("loopany: usage: loopany new --config <loop.json> [--connect-key dk_…] [--tz <IANA>] [--agent claude-code|codex]\n");
    return 2;
  }

  const server = resolveServerUrl(flag(args, "server-url"));
  const token = readStored(DEVICE_FILE) || process.env.LOOPANY_TOKEN;
  if (!server || !token) {
    process.stderr.write("loopany: this machine isn't connected yet — run `loopany up --server-url … --connect-key …` first\n");
    return 2;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`loopany: cannot read config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (!cronLooksValid(config.cron)) {
    process.stderr.write('loopany: config needs a 5-field "cron" (e.g. "0 8 * * *")\n');
    return 2;
  }
  if (!config.workflow && !config.task) {
    process.stderr.write('loopany: config needs a "workflow" (JS) or a "task" (instruction)\n');
    return 2;
  }

  // The CLI owns the fixed envelope: timezone (so "8am" means the user's 8am),
  // claim (so the web dialog learns the loop was created), auth (the bearer).
  const timezone = (typeof config.timezone === "string" && config.timezone) || flag(args, "tz") || detectTimezone();
  const connectKey = flag(args, "connect-key");
  // Record which coding agent this loop is bound to: measure our host from the env
  // first (honest), else fall back to what was declared via --agent or a hand-written
  // config `agent:` line (the New-loop dialog no longer emits one — self-detection
  // drives it). Undefined ⇒ let the server default it to claude-code.
  const agent = resolveAgent(process.env, flag(args, "agent") ?? config.agent);
  const body: Record<string, unknown> = { ...config, timezone };
  // Send only a coerced agent (or none) — never a raw config.agent that skipped
  // resolution; the server defaults a missing value to claude-code.
  if (agent) body.agent = agent;
  else delete body.agent;
  if (connectKey) body.claim = connectKey;

  try {
    const res = await fetchImpl(`${server}/api/machine/loop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; name?: string; error?: string };
    if (!res.ok || !data.ok) {
      process.stderr.write(`loopany: ${data.error || `create failed (${res.status})`}\n`);
      return 1;
    }
    write(`created loop ${data.name ?? data.id} — ${config.cron} ${timezone}\n`);
    // Best-effort: now that the loop exists, install/refresh the loopany skill into
    // the dir its agent will run in (project-level), so the coding agent discovers
    // the references there. Announced, never blocks — any failure degrades to the
    // always-working /api/skill path, exactly like before. Only runs after a
    // confirmed create.
    await announceSkillInstall(installer, resolveLoopWorkdir(config.workdir, data.id ?? ""), write);
    return 0;
  } catch (err) {
    process.stderr.write(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** Best-effort, announced project-level install into `workdir`. Ensures the dir
 *  exists first (the scratch dir is created lazily by the runner only at first run,
 *  and an explicit workdir may not exist yet — npx ENOENTs on a missing cwd, which
 *  would silently no-op the install). Swallows every error and prints one line —
 *  loop creation must never fail on the skill. An empty workdir (no explicit dir +
 *  no loopId) skips the install rather than targeting the shared scratch parent. */
async function announceSkillInstall(
  installer: (opts: InstallOpts) => Promise<InstallOutcome>,
  workdir: string,
  write: (s: string) => void,
): Promise<void> {
  if (!workdir.trim()) return;
  try {
    fs.mkdirSync(workdir, { recursive: true });
    const r = await installer({ cwd: workdir });
    write(r.line + "\n");
  } catch {
    /* truly never block create */
  }
}
