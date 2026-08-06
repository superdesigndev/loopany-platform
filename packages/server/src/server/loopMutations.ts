import { Cron } from "croner";

import * as store from "../db/store.js";
import type { Loop, NewLoop } from "../db/schema.js";
import { watchedTasksWarningFor } from "../kernel/watchedTasks.js";
import { coerceCodingAgent, type JobPayload, type MutationResult } from "../types.js";
import { validateWorkdir } from "../lib/workdir.js";

export type OwnerLoopPatch = JobPayload & { timezone?: string | null };

export interface OwnerLoopMutation extends MutationResult {
  loop?: Loop;
  changed?: boolean;
}

type SchedulerWriter = { addLoop: (loop: Loop) => unknown };

const scalarChanged = (before: unknown, after: unknown): boolean => {
  if ((before == null || before === "") && (after == null || after === "")) return false;
  if (typeof before === "object" || typeof after === "object") return JSON.stringify(before) !== JSON.stringify(after);
  return before !== after;
};

function validateCron(cron: string, timezone: string | null): string | undefined {
  try {
    const probe = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
    probe.nextRun();
    probe.stop();
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The shared owner edit path behind the shipping form and workspace controls.
 * Authorization is resolved by the caller; validation, scheduler refresh and
 * the u16 watched-task warning live here so two web surfaces cannot drift.
 */
export async function applyOwnerLoopPatch(
  current: Loop,
  patch: OwnerLoopPatch,
  scheduler: SchedulerWriter,
): Promise<OwnerLoopMutation> {
  if (patch.name !== undefined && typeof patch.name !== "string") return { error: "name must be a string" };
  if (patch.cron !== undefined && typeof patch.cron !== "string") return { error: "cron must be a string" };
  if (patch.timezone !== undefined && patch.timezone !== null && typeof patch.timezone !== "string") return { error: "timezone must be a string or null" };
  if (patch.model !== undefined && patch.model !== null && typeof patch.model !== "string") return { error: "model must be a string or null" };
  if (patch.channelId !== undefined && patch.channelId !== null && typeof patch.channelId !== "string") return { error: "channelId must be a string or null" };
  if (patch.notify !== undefined && typeof patch.notify !== "string") return { error: "notify must be a string" };
  if (patch.name !== undefined && patch.name.trim().length > 200) return { error: "name is too long (max 200 characters)" };
  if (patch.cron !== undefined && (!patch.cron.trim() || patch.cron.trim().length > 200)) return { error: "cron is required and must be at most 200 characters" };
  if (patch.timezone !== undefined && (patch.timezone?.trim().length ?? 0) > 100) return { error: "timezone is too long (max 100 characters)" };
  if (patch.model !== undefined && (patch.model?.trim().length ?? 0) > 200) return { error: "model is too long (max 200 characters)" };
  if (patch.notify !== undefined && !["auto", "always", "never"].includes(patch.notify)) return { error: "notify must be auto, always, or never" };
  const workdirInput = (patch as OwnerLoopPatch & { workdir?: unknown }).workdir;
  const workdir = workdirInput !== undefined ? validateWorkdir(workdirInput) : undefined;
  if (workdir && !workdir.ok) return { error: workdir.error };

  const timezone = patch.timezone !== undefined ? patch.timezone?.trim() || null : current.timezone;
  const cron = patch.cron !== undefined ? patch.cron.trim() : current.cron;
  const cronError = validateCron(cron, timezone);
  if (cronError) return { error: `invalid cron or timezone: ${cronError}` };

  if (patch.channelId) {
    const channel = await store.getChannel(patch.channelId);
    if (!channel || channel.teamId !== current.teamId) return { error: "channel not found" };
  }

  const agent = patch.agent !== undefined ? coerceCodingAgent(patch.agent) : null;
  if (patch.agent !== undefined && !agent) return { error: "unknown coding agent" };

  const update: Partial<NewLoop> = {
    ...(patch.name !== undefined ? { name: patch.name.trim() || null } : {}),
    ...(patch.cron !== undefined ? { cron } : {}),
    ...(patch.timezone !== undefined ? { timezone } : {}),
    ...(patch.notify !== undefined ? { notify: patch.notify as "auto" | "always" | "never" } : {}),
    ...(patch.channelId !== undefined ? { channelId: patch.channelId || null } : {}),
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(agent ? { agent } : {}),
    ...(patch.goal !== undefined ? { goal: patch.goal?.trim() || null } : {}),
    ...(patch.taskFile !== undefined ? { taskFile: patch.taskFile.trim() || null } : {}),
    ...(workdir?.ok ? { workdir: workdir.value } : {}),
    ...(patch.workflow !== undefined ? { workflow: patch.workflow.trim() || null } : {}),
    ...(patch.stateSchema !== undefined ? { stateSchema: store.coerceStateSchema(patch.stateSchema) ?? null } : {}),
    ...(patch.ui !== undefined ? { ui: store.coerceUi(patch.ui) ?? null } : {}),
    ...(patch.exec?.workdir !== undefined ? { workdir: patch.exec.workdir.trim() || null } : {}),
    ...(patch.exec?.model !== undefined ? { model: patch.exec.model.trim() || null } : {}),
    ...(patch.exec?.allowControl !== undefined ? { allowControl: Boolean(patch.exec.allowControl) } : {}),
    ...(patch.model !== undefined ? { model: patch.model?.trim() || null } : {}),
  };

  const changed = Object.entries(update).some(([key, value]) => scalarChanged(current[key as keyof Loop], value));
  const loop = await store.updateLoop(current.id, update);
  if (!loop) return { error: "not found" };
  scheduler.addLoop(loop);

  const paused = patch.enabled === false && current.enabled;
  const warning = paused ? await watchedTasksWarningFor(loop.teamId, loop.id, "pause") : undefined;
  return { ok: true, loop, changed, ...(warning ? { warning } : {}) };
}
