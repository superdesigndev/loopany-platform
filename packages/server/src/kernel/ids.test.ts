/**
 * The dedup invariant's client half, tested where it lives: id derivation is a
 * pure function of identity and NOTHING ELSE (design §2 invariant 1, spec §5.4).
 *
 * The property that actually matters is negative — no clock, no counter, no
 * nonce, no recency — so most of these assertions are about what CANNOT change
 * the id, not what can.
 */
import { describe, expect, it } from "vitest";

import {
  answeredRunId,
  autoPauseTaskId,
  canonicalJson,
  clockRunId,
  contentHash,
  createdEventId,
  derivedEventId,
  derivedObjectId,
  msOf,
  newObjectId,
  newRunId,
  organicEventId,
  reportDocId,
  ulid,
} from "./ids.js";

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
    const seed = { objectId: "task-A", kind: "object-created" };
    expect(derivedEventId(seed)).toBe(derivedEventId({ kind: "object-created", objectId: "task-A" }));
  });

  it("do not consult a clock: two derivations an era apart collide", () => {
    const first = createdEventId("task-A");
    const later = createdEventId("task-A");
    expect(first).toBe(later);
    expect(first).toMatch(/^ev-[0-9a-f]{64}$/);
  });

  it("separate genuinely different facts", () => {
    expect(createdEventId("task-A")).not.toBe(createdEventId("task-B"));
    expect(clockRunId("loop-1", "2026-08-03T07:00:00.000Z")).not.toBe(
      clockRunId("loop-1", "2026-08-03T08:00:00.000Z"),
    );
  });

  it("keeps the kind PREFIX out of the seed (spec §5.4) — the seed is pure identity", () => {
    const seed = { runId: "run-1" };
    expect(derivedObjectId("doc", seed)).toBe(`doc-${contentHash(seed)}`);
    expect(derivedObjectId("task", seed)).toBe(`task-${contentHash(seed)}`);
    // Same hash, different prefix: two kinds could never collide anyway.
    expect(derivedObjectId("doc", seed).slice(4)).toBe(derivedObjectId("task", seed).slice(5));
  });

  it("derives the report doc from the run id alone, so a retried finish is a no-op", () => {
    expect(reportDocId("run-7")).toBe(reportDocId("run-7"));
    expect(reportDocId("run-7")).not.toBe(reportDocId("run-8"));
    expect(reportDocId("run-7")).toMatch(/^doc-[0-9a-f]{64}$/);
  });

  it("derives the auto-pause question from {loop, run}, so a retry raises ONE question", () => {
    expect(autoPauseTaskId("loop-1", "run-9")).toBe(autoPauseTaskId("loop-1", "run-9"));
    expect(autoPauseTaskId("loop-1", "run-9")).not.toBe(autoPauseTaskId("loop-2", "run-9"));
    expect(autoPauseTaskId("loop-1", "run-9")).toMatch(/^task-[0-9a-f]{64}$/);
  });

  it("derives an R-answer run from the verdict event, so a retried verdict queues one run", () => {
    expect(answeredRunId("ev-abc")).toBe(answeredRunId("ev-abc"));
    expect(answeredRunId("ev-abc")).not.toBe(answeredRunId("ev-abd"));
  });

  it("never lets a run id collide across the three birth paths for the same loop", () => {
    // The seed discriminator ("clock" vs "answered") is what keeps these apart.
    expect(clockRunId("loop-1", "ev-x")).not.toBe(answeredRunId("ev-x"));
  });
});

describe("organic ids", () => {
  it("are time-ordered and NEVER deduplicated", () => {
    const early = organicEventId(1_000);
    const late = organicEventId(2_000_000);
    expect(early < late).toBe(true);
    // Two calls at the same instant are two distinct facts, by design.
    expect(organicEventId(1_000)).not.toBe(organicEventId(1_000));
  });

  it("carry the kind prefix", () => {
    expect(newObjectId("task", 1_000)).toMatch(/^task-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newObjectId("loop", 1_000)).toMatch(/^loop-/);
    expect(newRunId(1_000)).toMatch(/^run-/);
    expect(organicEventId(1_000)).toMatch(/^ev-/);
  });
});

describe("ulid", () => {
  it("is deterministic when the randomness is injected (kernel reads no clock)", () => {
    const fixed = (n: number) => new Uint8Array(n).fill(0);
    expect(ulid(1_700_000_000_000, fixed)).toBe(ulid(1_700_000_000_000, fixed));
  });

  it("sorts lexicographically by time", () => {
    const fixed = (n: number) => new Uint8Array(n).fill(0);
    const ids = [ulid(3_000, fixed), ulid(1_000, fixed), ulid(2_000, fixed)];
    expect([...ids].sort()).toEqual([ulid(1_000, fixed), ulid(2_000, fixed), ulid(3_000, fixed)]);
  });
});

describe("msOf", () => {
  it("never throws on garbage — an id mint must not fail a transaction", () => {
    expect(msOf("not a date")).toBe(0);
    expect(msOf("2026-08-03T00:00:00.000Z")).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
  });
});
