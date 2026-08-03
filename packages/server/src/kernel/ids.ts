/**
 * Rewrite kernel — deterministic id minting.
 *
 * PORTED nearly as-is from the graph line (`fm/graph-clockshadow-c1`,
 * `src/graph/ids.ts`), which is the harvest the design names: the dedup
 * invariant survived that build's adversarial E2E, so the pattern is carried
 * forward rather than re-derived. What changed: ids are KIND-PREFIXED
 * (`task-`/`doc-`/`loop-`/`run-`/`ev-`) per design §8, and the graph-specific
 * mints (mirrors, edges, outbox actions, the type registry) are gone.
 *
 * THE INVARIANT (design §2 invariant 1, spec §5.4): every re-derivable row's id
 * is a pure function of its own identity, so a re-derivation collides on the
 * primary key and `ON CONFLICT DO NOTHING` swallows it. **A window is never a
 * dedup key** — nothing here reads a clock or consults recent history, so
 * correctness cannot degrade as the log grows or as a retry gets slower. That is
 * exactly the failure mode a "have I seen this in the last N?" check has, and it
 * fails at the worst moment (a slow retry after an outage).
 *
 * Pure and dependency-free apart from `node:crypto`; unit-tested directly.
 */
import { createHash, randomBytes } from "node:crypto";

import type { ObjectKind } from "./types.js";

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
 * `nowMs` is PASSED IN, never read here — the kernel never reads a clock (spec
 * §4 header), which is what makes history seedable and tests deterministic.
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
  // Low 5 bits of each byte — uniform over the 32-char alphabet (no modulo bias).
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! & 31];
  return time + rand;
}

/** Milliseconds of an ISO timestamp; 0 for anything unparseable (never throws —
 *  an id mint must not be the thing that fails a transaction). */
export function msOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

// ---- object ids ----

/**
 * An ORGANIC object id — `<kind>-<ulid>`. For an object with no re-derivable
 * identity: a task an agent decided to create, a doc it authored.
 */
export function newObjectId(kind: ObjectKind, nowMs: number): string {
  return `${kind}-${ulid(nowMs)}`;
}

/**
 * A DERIVED object id — `<kind>-<sha256hex(seed)>`. For an object a replay or a
 * retry can produce again: a run's report doc, the circuit breaker's question.
 *
 * The KIND PREFIX is deliberately NOT part of the seed (spec §5.4): two ids of
 * different kinds could not collide anyway, and keeping the seed prefix-free
 * means a seed reads as pure identity.
 */
export function derivedObjectId(kind: ObjectKind, seed: unknown): string {
  return `${kind}-${contentHash(seed)}`;
}

/**
 * The doc a run's report becomes (spec §5.4, §4.5 step 2). Keyed off the run id,
 * which is fixed before the run starts, so the whole report-back path is
 * replay-safe by construction rather than by a "have I seen this run?" lookup.
 */
export function reportDocId(runId: string): string {
  return derivedObjectId("doc", { runId, seed: "report" });
}

/**
 * The circuit breaker's question (spec §5.4, §6.6). Derived from the loop, the
 * failing run and a fixed discriminator, so a retried `finish` re-derives it and
 * raises ONE question, not two.
 */
export function autoPauseTaskId(loopId: string, runId: string): string {
  return derivedObjectId("task", { loopId, runId, seed: "autopause" });
}

// ---- event ids ----

/**
 * A DERIVED event's id — for any fact a replay, a retry or the outside world can
 * produce again. The seed must contain the fact's full identity and NOTHING that
 * varies between derivations (no clock, no attempt counter, no random nonce), or
 * dedup silently stops working while still looking correct.
 */
export function derivedEventId(seed: unknown): string {
  return `ev-${contentHash(seed)}`;
}

/**
 * An ORGANIC event's id — a genuinely new occurrence with no re-derivable
 * identity (a human verdict, an agent's update, a close). Never deduplicated:
 * two identical-looking patches a week apart are two real facts, and collapsing
 * them would erase history (spec §4.3).
 */
export function organicEventId(nowMs: number): string {
  return `ev-${ulid(nowMs)}`;
}

/** The `object-created` event of any object (spec §5.4). Derived from the
 *  RESULTING object id, so even a racing double-create writes exactly one row. */
export function createdEventId(objectId: string): string {
  return derivedEventId({ objectId, kind: "object-created" });
}

// ---- run ids ----

/** A clock fire's run id — `{loopId, scheduledFor}` (spec §5.4). `scheduledFor`
 *  is the cron OCCURRENCE instant, never "now" at fire time: a crash between the
 *  fire commit and the cursor advance re-derives the same id on retry. */
export function clockRunId(loopId: string, scheduledFor: string): string {
  return `run-${contentHash({ loopId, scheduledFor, seed: "clock" })}`;
}

/** An R-answer run's id — derived from the verdict event that woke it (§4.2), so
 *  a retried verdict transaction queues one run, not two. */
export function answeredRunId(verdictEventId: string): string {
  return `run-${contentHash({ verdictEventId, seed: "answered" })}`;
}

/** A manually fired run — an organic occurrence (a person pressed the button
 *  twice on purpose is two real facts; the one-queued-run index bounds it). */
export function newRunId(nowMs: number): string {
  return `run-${ulid(nowMs)}`;
}
