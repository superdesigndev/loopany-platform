/**
 * STAGE 2 — round-trip laws and body byte-exactness.
 *
 * The codec's central promise: parse and serialize are deterministic inverses,
 * and the body is carried through untouched. Nothing here knows what an
 * artifact MEANS; these are laws about bytes and values.
 */

import { describe, expect, it } from "vitest";
import { file } from "../test/assert.js";
import { parseArtifact } from "./parse.js";
import { serializeArtifact } from "./serialize.js";
import type { TargetDocument } from "../test/target.js";

/** A document that exercises every value shape the codec must carry: scalars
 *  of each type, nesting, lists, and keys with no meaning to the library. */
const RICH: TargetDocument = {
  frontMatter: {
    kind: "task",
    state: "in-progress",
    ordinal: 42,
    ratio: 0.5,
    armed: false,
    nothing: null,
    tags: ["alpha", "beta"],
    nested: { inner: { leaf: "value" }, list: [{ a: 1 }, { b: 2 }] },
  },
  body: "\n# A heading\n\nSome body prose.\n",
};

describe("round-trip laws", () => {
  it("parse(serialize(doc)) deep-equals doc", () => {
    expect(parseArtifact(serializeArtifact(RICH))).toEqual(RICH);
  });

  it("serialize(parse(text)) is byte-stable under repetition", () => {
    const once = serializeArtifact(RICH);
    const twice = serializeArtifact(parseArtifact(once));
    const thrice = serializeArtifact(parseArtifact(twice));
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it("re-serializing a parsed file is a fixed point", () => {
    const text = serializeArtifact(RICH);
    expect(serializeArtifact(parseArtifact(serializeArtifact(parseArtifact(text))))).toBe(text);
  });

  it("carries every scalar type through unchanged", () => {
    const doc: TargetDocument = {
      frontMatter: {
        str: "text",
        int: 7,
        negative: -3,
        float: 1.25,
        yes: true,
        no: false,
        nil: null,
        emptyString: "",
        emptyList: [],
        emptyMap: {},
      },
      body: "",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("round-trips values that could be mistaken for YAML syntax", () => {
    const doc: TargetDocument = {
      frontMatter: {
        colons: "value: with: colons",
        hash: "trailing # not a comment",
        dashes: "- not a list item",
        braces: "{not: flow}",
        quoted: '"already quoted"',
        multiline: "line one\nline two\n",
        looksNumeric: "0123",
        looksBool: "true",
        looksNull: "null",
        indented: "  leading spaces preserved",
      },
      body: "",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("round-trips non-ASCII keys and values", () => {
    // Non-ASCII coverage is the point of this case, so the literals are not English.
    const doc: TargetDocument = {
      frontMatter: { 标题: "巡检报告", emoji: "🚀", accented: "café — naïve" },
      body: "本文内容\n",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });
});

describe("body byte-exactness", () => {
  /** The body is opaque text: whatever bytes sat after the closing delimiter
   *  come back identical, with no trimming, padding, or line-ending rewriting. */
  const bodies: Array<[name: string, body: string]> = [
    ["empty", ""],
    ["the customary leading blank line", "\n# Heading\n"],
    ["no separator line at all", "# Heading\n"],
    ["several trailing newlines", "text\n\n\n"],
    ["no trailing newline", "text"],
    ["trailing spaces on a line", "text with trailing spaces   \nnext\n"],
    ["only whitespace", "   \n\t\n"],
    ["CRLF line endings in the content", "line one\r\nline two\r\n"],
    ["a lone carriage return", "line one\rstill line one\n"],
    ["tabs and form feeds", "a\tb\fc\n"],
    ["delimiter-looking lines", "\nintro\n\n---\nkind: injected\n---\n\noutro\n"],
    ["a leading delimiter line", "---\nnot front matter\n"],
    ["non-ASCII content", "日本語の本文\n"],
    ["a very long single line", `${"x".repeat(20_000)}\n`],
  ];

  for (const [name, body] of bodies) {
    it(`preserves a body with ${name}`, () => {
      const doc: TargetDocument = { frontMatter: { kind: "note" }, body };
      const text = serializeArtifact(doc);
      expect(parseArtifact(text).body).toBe(body);
      expect(parseArtifact(text)).toEqual(doc);
    });
  }

  it("reads the body straight from the source file, not from a re-render", () => {
    const body = "\n  indented   \n\n\ttabbed\n\n";
    expect(parseArtifact(file("kind: note", body)).body).toBe(body);
  });

  it("never lets the body influence the front matter", () => {
    // Only the FIRST closing delimiter closes the head, which is what makes a
    // `---` in the body inert rather than a front-matter injection point.
    const doc = parseArtifact(file("kind: note\nstate: draft", "\nintro\n\n---\nstate: approved\n---\n"));
    expect(doc.frontMatter["state"]).toBe("draft");
    expect(doc.body).toContain("state: approved");
  });

  it("does not parse, render, or normalize the body", () => {
    // Markdown, HTML and raw script text are all just bytes to the codec.
    const body = "<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(parseArtifact(file("kind: note", body)).body).toBe(body);
  });
});

describe("unknown-key pass-through", () => {
  /** Domain schema left the library: at this level EVERY key is unknown, and
   *  preserving it verbatim is the correct behavior rather than a fallback. */
  it("preserves arbitrary keys through parse and serialize", () => {
    const doc: TargetDocument = {
      frontMatter: {
        aPlainKey: 1,
        "dash-separated": 2,
        under_scored: 3,
        "dotted.key": 4,
        "123numeric": 5,
        "key with spaces": 6,
        UPPER: 7,
      },
      body: "",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("preserves keys that name inherited object members", () => {
    // Plain assignment would send these to Object.prototype's setter or shadow
    // a built-in; they must land as ordinary own properties.
    const doc: TargetDocument = {
      // NB the computed key: a bare `__proto__:` in an object literal sets the
      // prototype instead of creating an own property, so it would not test
      // what this case is about.
      frontMatter: { ["__proto__"]: { polluted: true }, constructor: "text", toString: "text", hasOwnProperty: 1 },
      body: "",
    };
    const round = parseArtifact(serializeArtifact(doc));
    expect(Object.keys(round.frontMatter).sort()).toEqual(
      ["__proto__", "constructor", "hasOwnProperty", "toString"].sort(),
    );
    expect(round.frontMatter).toEqual(doc.frontMatter);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("preserves a __proto__ key arriving from a real file", () => {
    const doc = parseArtifact(file("kind: note\n__proto__:\n  state: approved"));
    expect(Object.keys(doc.frontMatter)).toContain("__proto__");
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("preserves deeply nested unknown structures", () => {
    const doc: TargetDocument = {
      frontMatter: { a: { b: { c: { d: { e: ["deep", { f: 1 }] } } } } },
      body: "",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("applies no domain rules to keys v1 used to police", () => {
    // Every one of these was a v1 core-schema violation. The codec has no
    // opinion: object kinds and their closed key sets live in the server seam.
    const text = file(
      [
        "type: 7",
        "status: null",
        "title: []",
        "source: 1.5",
        "externalId: org/repo/issues/1",
        "sourceUrl: not-a-url",
        "createdAt: yesterday",
        "updatedAt: 2026-07-29",
        "attachments: not-a-list",
      ].join("\n"),
    );
    const doc = parseArtifact(text);
    expect(doc.frontMatter["type"]).toBe(7);
    expect(doc.frontMatter["status"]).toBeNull();
    expect(doc.frontMatter["title"]).toEqual([]);
    expect(doc.frontMatter["externalId"]).toBe("org/repo/issues/1");
    expect(doc.frontMatter["createdAt"]).toBe("yesterday");
    expect(doc.frontMatter["attachments"]).toBe("not-a-list");
  });

  it("accepts front matter with no keys the library recognizes at all", () => {
    const doc = parseArtifact(file("anything: goes"));
    expect(doc.frontMatter).toEqual({ anything: "goes" });
  });

  it("accepts an empty front-matter mapping", () => {
    // `type` is no longer required — nothing is.
    const doc = parseArtifact("---\n{}\n---\nbody");
    expect(doc.frontMatter).toEqual({});
    expect(doc.body).toBe("body");
  });
});

describe("front-matter edits leave the body alone", () => {
  const SOURCE = file("kind: task\nstate: reproduced\nowner: ana", "\n# Report\n\nProse that must not move.\n");

  it("updates a key and re-serializes with a byte-identical body", () => {
    const before = parseArtifact(SOURCE);
    const after = { ...before, frontMatter: { ...before.frontMatter, state: "fixing" } };

    expect(after.body).toBe(before.body);
    expect(parseArtifact(serializeArtifact(after)).body).toBe(before.body);
    expect(parseArtifact(serializeArtifact(after)).frontMatter["state"]).toBe("fixing");
    expect(parseArtifact(serializeArtifact(after)).frontMatter["owner"]).toBe("ana");
  });

  it("adds and removes keys without touching the body", () => {
    const before = parseArtifact(SOURCE);
    const { owner, ...rest } = before.frontMatter;
    const after = { frontMatter: { ...rest, addedLater: true }, body: before.body };
    const round = parseArtifact(serializeArtifact(after));

    expect(round.body).toBe(before.body);
    expect(round.frontMatter["addedLater"]).toBe(true);
    expect("owner" in round.frontMatter).toBe(false);
  });
});
