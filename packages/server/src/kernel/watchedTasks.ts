/**
 * The u16 watched-task warning, on the PRODUCTION loop lifecycle (design report
 * §1.4 retire-freeze row + §5).
 *
 * A kernel task names its watcher by id and by nothing else. The three ways a
 * watcher stops acting — pause, closed-loop finish, hard delete — all inherit
 * the ruling the kernel's retired `retire` carried: **WARN with the count,
 * never block, never cascade.** Blocking would make a person's own operational
 * call unavailable because of a record the loop keeps about itself; cascading
 * would delete work nobody asked to delete.
 *
 * That is why `store.deleteLoop` deliberately does NOT grow an `objects`
 * cascade (pinned by a test). A deleted watcher DANGLES on purpose — there is
 * no FK — and the rest of the system already reads that fact honestly:
 * `loopRefs.ts` resolves it to a tombstone, the due scan skips it with one log
 * line and mutates nothing, and the repair is a transfer from the task drawer.
 *
 * Both halves live here so the count and the voice cannot drift between the
 * production surfaces that share them.
 */
import { and, count, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects } from "../db/kernel-schema.js";
import type { KernelExec } from "../db/kernelStore.js";
import type { WatchedTasksWarning } from "../types.js";

/** Every lifecycle move that stops a watcher acting without touching its tasks. */
export type WatchedTaskVerb = "pause" | "finish" | "delete";

/** A `warning`, never a `notice`: the move DID happen, and this is its
 *  consequence. The shape lives in `types.ts` because the web surfaces carry it
 *  to the client; this module is its only author. */
export type { WatchedTasksWarning };

/** Open tasks this loop is on the hook for — the warning's subject. Counted
 *  BEFORE the move, because the move changes nothing about them; that is
 *  precisely what the warning is for. */
export async function countOpenWatchedTasks(teamId: string | null, loopId: string, exec?: KernelExec): Promise<number> {
  // `loops.teamId` is nullable while every kernel object carries a team, so a
  // teamless loop can own no watched tasks. Answer 0 rather than drop the team
  // predicate — an unscoped count would read another team's rows.
  if (!teamId) return 0;
  const rows = await (exec ?? db)
    .select({ n: count() })
    .from(objects)
    .where(and(eq(objects.teamId, teamId), eq(objects.kind, "task"), eq(objects.status, "open"), eq(objects.watcher, loopId)));
  return Number(rows[0]?.n ?? 0);
}

/** What each verb leaves behind. The hint is the SAME repair in every case — a
 *  transfer or a close — because that is the only move that actually clears it. */
const CONSEQUENCE: Record<WatchedTaskVerb, (loopId: string, plural: string, them: string) => string> = {
  pause: (id, s, them) => `${id} was paused while still watching {n} open task${s}; ${them} wait${s ? "" : "s"} until it runs again or you transfer ${them}`,
  finish: (id, s, them) => `${id} finished while still watching {n} open task${s}; a completed loop is disabled, so ${them} wait${s ? "" : "s"} until you reopen it or transfer ${them}`,
  delete: (id, s, them) => `${id} was deleted while still watching {n} open task${s}; nothing will wake ${them} again, and each still names a loop that is gone`,
};

export function watchedTasksWarning(loopId: string, openTasks: number, verb: WatchedTaskVerb): WatchedTasksWarning {
  const plural = openTasks === 1 ? "" : "s";
  const them = openTasks === 1 ? "it" : "them";
  return {
    code: "TASKS_STILL_WATCHED",
    openTasks,
    message: CONSEQUENCE[verb](loopId, plural, them).replace("{n}", String(openTasks)),
    hint: `hand each one to a live loop with \`loopany task update <task-id> --watcher <loop-id>\`, or close it — \`loopany task list --watcher ${loopId}\` lists them`,
  };
}

/** Count and phrase in one step; `undefined` when there is nothing to warn
 *  about, so a caller spreads it and a clean move stays silent. */
export async function watchedTasksWarningFor(
  teamId: string | null,
  loopId: string,
  verb: WatchedTaskVerb,
  exec?: KernelExec,
): Promise<WatchedTasksWarning | undefined> {
  const open = await countOpenWatchedTasks(teamId, loopId, exec);
  return open ? watchedTasksWarning(loopId, open, verb) : undefined;
}
