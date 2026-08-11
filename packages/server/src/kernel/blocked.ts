/**
 * DISPATCH-BLOCKED VISIBILITY - the review's "never a silent pending state"
 * acceptance: an unknown or ambiguous assignee alias used to leave the run
 * pending with only a server-side log line the owner can never see. Now the
 * condition lands as a DURABLE NOTE EVENT on the task itself (through the
 * normal decide path, clock actor), so `show --log`, the Inbox, and any future
 * owner-notification surface all read it for free.
 *
 * DEDUP: the note embeds the RUN id as a marker; while the same run stays
 * blocked, repeated sweeps/polls write NOTHING new (at most ONE event per
 * blocked run - a 30s sweep must not spam the stream). A later fire is a new
 * run and legitimately gets its own event.
 *
 * Best-effort by design: a CAS loss or a vanished task skips silently - the
 * pending run itself is the durable state; this is only its visibility.
 */
import { decide, type Provenance, type RunRecord } from "@loopany/kernel";
import { logger } from "../logger.js";
import { applyChangesetForTeam, readEvents, readSnapshot } from "./store.js";
import { notifyKernelChangeset } from "./notify.js";

const CLOCK: Provenance = { entrance: "clock", actorId: "kernel-dispatch" };

export async function recordDispatchBlocked(teamId: string, run: RunRecord, reason: string): Promise<void> {
  try {
    const marker = `dispatch blocked (run ${run.id})`;
    const events = await readEvents(teamId);
    if (events.some((e) => e.objectId === run.taskId && (e.note ?? "").includes(marker))) return;
    const d = decide(
      { op: "note", id: run.taskId, note: `${marker}: ${reason}` },
      await readSnapshot(teamId),
      CLOCK,
      new Date().toISOString(),
    );
    if (!d.ok) return; // task deleted/renamed under us - nothing to surface on
    const applied = await applyChangesetForTeam(teamId, d.changeset); // CAS loss: another writer won; the next round retries
    // The blocked note doubles as the owner notification basis - notify exactly
    // when the (deduped) event actually landed, so at most one push per
    // blocked run and a fresh one only on a NEW run's new event.
    if (applied.ok) await notifyKernelChangeset(teamId, d.changeset);
  } catch (err) {
    logger.warn(
      { teamId, runId: run.id, err: err instanceof Error ? err.message : String(err) },
      "dispatch-blocked note failed (visibility only - the pending run is unaffected)",
    );
  }
}
