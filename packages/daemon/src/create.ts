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

import { DEVICE_FILE, flag, readStored, resolveServerUrl } from "./config.js";
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

/** Local pre-check only — the server (croner) is the SOLE validator. Croner
 *  accepts 5- and 6-field expressions plus @-shortcuts (@daily …), so reject
 *  only the obviously-wrong shapes: a valid config must never fail locally. */
export function cronLooksValid(cron: unknown): cron is string {
  if (typeof cron !== "string") return false;
  const s = cron.trim();
  if (!s) return false;
  if (s.startsWith("@")) return true; // @daily/@hourly/… — let the server judge
  const fields = s.split(/\s+/).length;
  return fields === 5 || fields === 6;
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
  // The config is passed INLINE as `--json '<obj>'` (or `--json -` to read stdin),
  // replacing the old `--config <file>` temp-file ritual (batch 2). `--dry-run`
  // validates + previews without creating anything.
  const jsonArg = flag(args, "json");
  const dryRun = args.includes("--dry-run");
  if (jsonArg === undefined) {
    process.stderr.write("loopany: usage: loopany new --json '<config>' [--dry-run] [--connect-key dk_…] [--tz <IANA>] [--agent claude-code|codex]\n");
    return 2;
  }

  const server = resolveServerUrl(flag(args, "server-url"));
  const token = readStored(DEVICE_FILE) || process.env.LOOPANY_TOKEN;
  if (!server || !token) {
    process.stderr.write("loopany: this machine isn't connected yet — run `loopany up --server-url … --connect-key …` first\n");
    return 2;
  }

  let raw: string;
  try {
    // `--json -` reads the config from stdin (fd 0) — handy for a large inline object.
    raw = jsonArg === "-" ? fs.readFileSync(0, "utf8") : jsonArg;
  } catch (err) {
    process.stderr.write(`loopany: cannot read config from stdin: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!raw.trim()) {
    process.stderr.write("loopany: --json needs the config object (e.g. --json '{\"cron\":\"0 8 * * *\",\"taskFile\":\"loopany/x/README.md\"}')\n");
    return 2;
  }
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    config = parsed as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`loopany: cannot parse --json config: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (!cronLooksValid(config.cron)) {
    process.stderr.write('loopany: config needs a "cron" expression (e.g. "0 8 * * *")\n');
    return 2;
  }
  // The `task` column is gone (batch 2): a loop's brief lives in its task file, so a
  // loop needs a "workflow" (JS) OR a "taskFile" (path to the Spec) to work from.
  if (!config.workflow && !config.taskFile) {
    process.stderr.write('loopany: config needs a "workflow" (JS) or a "taskFile" (path to the loop\'s Spec)\n');
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
  if (dryRun) body.dryRun = true;

  try {
    const res = await fetchImpl(`${server}/api/machine/loop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as CreateResponse;
    if (!res.ok || !data.ok) {
      process.stderr.write(`loopany: ${data.error || `create failed (${res.status})`}\n`);
      return 1;
    }
    if (dryRun) {
      printCreateDryRun(write, data, timezone);
      return 0;
    }
    write(`created loop ${data.name ?? data.id} — ${config.cron} ${timezone}\n`);
    // Best-effort: now that the loop exists, install/refresh the loopany skill at
    // USER scope (`~/.claude/skills/loopany`), so the coding agent discovers the
    // references from ANY loop workdir. Announced, never blocks — any failure
    // degrades to the always-working /api/skill/references path. Only runs after a
    // confirmed create. (`loopany up` also refreshes it; this keeps a create made
    // without a fresh `up` current too.)
    await announceSkillInstall(installer, write);
    return 0;
  } catch (err) {
    process.stderr.write(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** POST /api/machine/loop response (real create or `--dry-run` preview). */
interface CreateResponse {
  ok?: boolean;
  id?: string;
  name?: string;
  error?: string;
  dryRun?: boolean;
  config?: Record<string, unknown>;
  timezone?: string | null;
  nextRuns?: string[];
  classification?: string;
  classificationText?: string;
}

/** Render the `--dry-run` create preview: the normalized config, detected tz, the
 *  next 3 fire times in that tz, and the open/closed classification. */
function printCreateDryRun(write: (s: string) => void, data: CreateResponse, timezone: string): void {
  const c = data.config ?? {};
  const tz = (typeof data.timezone === "string" && data.timezone) || timezone || "(server-local)";
  write("dry-run — nothing created; config is valid\n");
  write(`  name: ${c.name ?? "(unnamed)"}\n`);
  write(`  cron: ${String(c.cron ?? "")} ${tz}\n`);
  if (c.taskFile) write(`  taskFile: ${String(c.taskFile)}\n`);
  write(`  workflow: ${c.workflow ? "yes" : "no"}\n`);
  write(`  goal: ${c.goal != null ? String(c.goal) : "—"}\n`);
  if (data.classificationText) write(`  ${data.classificationText}\n`);
  const runs = data.nextRuns ?? [];
  if (runs.length) {
    write(`  next ${runs.length} runs:\n`);
    for (const t of runs) write(`    ${t}\n`);
  }
}

/** Best-effort, announced USER-scope install (`~/.claude/skills/loopany`). Swallows
 *  every error and prints one line — loop creation must never fail on the skill. */
async function announceSkillInstall(
  installer: (opts: InstallOpts) => Promise<InstallOutcome>,
  write: (s: string) => void,
): Promise<void> {
  try {
    const r = await installer({ global: true });
    write(r.line + "\n");
  } catch {
    /* truly never block create */
  }
}
