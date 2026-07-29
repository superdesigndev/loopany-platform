import { describe, expect, it } from "vitest";
import { isArtifactFormatError } from "./errors.js";
import { parseArtifact } from "./parse.js";
import { serializeArtifact, updateArtifactFrontMatter } from "./serialize.js";
import type { ArtifactDocument } from "./types.js";

const RICH: ArtifactDocument = {
  frontMatter: {
    // Deliberately shuffled relative to the canonical order.
    attachments: ["diagram.svg", "trace.json"],
    updatedAt: "2026-07-29T09:15:00Z",
    severity: "p1",
    type: "defect",
    compile: { budget: 3, armed: false, lanes: ["a", "b"] },
    status: "fixing",
    source: "github",
    externalId: "org/repo/issues/1291",
    createdAt: "2026-07-01T00:00:00Z",
    title: "Sync floods on a worktree drop",
  },
  body: "\n# Sync floods\n\nOne run dropped a worktree in the loop folder.\n",
};

describe("round trip", () => {
  it("parse(serialize(doc)) deep-equals doc", () => {
    expect(parseArtifact(serializeArtifact(RICH))).toEqual(RICH);
  });

  it("serialize(parse(text)) is byte-stable under repetition", () => {
    const once = serializeArtifact(RICH);
    const twice = serializeArtifact(parseArtifact(once));
    expect(twice).toBe(once);
    expect(serializeArtifact(parseArtifact(twice))).toBe(once);
  });

  it("is a pure function of the data, not of key insertion order", () => {
    const shuffled: ArtifactDocument = {
      frontMatter: Object.fromEntries(
        Object.entries(RICH.frontMatter).reverse(),
      ) as ArtifactDocument["frontMatter"],
      body: RICH.body,
    };
    expect(serializeArtifact(shuffled)).toBe(serializeArtifact(RICH));
  });

  it("orders core fields first, then unknown fields lexicographically", () => {
    const head = serializeArtifact(RICH).split("---\n")[1] as string;
    const keys = head
      .split("\n")
      .filter((l) => /^[A-Za-z]/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual([
      "type",
      "status",
      "title",
      "source",
      "externalId",
      "createdAt",
      "updatedAt",
      "attachments",
      "compile",
      "severity",
    ]);
  });

  it("sorts nested unknown mappings too", () => {
    const a = serializeArtifact({ frontMatter: { type: "t", x: { b: 1, a: 2 } }, body: "" });
    const b = serializeArtifact({ frontMatter: { type: "t", x: { a: 2, b: 1 } }, body: "" });
    expect(a).toBe(b);
    expect(a).toContain("  a: 2\n  b: 1");
  });

  it("keeps list order (a list is ordered data)", () => {
    const doc = parseArtifact(serializeArtifact(RICH));
    expect(doc.frontMatter.attachments).toEqual(["diagram.svg", "trace.json"]);
  });

  it("preserves unknown fields of every scalar shape", () => {
    const doc: ArtifactDocument = {
      frontMatter: {
        type: "note",
        count: 42,
        ratio: 0.5,
        armed: false,
        nothing: null,
        multiline: "line one\nline two\n",
        tricky: "value: with: colons # and a hash",
        unicode: "日本語 — em dash and emoji 🚀",
        empty: [],
        emptyMap: {},
      },
      body: "body",
    };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("round-trips a body containing delimiter lines and trailing whitespace", () => {
    const doc: ArtifactDocument = {
      frontMatter: { type: "note" },
      body: "\nintro\n\n---\ntype: injected\n---\n\noutro   \n\n",
    };
    const text = serializeArtifact(doc);
    expect(parseArtifact(text)).toEqual(doc);
  });

  it("round-trips an empty body", () => {
    const doc: ArtifactDocument = { frontMatter: { type: "note" }, body: "" };
    expect(serializeArtifact(doc)).toBe("---\ntype: note\n---\n");
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("round-trips a body that starts immediately (no blank separator line)", () => {
    const doc: ArtifactDocument = { frontMatter: { type: "note" }, body: "# Title\n" };
    expect(parseArtifact(serializeArtifact(doc))).toEqual(doc);
  });

  it("drops undefined values rather than emitting a null", () => {
    const text = serializeArtifact({ frontMatter: { type: "note", status: undefined }, body: "" });
    expect(text).toBe("---\ntype: note\n---\n");
  });

  it("refuses to emit a file it would refuse to read back", () => {
    expect(() => serializeArtifact({ frontMatter: { type: "" }, body: "" })).toThrow(/core schema/);
    expect(() => serializeArtifact({ frontMatter: { type: "note", format: "html" as never }, body: "" })).toThrow(
      /unsupported body format/,
    );
    try {
      serializeArtifact({ frontMatter: { type: "note", fn: () => 1 }, body: "" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(isArtifactFormatError(err)).toBe(true);
    }
  });
});

describe("machine head edits", () => {
  const SOURCE = [
    "---",
    "type: defect",
    "status: reproduced",
    "severity: p1",
    "---",
    "",
    "# Sync floods",
    "",
    "Body prose that must survive a status transition verbatim.",
    "",
    "| step | owner |",
    "|------|-------|",
    "| repro | ana  |",
    "",
  ].join("\n");

  it("reads the status field", () => {
    expect(parseArtifact(SOURCE).frontMatter.status).toBe("reproduced");
  });

  it("updates status and re-serializes without touching the body", () => {
    const before = parseArtifact(SOURCE);
    const after = updateArtifactFrontMatter(before, { status: "fixing" });

    expect(after.body).toBe(before.body);
    expect(after.frontMatter.status).toBe("fixing");
    // Untouched fields, known and unknown alike, survive.
    expect(after.frontMatter.type).toBe("defect");
    expect(after.frontMatter["severity"]).toBe("p1");

    const rewritten = serializeArtifact(after);
    expect(parseArtifact(rewritten).body).toBe(before.body);
    expect(rewritten.split("---\n")[2]).toBe(before.body);
  });

  it("adds a field the core schema has never heard of", () => {
    const updated = updateArtifactFrontMatter(parseArtifact(SOURCE), {
      gateObligation: { key: "approve-merge", class: "human-verdict" },
    });
    expect(parseArtifact(serializeArtifact(updated)).frontMatter["gateObligation"]).toEqual({
      key: "approve-merge",
      class: "human-verdict",
    });
  });

  it("removes a field with undefined", () => {
    const updated = updateArtifactFrontMatter(parseArtifact(SOURCE), { status: undefined });
    expect("status" in updated.frontMatter).toBe(false);
  });

  it("validates the patched head rather than trusting the caller", () => {
    expect(() => updateArtifactFrontMatter(parseArtifact(SOURCE), { status: "" })).toThrow(/core schema/);
    expect(() =>
      updateArtifactFrontMatter(parseArtifact(SOURCE), { createdAt: "not a timestamp" }),
    ).toThrow(/RFC 3339/);
  });

  it("does not mutate the input document", () => {
    const before = parseArtifact(SOURCE);
    updateArtifactFrontMatter(before, { status: "fixing" });
    expect(before.frontMatter.status).toBe("reproduced");
  });
});
