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
  send: (cfg: ChannelConfig, title: string, message: string) => Promise<SendResult>;
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
    send: (cfg, title, message) => {
      const token = cfg.token?.trim();
      const channel = cfg.channel?.trim();
      if (!token || !channel) return Promise.resolve({ ok: false, error: "missing bot token / channel" });
      return postJson(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel, text: `🔁 *${title}*\n${message}` }),
        },
        (d, status) => (d.ok ? null : (typeof d.error === "string" ? d.error : `HTTP ${status}`)),
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
    send: (cfg, title, message) => {
      const url = cfg.webhookUrl?.trim();
      if (!url) return Promise.resolve({ ok: false, error: "missing webhook url" });
      // Feishu text msgs don't render Markdown — keep the title plain (no asterisks).
      const body: Record<string, unknown> = { msg_type: "text", content: { text: `🔁 ${title}\n${message}` } };
      const secret = cfg.secret?.trim();
      if (secret) {
        const ts = Math.floor(Date.now() / 1000).toString();
        body.timestamp = ts;
        // 签名校验: HMAC-SHA256 with `${ts}\n${secret}` as the key over an empty body, base64.
        body.sign = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
      }
      return postJson(
        url,
        { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) },
        (d, status) => (d.code === 0 ? null : (typeof d.msg === "string" ? d.msg : `HTTP ${status}`)),
      );
    },
  },
};

/** Route a finished run's message to the loop's channel. Best-effort, no throw. */
export async function dispatchNotification(loop: Loop, message: string): Promise<void> {
  if (!loop.channelId) return; // no channel ⇒ dashboard only
  const channel = await store.getChannel(loop.channelId);
  if (!channel) return; // channel deleted out from under the loop
  const r = await CHANNELS[channel.type].send(channel.config, loop.name || loop.id, message);
  if (!r.ok) log.warn({ err: r.error, channel: channel.id }, "notify dispatch failed");
}
