/**
 * Graph Engineering v3 - deterministic id minting.
 *
 * This module is the whole of the DEDUP INVARIANT's client half (design §12 item
 * 6): "a window is never a dedup key". Every re-derivable row's id is a pure
 * function of its own identity fields, so a re-derivation collides on a primary
 * key or a unique index and `ON CONFLICT DO NOTHING` swallows it. Nothing here
 * reads a clock or consults recent history, so correctness cannot degrade as the
 * event log grows - which is exactly the failure mode a "recent N" dedup has.
 *
 * Pure and dependency-free apart from `node:crypto`; unit-tested directly.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted at every depth, arrays kept in order.
 * Two structurally equal values always serialize to the same string, so hashing
 * it is a stable identity. `undefined` members are dropped (JSON semantics);
 * `null` is preserved and is NOT the same as absent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value) ?? "null";
}

/** sha256 hex of a canonicalized value. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ---- ULID (time-ordered, for organic ids) ----

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 10 chars of millisecond timestamp + 16 chars of randomness, Crockford
 * base32. Lexicographic order matches time order, so an append-only log sorts by
 * id. Hand-rolled (26 lines) rather than adding a dependency for it.
 *
 * `nowMs` is PASSED IN, never read here - transitions never read the clock
 * (design §12 item 8), and a test must be able to mint a deterministic id.
 *
 * NB: this is the non-monotonic variant. Two ULIDs minted in the same
 * millisecond are ordered arbitrarily relative to each other; `events.ts` is the
 * authority for ordering (via the `ts` column + insertion), so that is fine here.
 */
export function ulid(nowMs: number, random: (n: number) => Uint8Array = randomBytes): string {
  let t = Math.floor(nowMs);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = "";
  // Low 5 bits of each byte - uniform over the 32-char alphabet (no modulo bias).
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! & 31];
  return time + rand;
}

// ---- row ids ----

/** A fresh object id. Objects have no re-derivable identity in general; mirrors
 *  do, and use `mirrorObjectId` instead. */
export function newObjectId(nowMs: number): string {
  return `obj-${ulid(nowMs)}`;
}

/**
 * A mirror's id, derived from its external identity. Redundant with the partial
 * UNIQUE index on `(team, source, externalId)` ON PURPOSE: the index is the real
 * invariant (it also catches a row inserted with any other id), and the
 * deterministic primary key lets get-or-create be a plain `ON CONFLICT DO
 * NOTHING` on the PK rather than a partial-index conflict target.
 */
export function mirrorObjectId(teamId: string, externalSource: string, externalId: string): string {
  return `obj-mir-${contentHash({ teamId, externalSource, externalId })}`;
}

/**
 * An edge's id: `edge-<sha256(canonical fields)>` over EXACTLY the identity of
 * the relation. `meta` is excluded so annotating an edge never forks it.
 */
export function edgeId(input: { teamId: string; kind: string; srcId: string; dstId: string }): string {
  return `edge-${contentHash({ teamId: input.teamId, kind: input.kind, srcId: input.srcId, dstId: input.dstId })}`;
}

/**
 * A DERIVED event's id - for any fact that can be re-derived from the outside
 * world or from a replay (an observation, a backfill, a re-poll). The seed must
 * contain the fact's full identity and NOTHING that varies between derivations
 * (no clock, no attempt counter, no random nonce), or dedup silently stops
 * working while still looking correct.
 */
export function derivedEventId(seed: unknown): string {
  return `ev-${contentHash(seed)}`;
}

/**
 * An ORGANIC event's id - a genuinely new occurrence with no re-derivable
 * identity (a human verdict, an agent decision). Never deduplicated: two
 * identical-looking human verdicts a week apart are two real events.
 */
export function organicEventId(nowMs: number): string {
  return `ev-${ulid(nowMs)}`;
}

/** An outbox action's id: `<eventId>-<seq>`. Stable across replays by
 *  construction, which is what makes the executor's dedup-by-id work. */
export function outboxActionId(eventId: string, seq: number): string {
  return `${eventId}-${seq}`;
}

/**
 * A shepherd review task's id, derived from the ACTION that created it plus the
 * object it reviews.
 *
 * This is what makes the `enqueue-review` handler safe under the executor's
 * at-least-once boundary: the second delivery of the same action computes the
 * same id, finds the object already there, and creates nothing. Both halves of
 * the pair are load-bearing - the action id alone would collide across a fan-out
 * over several produced docs, and the target alone would collide across two
 * genuinely different review rounds on the same content.
 */
export function reviewObjectId(actionId: string, targetId: string): string {
  return `obj-rev-${contentHash({ actionId, targetId })}`;
}

/** A registry row's id - deterministic, so re-proposing the same version collides. */
export function typeVersionId(teamId: string, name: string, version: number): string {
  return `type-${contentHash({ teamId, name })}-v${version}`;
}
