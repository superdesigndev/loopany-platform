/**
 * Notification dispatch — routes a finished run's message to the loop's chosen
 * push channel (per-team `notification_channels` row). A loop with no channel set
 * pushes nowhere (dashboard only), regardless of its `notify` policy.
 *
 * `shouldNotify` (when) is orthogonal to the channel (where): the policy gates
 * whether to push at all; the channel decides the transport. Sends are
 * best-effort — a bad token/chat just logs a warning (the run is already on the
 * dashboard).
 *
 * Each channel type is described once in `CHANNELS` (how to validate / hint /
 * send) so adding a transport is a single entry, not a branch in five places.
 */
import { createHmac } from "node:crypto";

import { logger } from "../logger.js";
import * as store from "../db/store.js";
import type { ChannelConfig, ChannelType, Loop, NotifyPolicy, RunStatus } from "../db/schema.js";
import { safeWebhookFetch, validateFeishuWebhookUrl, type WebhookFetchDeps } from "./webhookGuard.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import type { SlackChannelSummary } from "../types.js";

const log = logger.child({ mod: "notify" });

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** One push transport: how to validate its config, summarize it, and send. */
export interface ChannelKind {
  /** Config keys that must be present (drives create validation + trimming). */
  required: (keyof ChannelConfig)[];
  /** Config keys kept if provided but not required (e.g. an optional secret). */
  optional?: (keyof ChannelConfig)[];
  /** Redacted, secret-free one-liner so a configured channel reads as set up. */
  hint: (cfg: ChannelConfig) => string;
  /** Extra per-type validation beyond required-field presence, run at create/edit
   *  time. Returns an error string to reject, or null to accept. Pure + sync (no
   *  network): a full DNS/IP guard additionally runs at send time. */
  validate?: (cfg: ChannelConfig) => string | null;
  send: (cfg: ChannelConfig, title: string, message: string) => Promise<SendResult>;
}

/**
 * Injectable transport seam for the SSRF-guarded webhook send (Feishu/Lark).
 * Defaults to real DNS + global fetch; tests override `lookup`/`fetchImpl` so the
 * guard logic still runs but never touches the network. Set via
 * `setWebhookFetchDeps` (test-only).
 */
let webhookFetchDeps: WebhookFetchDeps = {};
export function setWebhookFetchDeps(deps: WebhookFetchDeps): void {
  webhookFetchDeps = deps;
}

/** Should this run message the user, per the loop's notify policy + run status? */
export function shouldNotify(notify: NotifyPolicy, status: RunStatus | null): boolean {
  if (notify === "never") return false;
  if (notify === "always") return true;
  return status !== "nothing-new"; // auto
}

/**
 * Anti-spam cadence for FAILURE alerts: re-notify at most once per this many
 * consecutive failures. A loop that fails every tick would otherwise push on
 * every run — instead we alert on the first failure (the success→failure
 * transition) and then only every Nth consecutive failure as a "still broken"
 * reminder. Derived from persisted run rows (see `store.execFailureStreak`), so
 * it survives deploys without any in-memory counter.
 */
export const FAILURE_NOTIFY_EVERY = 5;

/**
 * Should a FAILED run (error / timeout / machine-offline) message the user?
 * Orthogonal to `shouldNotify` (which gates success-path content): failures
 * carry no RunStatus. Policy:
 *   - `never` ⇒ silent (the user opted out of all pushes).
 *   - otherwise (`auto`/`always`) ⇒ notify on the FIRST failure of a streak,
 *     then once every `FAILURE_NOTIFY_EVERY` consecutive failures.
 * `streak` is the number of consecutive failed exec runs ending at this one
 * (1 = this is the first failure after a success / the loop's first run ever).
 */
export function shouldNotifyFailure(notify: NotifyPolicy, streak: number): boolean {
  if (notify === "never") return false;
  if (streak <= 0) return false;
  return streak === 1 || streak % FAILURE_NOTIFY_EVERY === 0;
}

/**
 * Build the user-facing failure message from a run's recorded `error`. Machine-
 * availability reasons are usually just a laptop that fell ASLEEP (or briefly
 * dropped offline) and comes back on its own — so they get a calm, de-alarmed
 * phrasing that names sleep as the likely cause and reassures that the loop
 * resumes automatically, rather than reading like a scary failure. The two
 * shapes are distinguished: a RUNNING run that was interrupted mid-flight
 * ("timed out / disconnected") vs a scheduled run that couldn't start
 * ("machine offline" / "run never claimed"). Anything else reads as a plain run
 * failure with the reason appended.
 */
export function failureMessage(reason?: string | null): string {
  const r = (reason ?? "").trim();
  // A running run interrupted mid-flight when the machine went to sleep/offline.
  // Match only the SERVER's reclaim reason ("machine timed out / disconnected"),
  // never the daemon's local exec-timeout failure "claude timed out (Ns)".
  if (/machine timed out|disconnect/i.test(r)) {
    return "⏸ Your machine went to sleep or offline while a run was in progress, so it was interrupted. It resumes automatically when the machine is back.";
  }
  // A scheduled run that couldn't start because the machine was asleep/offline.
  if (/offline|never claimed/i.test(r)) {
    return "⏸ Your machine was asleep or offline when this run was due, so it was skipped. It resumes automatically when the machine is back.";
  }
  return r ? `⚠️ Run failed — ${r}` : "⚠️ Run failed.";
}

/**
 * The one-shot note sent when the circuit breaker auto-pauses a loop after a
 * long consecutive-failure streak. It replaces (never joins) the failure alert
 * for that run, and is the LAST push until a human re-enables the loop — so it
 * must name both the state change and the way back.
 */
export function autopauseMessage(streak: number): string {
  return `\u23f8 Paused automatically after ${streak} failed runs in a row. Fix the underlying issue, then re-enable the loop from its page - it resumes on its normal schedule.`;
}

/**
 * The calm FYI for a scheduled run WAITING on an offline machine. Nothing
 * failed: the run is deferred (the pending row is the queue) and executes when
 * the machine reconnects; meanwhile each newer fire supersedes the older one,
 * so at most one catch-up run is waiting. Sent ONCE per deferred run (the sweep
 * stamps a dedup marker), and only once the machine reads as genuinely OFFLINE
 * (>6h) — a merely asleep machine stays silent.
 */
export function deferredMessage(): string {
  return "\u23f8 Your machine looks offline, so a scheduled run is waiting. It runs automatically when the machine reconnects; only the newest missed run is kept.";
}

/**
 * The user-facing message for a CLOSED loop that reached its goal (`loopany
 * finish`). A distinct, positive terminal event — surfaced unless notify=never
 * (the caller gates that). Prefers the finishing run's reason, then its message.
 */
export function completionMessage(reason?: string | null, message?: string | null): string {
  const detail = (reason ?? "").trim() || (message ?? "").trim();
  return detail ? `✅ Goal reached — ${detail}` : "✅ Goal reached — this loop has completed.";
}

/** fetch + parse JSON + map to a SendResult, never throwing. `fault` returns an
 *  error string when the parsed body signals failure, or null on success. */
async function postJson(
  url: string,
  init: RequestInit,
  fault: (data: Record<string, unknown>, status: number) => string | null,
): Promise<SendResult> {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = fault(data, res.status);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const CHANNELS: Record<ChannelType, ChannelKind> = {
  telegram: {
    required: ["botToken", "chatId"],
    hint: (c) => `chat ${c.chatId?.trim() || "—"}`,
    send: (cfg, title, message) => {
      const token = cfg.botToken?.trim();
      const chatId = cfg.chatId?.trim();
      if (!token || !chatId) return Promise.resolve({ ok: false, error: "missing bot token / chat id" });
      return postJson(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ chat_id: chatId, text: `🔁 *${title}*\n${message}`, parse_mode: "Markdown" }),
        },
        (d, status) => (d.ok ? null : (typeof d.description === "string" ? d.description : `HTTP ${status}`)),
      );
    },
  },
  slack: {
    required: ["token", "channel"],
    hint: (c) => c.channel?.trim() || "—",
    // Pure, sync, no network — a Bot User OAuth Token always starts "xoxb-" (or the
    // rarer "xoxp-" user token); catches a pasted app-id/signing-secret/webhook URL
    // at create/edit time instead of failing silently at send time.
    validate: (cfg) => {
      const token = cfg.token?.trim() ?? "";
      if (!token.startsWith("xox")) {
        return 'Slack token should start with "xoxb-" (a Bot User OAuth Token) — got something else';
      }
      if (!cfg.channel?.trim()) return "Slack channel is required";
      return null;
    },
    send: (cfg, title, message) => {
      const token = cfg.token?.trim();
      const channel = cfg.channel?.trim();
      if (!token || !channel) return Promise.resolve({ ok: false, error: "missing bot token / channel" });
      return postJson(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel, text: `🔁 *${title}*\n${markdownToMrkdwn(message)}` }),
        },
        (d, status) => {
          if (d.ok) return null;
          const code = typeof d.error === "string" ? d.error : null;
          if (code === "channel_not_found" || code === "not_in_channel") {
            return `${code} — invite the bot to the channel (/invite @yourbot)`;
          }
          if (code === "invalid_auth" || code === "token_revoked" || code === "account_inactive") {
            return `${code} — the bot token is invalid or revoked, reconnect the channel with a fresh token`;
          }
          return code || `HTTP ${status}`;
        },
      );
    },
  },
  feishu: {
    required: ["webhookUrl"],
    optional: ["secret"],
    // The webhook URL is itself the credential — surface only its host (feishu vs lark).
    hint: (c) => {
      try {
        return new URL(c.webhookUrl!.trim()).host;
      } catch {
        return "webhook";
      }
    },
    // Reject a non-allowlisted / non-HTTPS destination at create/edit time (pure,
    // no network); the send path additionally DNS-resolves + IP-guards.
    validate: (cfg) => {
      const check = validateFeishuWebhookUrl(cfg.webhookUrl);
      return check.ok ? null : check.error;
    },
    send: async (cfg, title, message) => {
      const url = cfg.webhookUrl?.trim();
      if (!url) return { ok: false, error: "missing webhook url" };
      // Feishu text msgs don't render Markdown — keep the title plain (no asterisks).
      const body: Record<string, unknown> = { msg_type: "text", content: { text: `🔁 ${title}\n${message}` } };
      const secret = cfg.secret?.trim();
      if (secret) {
        const ts = Math.floor(Date.now() / 1000).toString();
        body.timestamp = ts;
        // 签名校验: HMAC-SHA256 with `${ts}\n${secret}` as the key over an empty body, base64.
        body.sign = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
      }
      // SSRF guard: re-validate the allowlist + resolved IPs at SEND time (a stored
      // URL is untrusted — it may have been tampered with in the DB since create),
      // with a bounded timeout + bounded response read and no redirect bypass.
      try {
        const res = await safeWebhookFetch(
          url,
          { headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) },
          webhookFetchDeps,
        );
        const d = res.json;
        if (d.code === 0) return { ok: true };
        return { ok: false, error: typeof d.msg === "string" ? d.msg : `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
};

/** One page of `conversations.list` (200 channels, Slack's own max page size). */
const SLACK_CHANNELS_PAGE_LIMIT = 200;
/** Hard cap on how many channels the picker will ever load, across pages. */
const SLACK_CHANNELS_MAX = 1000;

/**
 * List the channels a Slack bot token can see, for the add-channel picker
 * (`notifyFns.listSlackChannels`) — paginates `conversations.list` via
 * `response_metadata.next_cursor`, capped at `SLACK_CHANNELS_MAX` total. Pure
 * passthrough to a fixed `slack.com` host (no user-supplied URL), so this needs
 * no webhookGuard-style SSRF check — same trust boundary as `CHANNELS.slack.send`.
 * Never throws, never logs the token.
 */
export async function fetchSlackChannels(token: string): Promise<{
  ok: boolean;
  channels?: SlackChannelSummary[];
  error?: string;
}> {
  const t = token.trim();
  if (!t.startsWith("xox")) {
    return { ok: false, error: 'Slack token should start with "xoxb-" (a Bot User OAuth Token) — got something else' };
  }
  const channels: SlackChannelSummary[] = [];
  let cursor = "";
  try {
    do {
      const params = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: String(SLACK_CHANNELS_PAGE_LIMIT),
      });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!d.ok) {
        const code = typeof d.error === "string" ? d.error : null;
        if (code === "missing_scope") {
          return {
            ok: false,
            error: "the app is missing the channels:read scope — recreate it with the pre-filled button or add the scope manually",
          };
        }
        if (code === "invalid_auth" || code === "token_revoked" || code === "account_inactive") {
          return { ok: false, error: `${code} — the bot token is invalid or revoked, reconnect the channel with a fresh token` };
        }
        return { ok: false, error: code ?? `HTTP ${res.status}` };
      }
      const list = Array.isArray(d.channels) ? (d.channels as Record<string, unknown>[]) : [];
      for (const c of list) {
        if (typeof c.id === "string" && typeof c.name === "string") {
          channels.push({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member });
        }
      }
      const meta = d.response_metadata as Record<string, unknown> | undefined;
      cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
    } while (cursor && channels.length < SLACK_CHANNELS_MAX);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels: channels.slice(0, SLACK_CHANNELS_MAX) };
}

/** Route a finished run's message to the loop's channel. Best-effort, no throw. */
export async function dispatchNotification(loop: Loop, message: string): Promise<void> {
  if (!loop.channelId) return; // no channel ⇒ dashboard only
  const channel = await store.getChannel(loop.channelId);
  if (!channel) return; // channel deleted out from under the loop
  const r = await CHANNELS[channel.type].send(channel.config, loop.name || loop.id, message);
  if (!r.ok) log.warn({ err: r.error, channel: channel.id }, "notify dispatch failed");
}
