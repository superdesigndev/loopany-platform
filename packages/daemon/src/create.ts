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

export async function runCreate(args: string[]): Promise<number> {
  const configPath = flag(args, "config");
  if (!configPath) {
    process.stderr.write("loopany: usage: loopany new --config <loop.json> [--connect-key dk_…] [--tz <IANA>]\n");
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
  const body: Record<string, unknown> = { ...config, timezone };
  if (connectKey) body.claim = connectKey;

  try {
    const res = await fetch(`${server}/api/machine/loop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; name?: string; error?: string };
    if (!res.ok || !data.ok) {
      process.stderr.write(`loopany: ${data.error || `create failed (${res.status})`}\n`);
      return 1;
    }
    process.stdout.write(`created loop ${data.name ?? data.id} — ${config.cron} ${timezone}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
