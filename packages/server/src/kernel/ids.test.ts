/**
 * The dedup invariant's client half, tested where it lives: id derivation is a
 * pure function of identity and NOTHING ELSE (design §2 invariant 1, spec §5.4).
 *
 * The property that actually matters is negative — no clock, no counter, no
 * nonce, no recency — so most of these assertions are about what CANNOT change
 * the id, not what can.
 *
 * Since the ids are now SHORT (design §8 / CLI spec §5.1), the second half of
 * this file pins the COLLISION POSTURE the shortness buys: an organic id is
 * re-mintable and therefore cheap at six hex; a derived id is not re-mintable at
 * all, so it is twelve. The database-side half of that posture — a collision
 * being retried rather than resolved into a stranger's row — lives in
 * `idCollision.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  DERIVED_HEX,
  ORGANIC_HEX,
  ORGANIC_MINT_ATTEMPTS,
  answeredRunId,
  autoPauseTaskId,
  canonicalJson,
  clockRunId,
  contentHash,
  createdEventId,
  derivedEventId,
  derivedObjectId,
  derivedSuffix,
  newObjectId,
  newRunId,
  organicEventId,
  organicSuffix,
  organicWidth,
  randomHex,
  reportDocId,
} from "./ids.js";

/** Deterministic randomness: byte i is i, so a mint is reproducible in a test. */
const counting = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i));

describe("canonicalJson", () => {
  it("sorts object keys at every depth so structural equals hash equal", () => {
    const a = { b: 1, a: { z: [1, 2], y: "x" } };
    const b = { a: { y: "x", z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("keeps array ORDER (a list is not a set)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined but preserves null — absent is not the same as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: null }));
  });

  it("normalizes non-finite numbers rather than emitting invalid JSON", () => {
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
    expect(canonicalJson({ n: Infinity })).toBe('{"n":null}');
  });
});

describe("derived ids", () => {
  it("are a pure function of the seed — same seed, same id, forever", () => {
    const seed = { objectId: "task-7f3a91", kind: "object-created" };
    expect(derivedEventId(seed)).toBe(derivedEventId({ kind: "object-created", objectId: "task-7f3a91" }));
  });

  it("do not consult a clock: two derivations an era apart collide", () => {
    const first = createdEventId("task-7f3a91");
    const later = createdEventId("task-7f3a91");
    expect(first).toBe(later);
    expect(first).toMatch(/^ev-[0-9a-f]{12}$/);
  });

  it("separate genuinely different facts", () => {
    expect(createdEventId("task-7f3a91")).not.toBe(createdEventId("task-2b8e04"));
    expect(clockRunId("loop-4c1d77", "2026-08-03T07:00:00.000Z")).not.toBe(
      clockRunId("loop-4c1d77", "2026-08-03T08:00:00.000Z"),
    );
  });

  it("keeps the kind PREFIX out of the seed (spec §5.4) — the seed is pure identity", () => {
    const seed = { runId: "run-4a19c2" };
    expect(derivedObjectId("doc", seed)).toBe(`doc-${derivedSuffix(seed)}`);
    expect(derivedObjectId("task", seed)).toBe(`task-${derivedSuffix(seed)}`);
    // Same suffix, different prefix: two kinds could never collide anyway.
    expect(derivedObjectId("doc", seed).slice(4)).toBe(derivedObjectId("task", seed).slice(5));
  });

  it("derives the report doc from the run id alone, so a retried finish is a no-op", () => {
    expect(reportDocId("run-4a19c2")).toBe(reportDocId("run-4a19c2"));
    expect(reportDocId("run-4a19c2")).not.toBe(reportDocId("run-8b02de"));
    expect(reportDocId("run-4a19c2")).toMatch(/^doc-[0-9a-f]{12}$/);
  });

  it("derives the auto-pause question from {loop, run}, so a retry raises ONE question", () => {
    expect(autoPauseTaskId("loop-4c1d77", "run-4a19c2")).toBe(autoPauseTaskId("loop-4c1d77", "run-4a19c2"));
    expect(autoPauseTaskId("loop-4c1d77", "run-4a19c2")).not.toBe(autoPauseTaskId("loop-2e70b8", "run-4a19c2"));
    expect(autoPauseTaskId("loop-4c1d77", "run-4a19c2")).toMatch(/^task-[0-9a-f]{12}$/);
  });

  it("derives an R-answer run from the verdict event, so a retried verdict queues one run", () => {
    expect(answeredRunId("ev-9c22d1")).toBe(answeredRunId("ev-9c22d1"));
    expect(answeredRunId("ev-9c22d1")).not.toBe(answeredRunId("ev-9c22d2"));
    expect(answeredRunId("ev-9c22d1")).toMatch(/^run-[0-9a-f]{12}$/);
  });

  it("never lets a run id collide across the three birth paths for the same loop", () => {
    // The seed discriminator ("clock" vs "answered") is what keeps these apart.
    expect(clockRunId("loop-4c1d77", "ev-9c22d1")).not.toBe(answeredRunId("ev-9c22d1"));
  });
});

/**
 * THE DERIVED COLLISION POSTURE. A derived id may never be re-minted — being a
 * pure function of its seed IS replay idempotency — so truncation width is its
 * only remedy, and the width is therefore part of the contract rather than an
 * implementation detail.
 */
describe("derived id width (the collision posture)", () => {
  it("is the leading DERIVED_HEX of the full sha256, so a seed's id is stable forever", () => {
    const seed = { runId: "run-4a19c2", seed: "report" };
    expect(derivedSuffix(seed)).toBe(contentHash(seed).slice(0, DERIVED_HEX));
    expect(DERIVED_HEX).toBe(12);
  });

  it("is WIDER than the organic shape, because a derived id cannot retry", () => {
    // Six hex (16.7M) sees a birthday-expected first collision at ~5,000 rows,
    // and a derived collision is SILENT — swallowed by the same `ON CONFLICT DO
    // NOTHING` that implements dedup. Organic ids are cheap at six because a
    // collision is simply re-minted (see the ladder below).
    expect(DERIVED_HEX).toBeGreaterThan(ORGANIC_HEX);
  });

  it("separates a large sample of distinct seeds with no truncation collision", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(reportDocId(`run-${i}`));
    expect(seen.size).toBe(20_000);
  });
});

describe("organic ids", () => {
  it("are NEVER deduplicated — two calls are two distinct facts, by design", () => {
    expect(organicEventId()).not.toBe(organicEventId());
    expect(newObjectId("task")).not.toBe(newObjectId("task"));
  });

  it("carry the kind prefix and the designed six-hex shape", () => {
    expect(newObjectId("task")).toMatch(/^task-[0-9a-f]{6}$/);
    expect(newObjectId("doc")).toMatch(/^doc-[0-9a-f]{6}$/);
    expect(newObjectId("loop")).toMatch(/^loop-[0-9a-f]{6}$/);
    expect(newRunId()).toMatch(/^run-[0-9a-f]{6}$/);
    expect(organicEventId()).toMatch(/^ev-[0-9a-f]{6}$/);
  });

  it("are deterministic when the randomness is injected (the kernel owns no entropy)", () => {
    expect(newObjectId("task", 0, counting)).toBe(newObjectId("task", 0, counting));
    expect(newObjectId("task", 0, counting)).toBe("task-000102");
    expect(organicEventId(0, counting)).toBe("ev-000102");
    expect(newRunId(0, counting)).toBe("run-000102");
    expect(randomHex(4, counting)).toBe("0001");
  });
});

/**
 * THE ORGANIC MINT LADDER. A short random id collides eventually; the remedy is
 * fresh randomness, and a RUN of collisions means the space is genuinely crowded
 * rather than unlucky, so the id widens instead of the mint failing.
 */
describe("the organic widening ladder", () => {
  it("holds the designed six-hex shape for the first attempts", () => {
    expect(organicWidth(0)).toBe(ORGANIC_HEX);
    expect(organicWidth(2)).toBe(ORGANIC_HEX);
    expect(organicSuffix(2, counting)).toHaveLength(ORGANIC_HEX);
  });

  it("widens, monotonically, once a run of attempts has missed", () => {
    const widths = Array.from({ length: ORGANIC_MINT_ATTEMPTS }, (_, i) => organicWidth(i));
    expect(widths).toEqual([6, 6, 6, 10, 10, 10, 16, 16]);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
  });

  it("mints the widened shape at the higher rungs", () => {
    expect(organicSuffix(3, counting)).toMatch(/^[0-9a-f]{10}$/);
    expect(organicSuffix(6, counting)).toMatch(/^[0-9a-f]{16}$/);
    expect(newObjectId("task", 6, counting)).toMatch(/^task-[0-9a-f]{16}$/);
  });

  it("bounds the retry — the ladder is finite, so an exhausted mint fails loudly", () => {
    expect(ORGANIC_MINT_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isInteger(ORGANIC_MINT_ATTEMPTS)).toBe(true);
  });
});
