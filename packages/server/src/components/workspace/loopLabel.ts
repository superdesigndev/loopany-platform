import type { LoopRef } from './api'

/**
 * HOW A LOOP REFERENCE READS. Pure, so the three screens that print a watcher or
 * a creator cannot each answer it differently.
 *
 * Convergence stage S1 made `watcher` / `created_by_loop` span two worlds — a
 * kernel loop object and a production `loops` row — and gave the server's
 * resolver a third answer: `source: 'missing'`, the TOMBSTONE. A prod loop can be
 * hard-deleted while tasks still name it (no foreign key, warn-never-block-never-
 * cascade), so a dangling reference is a real fact rather than a broken row, and
 * the honest render is to say the loop is gone rather than to print a bare id
 * that looks like any other.
 *
 * The name-first rule (design report §6) lives here too: a mixed id world is
 * paid for by rendering the NAME wherever there is one, and falling back to the
 * id only when there is not.
 */
export function loopLabel(ref: LoopRef | undefined, fallbackId?: string | null): string {
  const id = ref?.id ?? fallbackId ?? ''
  if (ref?.source === 'missing') return `deleted loop ${id}`
  return ref?.title ?? id
}

/** True when the reference points at a loop that is no longer there. Its own
 *  predicate because a tombstone is not clickable: there is no page to open. */
export function isDeletedLoop(ref: LoopRef | undefined): boolean {
  return ref?.source === 'missing'
}
