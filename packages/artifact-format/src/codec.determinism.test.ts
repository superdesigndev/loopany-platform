/**
 * STAGE 2 — serialization determinism and the parametrized key order.
 *
 * `serializeArtifact` must be a PURE FUNCTION OF THE DATA: equal data produces
 * identical bytes, independent of object insertion order and of the host's
 * locale. `CORE_FIELD_ORDER` is gone — a caller that wants a particular key
 * order asks for it with `keyOrder`, and the default is pure lexicographic.
 */

import { describe, expect, it } from "vitest";
import { parseArtifact } from "./parse.js";
import { serializeArtifact } from "./serialize.js";
import type { TargetDocument, TargetSerializeOptions } from "../test/target.js";

/** Emit and read back the top-level key order, without asserting on YAML
 *  formatting details the codec is free to choose. */
function headKeys(doc: TargetDocument, options?: TargetSerializeOptions): string[] {
  const head = serializeArtifact(doc, options).split("---\n")[1] as string;
  return head
    .split("\n")
    .filter((line) => /^[^\s#][^:]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")).replace(/^["']|["']$/g, ""));
}

const UNORDERED: TargetDocument = {
  frontMatter: { zebra: 1, alpha: 2, monkey: 3, kind: 4, state: 5 },
  body: "body\n",
};

describe("determinism", () => {
  it("is independent of key insertion order", () => {
    const forward: TargetDocument = { frontMatter: { a: 1, b: 2, c: 3 }, body: "x" };
    const reverse: TargetDocument = { frontMatter: { c: 3, b: 2, a: 1 }, body: "x" };
    expect(serializeArtifact(reverse)).toBe(serializeArtifact(forward));
  });

  it("is independent of insertion order at every depth", () => {
    const one: TargetDocument = { frontMatter: { outer: { b: 1, a: { y: 1, x: 2 } } }, body: "" };
    const two: TargetDocument = { frontMatter: { outer: { a: { x: 2, y: 1 }, b: 1 } }, body: "" };
    expect(serializeArtifact(two)).toBe(serializeArtifact(one));
  });

  it("produces identical bytes for deeply equal documents built differently", () => {
    const built: Record<string, unknown> = {};
    built["state"] = "draft";
    built["kind"] = "task";
    const literal = { kind: "task", state: "draft" };
    expect(serializeArtifact({ frontMatter: built, body: "" })).toBe(
      serializeArtifact({ frontMatter: literal, body: "" }),
    );
  });

  it("keeps list order — a list is ordered data, not a bag", () => {
    const doc: TargetDocument = { frontMatter: { items: ["c", "a", "b"] }, body: "" };
    expect(parseArtifact(serializeArtifact(doc)).frontMatter["items"]).toEqual(["c", "a", "b"]);
  });

  it("drops undefined values rather than emitting null", () => {
    const doc: TargetDocument = { frontMatter: { kind: "note", absent: undefined }, body: "" };
    expect(headKeys(doc)).toEqual(["kind"]);
    expect(parseArtifact(serializeArtifact(doc)).frontMatter).toEqual({ kind: "note" });
  });
});

describe("default order is pure lexicographic", () => {
  it("sorts top-level keys with no privileged names", () => {
    expect(headKeys(UNORDERED)).toEqual(["alpha", "kind", "monkey", "state", "zebra"]);
  });

  it("gives `type` and `status` no special position any more", () => {
    // v1 hoisted these; the codec has never heard of them.
    const doc: TargetDocument = { frontMatter: { zzz: 1, type: 2, aaa: 3, status: 4 }, body: "" };
    expect(headKeys(doc)).toEqual(["aaa", "status", "type", "zzz"]);
  });

  it("sorts nested mappings lexicographically too", () => {
    const doc: TargetDocument = { frontMatter: { outer: { zebra: 1, alpha: 2 } }, body: "" };
    const head = serializeArtifact(doc).split("---\n")[1] as string;
    expect(head.indexOf("alpha")).toBeLessThan(head.indexOf("zebra"));
  });
});

describe("code-unit comparison, never locale collation", () => {
  /** Keys chosen so that code-unit order and `localeCompare` order DISAGREE:
   *  by code unit `B`(66) < `a`(97) < `z`(122) < `ä`(228), while an English
   *  collation reports a < B and ä < z. */
  const CASE_SENSITIVE: TargetDocument = {
    frontMatter: { a: 1, B: 2, z: 3, "ä": 4 },
    body: "",
  };

  it("orders by code unit", () => {
    expect(headKeys(CASE_SENSITIVE)).toEqual(["B", "a", "z", "ä"]);
  });

  it("is a discriminating test: locale collation would order these differently", () => {
    // Guards the test itself — if this ever matched, the case above would pass
    // for a locale-sorting implementation and prove nothing.
    const byLocale = ["a", "B", "z", "ä"].slice().sort((x, y) => x.localeCompare(y));
    expect(byLocale).not.toEqual(["B", "a", "z", "ä"]);
  });

  it("orders punctuation and digits by code unit", () => {
    // `-`(45) < `0`(48) < `_`(95) < `a`(97); a collation typically ignores the
    // punctuation weight entirely.
    const doc: TargetDocument = { frontMatter: { a: 1, _b: 2, "0c": 3, "-d": 4 }, body: "" };
    expect(headKeys(doc)).toEqual(["-d", "0c", "_b", "a"]);
  });
});

describe("keyOrder", () => {
  it("emits listed keys first, in the given order", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["kind", "state"] })).toEqual([
      "kind",
      "state",
      "alpha",
      "monkey",
      "zebra",
    ]);
  });

  it("orders the remaining keys lexicographically", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["zebra"] })).toEqual(["zebra", "alpha", "kind", "monkey", "state"]);
  });

  it("honours the given order even when it is reverse-lexicographic", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["zebra", "monkey", "alpha"] })).toEqual([
      "zebra",
      "monkey",
      "alpha",
      "kind",
      "state",
    ]);
  });

  it("skips listed keys that the data does not have", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["missing", "kind", "alsoMissing", "state"] })).toEqual([
      "kind",
      "state",
      "alpha",
      "monkey",
      "zebra",
    ]);
  });

  it("never invents a key that the data does not have", () => {
    const text = serializeArtifact(UNORDERED, { keyOrder: ["notThere"] });
    expect(text).not.toContain("notThere");
    expect(parseArtifact(text).frontMatter).toEqual(UNORDERED.frontMatter);
  });

  it("collapses a duplicate entry to its first occurrence", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["state", "kind", "state"] })).toEqual([
      "state",
      "kind",
      "alpha",
      "monkey",
      "zebra",
    ]);
  });

  it("an empty keyOrder is the same as omitting it", () => {
    expect(serializeArtifact(UNORDERED, { keyOrder: [] })).toBe(serializeArtifact(UNORDERED));
  });

  it("listing every key puts the whole head under caller control", () => {
    expect(headKeys(UNORDERED, { keyOrder: ["zebra", "state", "monkey", "kind", "alpha"] })).toEqual([
      "zebra",
      "state",
      "monkey",
      "kind",
      "alpha",
    ]);
  });

  it("applies to the top level only — nested mappings stay lexicographic", () => {
    // A caller's presentation intent for the head must not reach down and
    // reorder a nested value that merely shares a key name.
    const doc: TargetDocument = {
      frontMatter: { outer: { zebra: 1, alpha: 2 }, alpha: 3, zebra: 4 },
      body: "",
    };
    const head = serializeArtifact(doc, { keyOrder: ["zebra", "outer"] }).split("---\n")[1] as string;
    expect(headKeys(doc, { keyOrder: ["zebra", "outer"] })).toEqual(["zebra", "outer", "alpha"]);
    // Inside `outer`, `alpha` still precedes `zebra`.
    const nested = head.slice(head.indexOf("outer:"));
    expect(nested.indexOf("alpha")).toBeLessThan(nested.indexOf("zebra"));
  });

  it("does not change the data — only its presentation", () => {
    const ordered = parseArtifact(serializeArtifact(UNORDERED, { keyOrder: ["state", "kind"] }));
    const plain = parseArtifact(serializeArtifact(UNORDERED));
    expect(ordered).toEqual(plain);
    expect(ordered).toEqual(UNORDERED);
  });

  it("is deterministic: the same keyOrder always yields the same bytes", () => {
    const options: TargetSerializeOptions = { keyOrder: ["state", "kind"] };
    const reversed: TargetDocument = {
      frontMatter: { state: 5, kind: 4, monkey: 3, alpha: 2, zebra: 1 },
      body: UNORDERED.body,
    };
    const forward: TargetDocument = {
      frontMatter: { zebra: 1, alpha: 2, monkey: 3, kind: 4, state: 5 },
      body: UNORDERED.body,
    };
    expect(serializeArtifact(reversed, options)).toBe(serializeArtifact(forward, options));
  });

  it("round-trips unchanged whatever the key order was", () => {
    for (const keyOrder of [undefined, ["kind"], ["state", "kind"], ["zebra", "monkey", "alpha", "kind", "state"]]) {
      const text = serializeArtifact(UNORDERED, keyOrder ? { keyOrder } : undefined);
      expect(parseArtifact(text)).toEqual(UNORDERED);
    }
  });
});
