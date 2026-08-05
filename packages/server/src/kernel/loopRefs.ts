/**
 * THE LOOP REFERENCE — one resolver for every `watcher` / `created_by_loop` id
 * in the system.
 *
 * Convergence made the SHIPPING product's `loops` row THE loop: `objects.watcher`
 * and `objects.createdByLoop` are plain text references to one. Every surface
 * that turns such an id into a NAME reads through here, so there is exactly one
 * place that knows what a dangling reference means.
 *
 * Three rulings are welded in, and each is the kind a later "helpful" change
 * breaks by softening it:
 *
 *  1. **LOOP IDS ARE USED AS-IS — there is no alias table.** A loop minted by
 *     the shipping product (`loop-mqkxn6lq-4c81d1b2`) and one a converged kernel
 *     loop kept verbatim (`loop-605e39`) are both opaque `loop-` prefixed text,
 *     and every shape check is a prefix check. A second id namespace would be
 *     permanent drift; the mixed world is paid for with a name-first RENDER
 *     instead (design report §6).
 *  2. **RESOLUTION IS NOT VALIDATION, and a dangling watcher is LEGAL.** There is
 *     deliberately no foreign key and no existence check at the write seam: a
 *     prod loop can be hard-deleted (`store.deleteLoop`) while tasks still name
 *     it, and the ruling is warn-never-block-never-cascade. The reference then
 *     DANGLES, which is a real fact about the world rather than a broken row — so
 *     it resolves to a TOMBSTONE ref (`source: "missing"`) that read surfaces
 *     render as `deleted loop loop-…`, never to `null` (which reads as "no
 *     watcher", a state the watcher rule abolished) and never to a refusal.
 *  3. **ENABLED OR NOT.** A paused/disabled/completed prod loop still resolves and
 *     still renders its name — the `enabled` gate belongs to the DUE SCAN (report
 *     §1.2.5), not to reading. What enablement does change is `assignable`: a loop
 *     that can never act again is not offered as a hand-off target.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { loops, type Loop } from "../db/schema.js";

/** Whether the roster answered. `missing` is the tombstone — see ruling 2. The
 *  key is retained (rather than collapsing to a boolean) because every wire
 *  consumer already renders on it. */
export type LoopSource = "prod" | "missing";

/** The resolved loop, as every consumer needs it. `status` is rendered, never
 *  branched on for authority: the one decision a caller actually makes rides
 *  `assignable`. */
export interface LoopRecord {
  id: string;
  title: string | null;
  source: LoopSource;
  status: string;
  cron: string | null;
  /** May a task be HANDED to this loop? False for a COMPLETED loop (its goal is
   *  met and it is stamped done). A merely paused/disabled loop IS assignable —
   *  it wakes on resume, which is the whole point of the level trigger. */
  assignable: boolean;
}

/** The wire shape a card/row carries for its watcher or creator. */
export interface LoopRefWire {
  id: string;
  title: string | null;
  source: LoopSource;
}

/** Every loop id in a team, resolved once. A Map, because every caller looks up
 *  a handful of ids out of a set it already had to load whole. */
export type LoopIndex = Map<string, LoopRecord>;

/**
 * The prod row, in the kernel's vocabulary.
 *
 * `completedAt` is a CLOSED loop's finish line (`goal` met), not a retirement:
 * the charter is not frozen and the owner can reopen it by re-enabling. It is
 * still not a hand-off target, because handing work to a loop that has declared
 * itself done is how a task goes quiet forever.
 */
export function prodLoopRecord(row: Loop): LoopRecord {
  const completed = row.completedAt != null;
  return {
    id: row.id,
    title: row.name,
    source: "prod",
    status: completed ? "completed" : row.enabled ? "active" : "paused",
    cron: row.cron,
    assignable: !completed,
  };
}

/**
 * THE TOMBSTONE. Not an error and not an absence: the id was really written by
 * somebody, and the loop it named is really gone (report §5). Rendering it as a
 * fact is what makes "no FK, never cascade" honest rather than silently lossy.
 */
export function missingLoopRecord(id: string): LoopRecord {
  return { id, title: null, source: "missing", status: "missing", cron: null, assignable: false };
}

/** The production roster is the roster. */
export async function loadTeamLoopIndex(teamId: string): Promise<LoopIndex> {
  const prodRows = await db.select().from(loops).where(eq(loops.teamId, teamId));
  const index: LoopIndex = new Map();
  for (const row of prodRows) index.set(row.id, prodLoopRecord(row));
  return index;
}

/** One id, without loading the team. */
export async function resolveLoopRecord(teamId: string, id: string): Promise<LoopRecord | undefined> {
  const prodRow = await getProdLoop(teamId, id);
  return prodRow ? prodLoopRecord(prodRow) : undefined;
}

/** The raw production row — the loop page needs its cadence, its bound directory
 *  and its task file, none of which fit the reference shape. Team-scoped, so a
 *  cross-team id is indistinguishable from a missing one. */
export async function getProdLoop(teamId: string, id: string): Promise<Loop | undefined> {
  return (await db.select().from(loops).where(and(eq(loops.teamId, teamId), eq(loops.id, id))))[0];
}

/**
 * Resolve a reference for the wire. `null` in ⇒ `null` out (a doc has no creator
 * loop when a person wrote it); an id that resolves to nothing is a TOMBSTONE,
 * never `null` — the two mean opposite things and the UI renders them apart.
 */
export function loopRefOf(id: string | null | undefined, index: LoopIndex): LoopRefWire | null {
  if (!id) return null;
  const found = index.get(id) ?? missingLoopRecord(id);
  return { id: found.id, title: found.title, source: found.source };
}

/** The hand-off picker's roster, ordered by the label a person actually reads. */
export function assignableLoops(index: LoopIndex): { id: string; title: string | null }[] {
  return [...index.values()]
    .filter((loop) => loop.assignable)
    .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id) || a.id.localeCompare(b.id))
    .map((loop) => ({ id: loop.id, title: loop.title }));
}
