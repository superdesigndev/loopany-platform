/**
 * OWNER NOTIFICATIONS (kernel-owner-notifications) - notify humans ONLY when
 * attention is required; normal loop execution stays quiet.
 *
 * The destination: the assignee's newest User-owned notification channel,
 * shared across every Team they belong to. Three attention conditions derive from the
 * changeset that JUST APPLIED (so this is event-driven, never a poller):
 *
 *  1. HUMAN ASSIGNMENT - a task created with, or handed to, a person assignee
 *     (their decision inbox got work). Each assignment is a fresh decision, so
 *     each notifies.
 *  2. PARKED FAILURE - the kernel's failed-run resilience auto-parked a task
 *     (the "auto-parked after N consecutive failed runs" note). The park IS the
 *     persistent-failure signal: individual failures stay quiet (a cron loop
 *     self-heals; the backoff ladder retries), so this is ONE actionable
 *     notification, never one per sweep.
 *  3. DISPATCH BLOCKED - the clock-actor configuration note (unknown/ambiguous
 *     alias etc., blocked.ts). Dedup is INHERITED: blocked.ts writes at most
 *     one such event per blocked run, so at most one notification - and a later
 *     fire (a NEW run) legitimately re-notifies on a new event basis.
 *
 * Every message links the task and its key artifact. The assignment event is
 * the durable intent; delivery is best-effort and never rolls back the write.
 */
import { isPersonAssignee, type Changeset, type KernelEvent, type TaskObject } from "@loopany/kernel";
import * as store from "../db/store.js";
import { CHANNELS } from "../gateway/notify.js";
import { logger } from "../logger.js";

export type KernelNotifier = (teamId: string, userId: string, title: string, message: string, eventId: string) => Promise<void>;

async function realNotifier(teamId: string, userId: string, title: string, message: string, eventId: string): Promise<void> {
  if (!(await store.isTeamMember(teamId, userId))) {
    logger.info({ teamId, userId, eventId, result: "not-member" }, "kernel notification skipped");
    return;
  }
  const channel = (await store.listChannels(userId))[0];
  if (!channel) {
    logger.info({ teamId, userId, eventId, result: "no-channel" }, "kernel notification skipped");
    return;
  }
  const r = await CHANNELS[channel.type].send(channel.config, title, message);
  const fields = { teamId, userId, eventId, channelId: channel.id, channelType: channel.type };
  if (r.ok) logger.info({ ...fields, result: "sent" }, "kernel notification sent");
  else logger.warn({ ...fields, result: "failed", err: r.error }, "kernel notification failed");
}

let notifier: KernelNotifier = realNotifier;

/** Test seam: inject a notifier (pass null to restore the real one). */
export function setKernelNotifier(n: KernelNotifier | null): void {
  notifier = n ?? realNotifier;
}

function taskIn(cs: Changeset, id: string): TaskObject | undefined {
  const obj = cs.objects.find((m) => m.object.id === id)?.object;
  return obj?.archetype === "task" ? obj : undefined;
}

function productLink(task: TaskObject | undefined): string {
  if (!task) return "";
  const key = task.tracks ?? task.refs[0];
  return key ? `\ninspect: ${key}` : "";
}

/** Scan one just-applied changeset for the attention conditions and push. */
export async function notifyKernelChangeset(teamId: string, cs: Changeset): Promise<void> {
  for (const e of cs.events) {
    try {
      const condition = classify(e, cs);
      if (!condition) continue;
      const userId = personUserId(condition.owner);
      if (!userId) continue;
      const member = (await store.listTeamMembers(teamId)).find((item) => item.userId === userId);
      if (!member) {
        logger.info({ teamId, userId, eventId: e.id, result: "not-member" }, "kernel notification skipped");
        continue;
      }
      const display = member.email ?? member.displayName ?? condition.owner!;
      const message = condition.message.replaceAll(condition.owner!, display);
      await notifier(teamId, userId, condition.title, message, e.id);
    } catch (err) {
      logger.warn(
        { teamId, eventId: e.id, err: err instanceof Error ? err.message : String(err) },
        "kernel notify failed (best-effort - the write is unaffected)",
      );
    }
  }
}

function personUserId(address?: string | null): string | null {
  if (!address?.startsWith("person:")) return null;
  const userId = address.slice("person:".length);
  return userId || null;
}

function classify(e: KernelEvent, cs: Changeset): { title: string; message: string; owner?: string | null } | null {
  const task = taskIn(cs, e.objectId);

  // 1. Human assignment: created-with-person or handed-to-person.
  if (e.kind === "created" && task && task.assignee !== null && isPersonAssignee(task.assignee)) {
    return {
      title: `decision needed: ${task.title}`,
      message: `${task.assignee} - "${task.title}" (${task.id}) is waiting on you.${productLink(task)}`,
      owner: task.assignee, // the human who must act
    };
  }
  if (e.kind === "assignee-changed") {
    const next = (e.diff?.assignee as { new?: unknown } | undefined)?.new;
    if (typeof next === "string" && isPersonAssignee(next)) {
      return {
        title: `decision needed: ${task?.title ?? e.objectId}`,
        message: `${next} - "${task?.title ?? e.objectId}" (${e.objectId}) was handed to you${e.note ? `: ${e.note}` : "."}${productLink(task)}`,
        owner: next, // the human who must act
      };
    }
    return null;
  }

  // 2. Parked failure (the kernel's own persistent-failure marker).
  if (e.kind === "status-changed" && (e.note ?? "").includes("auto-parked")) {
    return {
      title: `parked: ${task?.title ?? e.objectId}`,
      message: `"${task?.title ?? e.objectId}" (${e.objectId}) ${e.note}${productLink(task)}`,
      owner: task?.owner,
    };
  }

  // 3. Dispatch blocked (configuration) - dedup inherited from blocked.ts.
  if (e.kind === "note" && e.provenance.entrance === "clock" && (e.note ?? "").includes("dispatch blocked")) {
    return {
      title: `needs configuration: ${task?.title ?? e.objectId}`,
      message: `${e.note}${productLink(task)}`,
      owner: task?.owner,
    };
  }

  return null;
}
