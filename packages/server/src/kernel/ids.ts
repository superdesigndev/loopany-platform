/**
 * Rewrite kernel — deterministic id minting.
 *
 * PORTED from the graph line (`fm/graph-clockshadow-c1`, `src/graph/ids.ts`) for
 * the dedup invariant, then reshaped to the SHORT id the design always asked for.
 *
 * THE SHAPE (design §8, CLI spec §5.1): ids are server-issued and kind-prefixed —
 * `task-7f3a91`, `doc-2b8e04`, `loop-4c1d77`, `run-…`, `ev-9c22d1` — printed at
 * creation and carried on every list row, so **the agent never memorizes one**.
 * A 26-char ULID or a 64-char sha256 is hostile to exactly that audience: long to
 * type, expensive to carry in a prompt, and impossible to read back over a
 * sentence. Handle economy is the point, so the id is six lowercase hex.
 *
 * THE INVARIANT (design §2 invariant 1, spec §5.4): every re-derivable row's id
 * is a pure function of its own identity, so a re-derivation collides on the
 * primary key and `ON CONFLICT DO NOTHING` swallows it. **A window is never a
 * dedup key** — nothing here reads a clock, consults history or touches the
 * database, so correctness cannot degrade as the log grows or as a retry gets
 * slower. That is exactly the failure mode a "have I seen this in the last N?"
 * check has, and it fails at the worst moment (a slow retry after an outage).
 *
 * ---------------------------------------------------------------------------
 * THE COLLISION POSTURE — why organic and derived ids are NOT the same width
 * ---------------------------------------------------------------------------
 * A short id is a small space, so collisions are a design input, not an
 * afterthought. The two halves have opposite remedies, so they get opposite
 * widths:
 *
 *  - ORGANIC (`ORGANIC_HEX` = 6). A fresh random id carries no identity, so a
 *    collision is FIXED BY RE-MINTING: the insert is swallowed, the caller draws
 *    new randomness and tries again inside the same transaction
 *    (`ORGANIC_MINT_ATTEMPTS`; `organicWidth` widens the ladder after a run of
 *    misses, so a saturated space degrades rather than fails). Six hex is
 *    therefore free, and it is the shape the spec prints.
 *
 *  - DERIVED (`DERIVED_HEX` = 12). A derived id may NEVER be re-minted — being a
 *    pure function of the seed is the whole property replay idempotency rests on
 *    — so width is its ONLY remedy. And its failure mode is silent: two distinct
 *    seeds landing on one id would be swallowed by the same `ON CONFLICT DO
 *    NOTHING` that implements dedup, handing the caller somebody else's row.
 *    At 6 hex (16.7M values) the birthday-expected first collision per kind
 *    prefix is ~5,000 rows — routine, not exotic. At 12 hex (2.8e14) it is ~20
 *    million rows per prefix, while staying under half a ULID and a fifth of a
 *    full sha256. The deviation from the spec's printed six is deliberate and
 *    buys exactly one thing: safety for the id that cannot retry.
 *
 * THE TWO WIDTHS ARE DISJOINT, and that is load-bearing rather than incidental:
 * the organic ladder is {6, 10, 16} and no rung equals `DERIVED_HEX` (12), so an
 * organic id string can never equal a derived one. That closes the whole
 * cross-family channel — an organic mint landing on the value some later
 * derivation truncates to would make that derivation "replay" a stranger's row,
 * a silent merge with no remedy at all (an organic id carries no seed to compare
 * against). Adding a 12-hex rung would reopen it invisibly, so `ids.test.ts`
 * pins the disjointness.
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

// ---- the two widths ----

/** The designed shape: six lowercase hex after the kind prefix (`task-7f3a91`). */
export const ORGANIC_HEX = 6;

/** A derived id cannot be re-minted, so it buys its safety with width. */
export const DERIVED_HEX = 12;

/** How many times a caller re-mints an organic id before giving up. Eight is far
 *  past any plausible occupancy given the widening ladder below. */
export const ORGANIC_MINT_ATTEMPTS = 8;

/**
 * The organic widening ladder. The first three attempts mint the designed
 * six-hex shape; a RUN of collisions means the space is genuinely crowded rather
 * than unlucky, so the id widens instead of the mint failing. A pure function of
 * the attempt number, so a test can drive any rung.
 *
 * NO RUNG MAY EQUAL `DERIVED_HEX` — see the header; the disjointness is what
 * keeps an organic id from ever colliding with a derived one.
 *
 * THE TRIPWIRE. `attempt` is a retry rung, and it occupies the parameter slot
 * that used to carry a TIMESTAMP (`newObjectId(kind, nowMs)` and friends, before
 * the short-id reshape). Same type, opposite meaning — so a stale call site
 * passing `nowMs` compiles clean, resolves the top rung and mints 16-hex ids
 * forever, silently shipping the wrong id shape with nothing downstream ever
 * flagging it. The ladder's domain is `[0, ORGANIC_MINT_ATTEMPTS)`; anything
 * else is a caller bug and fails here, immediately and loudly.
 */
export function organicWidth(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= ORGANIC_MINT_ATTEMPTS) {
    throw new Error(
      `organic mint attempt must be an integer in [0, ${ORGANIC_MINT_ATTEMPTS}) — got ${attempt}. ` +
        "This parameter is a retry rung, not a timestamp.",
    );
  }
  if (attempt < 3) return ORGANIC_HEX;
  if (attempt < 6) return 10;
  return 16;
}

/** `chars` of lowercase hex drawn from INJECTED randomness — the kernel owns no
 *  entropy source of its own, which is what makes a mint seedable in a test. */
export function randomHex(chars: number, random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(Math.ceil(chars / 2));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out.slice(0, chars);
}

/** The suffix of an ORGANIC id at a given retry rung. */
export function organicSuffix(attempt = 0, random: (n: number) => Uint8Array = randomBytes): string {
  return randomHex(organicWidth(attempt), random);
}

/** The suffix of a DERIVED id: the leading `DERIVED_HEX` of sha256(seed). Pure —
 *  same seed, same suffix, forever, on any machine, in any process. */
export function derivedSuffix(seed: unknown): string {
  return contentHash(seed).slice(0, DERIVED_HEX);
}

// ---- object ids ----

/**
 * An ORGANIC object id — `<kind>-<6 hex>`. For an object with no re-derivable
 * identity: a task an agent decided to create, a doc it authored.
 *
 * `attempt` is the caller's retry counter: a swallowed insert means this id was
 * already taken, so the caller mints the next one rather than resolving the
 * stranger's row (`kernel/applyTransition.ts` `createObjectIn`).
 */
export function newObjectId(kind: ObjectKind, attempt = 0, random?: (n: number) => Uint8Array): string {
  return `${kind}-${organicSuffix(attempt, random)}`;
}

/**
 * A DERIVED object id — `<kind>-<12 hex of sha256(seed)>`. For an object a replay
 * or a retry can produce again: a run's report doc, the circuit breaker's
 * question.
 *
 * The KIND PREFIX is deliberately NOT part of the seed (spec §5.4): two ids of
 * different kinds could not collide anyway, and keeping the seed prefix-free
 * means a seed reads as pure identity.
 */
export function derivedObjectId(kind: ObjectKind, seed: unknown): string {
  return `${kind}-${derivedSuffix(seed)}`;
}



/**
 * A MIRROR's id — derived from `(team, kind, coords)`, because those three ARE
 * the mirror (`kernel/mirrors.ts`): the external thing's identity plus the scope
 * it is visible in. Two runs that both notice PR `owner/repo#57` therefore land
 * on ONE row and attach to it, rather than minting a second pointer at the same
 * thing that would then have to be kept in step.
 *
 * `teamId` is IN the seed even though the key index is already team-scoped. It
 * costs nothing and it makes the cross-team truncation collision unreachable by
 * construction rather than only caught by `createObjectIn`'s identity guard.
 */
export function mirrorObjectId(teamId: string, kind: string, coords: string): string {
  return derivedObjectId("mirror", { teamId, kind, coords, seed: "mirror" });
}

// ---- event ids ----

/**
 * A DERIVED event's id — for any fact a replay, a retry or the outside world can
 * produce again. The seed must contain the fact's full identity and NOTHING that
 * varies between derivations (no clock, no attempt counter, no random nonce), or
 * dedup silently stops working while still looking correct.
 */
export function derivedEventId(seed: unknown): string {
  return `ev-${derivedSuffix(seed)}`;
}

/**
 * An ORGANIC event's id — a genuinely new occurrence with no re-derivable
 * identity (a human verdict, an agent's update, a close). Never deduplicated:
 * two identical-looking patches a week apart are two real facts, and collapsing
 * them would erase history (spec §4.3).
 *
 * NOT time-ordered, and nothing depends on it being so. The append-only log's
 * ordering authority is `events.seq` (`db/kernel-schema.ts` says so in as many
 * words: "the content id dedups, the seq orders") and every reader already uses
 * it — `listObjectEvents`, `eventsAfter` and `eventTail` all sort by `seq`, and
 * the SSE resume cursor is a seq. The former ULID's lexicographic time-order was
 * incidental and unread; it was already absent from every derived event.
 */
export function organicEventId(attempt = 0, random?: (n: number) => Uint8Array): string {
  return `ev-${organicSuffix(attempt, random)}`;
}

/** The `object-created` event of any object (spec §5.4). Derived from the
 *  RESULTING object id, so even a racing double-create writes exactly one row. */
export function createdEventId(objectId: string): string {
  return derivedEventId({ objectId, kind: "object-created" });
}

// ---- run ids ----


/** An R-answer run's id — derived from the verdict event that woke it (§4.2), so
 *  a retried verdict transaction queues one run, not two. */
export function answeredRunId(verdictEventId: string): string {
  return `run-${derivedSuffix({ verdictEventId, seed: "answered" })}`;
}

/**
 * An R-DIRECTIVE run's id — derived from the directive event that woke it, the
 * exact shape `answeredRunId` uses, so a retried `task tell` transaction queues
 * one run rather than two. The SEED differs (`directive`, not `answered`), which
 * is what keeps the two families from ever truncating onto each other's ids even
 * if an event id were somehow reused across them.
 */
export function directiveRunId(directiveEventId: string): string {
  return `run-${derivedSuffix({ directiveEventId, seed: "directive" })}`;
}

/**
 * An R-DUE run's id — a watched task whose `follow_up` arrived woke its watcher.
 *
 * The seed is `{loopId, taskId, followUpAt}`, and every part of it is
 * load-bearing. `followUpAt` is the FOLLOW-UP INSTANT, never "now" at fire time,
 * for the same reason `clockRunId` uses the cron occurrence: the due condition is
 * LEVEL-triggered, so the same task is still due on every tick until a run lands.
 * Including the instant makes those ticks re-derive ONE id (the second is a
 * replay, swallowed) while a RE-ARMED follow-up — the ordinary way a loop says
 * "look at this again in three days" — is a different instant and therefore a
 * genuinely fresh run. `taskId` is in the seed because one loop can have several
 * tasks come due at the same moment and each is its own scoped run.
 */
export function dueRunId(loopId: string, taskId: string, followUpAt: string): string {
  return `run-${derivedSuffix({ loopId, taskId, followUpAt, seed: "due" })}`;
}

/** A manually fired run — an organic occurrence (a person pressed the button
 *  twice on purpose is two real facts; the transactional open-run join bounds
 *  simultaneous presses). */
export function newRunId(attempt = 0, random?: (n: number) => Uint8Array): string {
  return `run-${organicSuffix(attempt, random)}`;
}
