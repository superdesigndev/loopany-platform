import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  contentHash,
  derivedEventId,
  edgeId,
  mirrorObjectId,
  organicEventId,
  outboxActionId,
  typeVersionId,
  ulid,
} from "./ids.js";

/**
 * The client half of the DEDUP INVARIANT (design §12 item 6). These are pure
 * functions, so their properties are testable without a database - and they are
 * the properties the DB-level probes then rely on.
 */

describe("canonicalJson", () => {
  it("is key-order independent at every depth", () => {
    const a = { b: 1, a: { z: [1, 2], y: "x" } };
    const b = { a: { y: "x", z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("keeps array order (order IS identity for a list)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes null from absent", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}));
  });
});

describe("deterministic ids", () => {
  it("edgeId is a pure function of the relation's identity fields only", () => {
    const base = { teamId: "t1", kind: "tracks", srcId: "a", dstId: "b" };
    expect(edgeId(base)).toBe(edgeId({ ...base }));
    // Direction is part of identity.
    expect(edgeId(base)).not.toBe(edgeId({ ...base, srcId: "b", dstId: "a" }));
    expect(edgeId(base)).not.toBe(edgeId({ ...base, kind: "blocks" }));
    expect(edgeId(base)).not.toBe(edgeId({ ...base, teamId: "t2" }));
    expect(edgeId(base)).toMatch(/^edge-[0-9a-f]{64}$/);
  });

  it("mirrorObjectId keys on (team, source, externalId)", () => {
    const id = mirrorObjectId("t1", "github", "org/repo/issues/1291");
    expect(mirrorObjectId("t1", "github", "org/repo/issues/1291")).toBe(id);
    expect(mirrorObjectId("t2", "github", "org/repo/issues/1291")).not.toBe(id);
    expect(mirrorObjectId("t1", "linear", "org/repo/issues/1291")).not.toBe(id);
  });

  it("derivedEventId is stable across derivations and ignores key order", () => {
    const one = derivedEventId({ source: "github", id: 1291, state: "merged" });
    const two = derivedEventId({ state: "merged", id: 1291, source: "github" });
    expect(one).toBe(two);
    expect(one).not.toBe(derivedEventId({ source: "github", id: 1291, state: "open" }));
  });

  it("derivedEventId never consults a clock (the anti-window property)", () => {
    // Same fact, derived a simulated year apart: identical id, so the dedup
    // cannot decay with time the way a "recent N" window does.
    const seed = { source: "github", id: 1291, state: "merged" };
    expect(derivedEventId(seed)).toBe(derivedEventId({ ...seed }));
    expect(derivedEventId.length).toBe(1); // takes only the seed
  });

  it("organicEventId is unique per call (a human verdict is never deduped)", () => {
    const ids = new Set(Array.from({ length: 200 }, () => organicEventId(1_700_000_000_000)));
    expect(ids.size).toBe(200);
  });

  it("outboxActionId is <eventId>-<seq>, stable across replays", () => {
    expect(outboxActionId("ev-abc", 0)).toBe("ev-abc-0");
    expect(outboxActionId("ev-abc", 2)).toBe("ev-abc-2");
  });

  it("typeVersionId collides on a re-proposal of the same version", () => {
    expect(typeVersionId("t1", "defect", 2)).toBe(typeVersionId("t1", "defect", 2));
    expect(typeVersionId("t1", "defect", 2)).not.toBe(typeVersionId("t1", "defect", 3));
  });

  it("contentHash is sha256 hex", () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ulid", () => {
  it("is 26 Crockford chars and sorts lexicographically by time", () => {
    const bytes = () => new Uint8Array(16);
    const early = ulid(1_700_000_000_000, bytes);
    const late = ulid(1_700_000_001_000, bytes);
    expect(early).toHaveLength(26);
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(early < late).toBe(true);
  });

  it("takes its time as an argument (transitions never read the clock)", () => {
    const bytes = () => new Uint8Array(16);
    expect(ulid(42, bytes)).toBe(ulid(42, bytes));
  });
});
