/**
 * STAGE 2 — hostile-input ceilings.
 *
 * Every ceiling FAILS LOUD. None of them clips, truncates, or samples: a
 * caller must never receive a document that silently lost part of its head.
 */

import { describe, expect, it } from "vitest";
import { expectCode, file } from "../test/assert.js";
import { parseArtifact } from "./parse.js";
import { DEFAULT_LIMITS, resolveLimits } from "./types.js";

describe("document byte ceiling", () => {
  it("rejects a document over the ceiling", () => {
    const err = expectCode(
      () => parseArtifact(file("kind: note", "y".repeat(5 * 1024 * 1024))),
      "DOCUMENT_TOO_LARGE",
    );
    expect(err.message).toMatch(/\d+/);
  });

  it("accepts a document under the ceiling", () => {
    expect(parseArtifact(file("kind: note", "y".repeat(1024))).body.length).toBe(1024);
  });

  it("honours a lowered ceiling", () => {
    expectCode(() => parseArtifact(file("kind: note"), { limits: { maxDocumentBytes: 4 } }), "DOCUMENT_TOO_LARGE");
  });

  it("measures UTF-8 bytes, not code units", () => {
    // Four-byte astral characters must count as four, or the ceiling is a lie
    // on any non-ASCII document.
    const astral = "🚀".repeat(50);
    expectCode(
      () => parseArtifact(file("kind: note", astral), { limits: { maxDocumentBytes: 120 } }),
      "DOCUMENT_TOO_LARGE",
    );
  });
});

describe("front-matter byte ceiling", () => {
  it("rejects an oversized head before parsing it", () => {
    expectCode(() => parseArtifact(file(`pad: ${"x".repeat(70 * 1024)}`)), "FRONT_MATTER_TOO_LARGE");
  });

  it("is separate from the document ceiling", () => {
    // A large BODY is fine; only the head is bounded this tightly.
    const doc = parseArtifact(file("kind: note", "y".repeat(200 * 1024)));
    expect(doc.body.length).toBe(200 * 1024);
  });

  it("honours a lowered ceiling", () => {
    expectCode(
      () => parseArtifact(file("kind: note"), { limits: { maxFrontMatterBytes: 4 } }),
      "FRONT_MATTER_TOO_LARGE",
    );
  });
});

describe("depth ceiling", () => {
  it("rejects front matter nested past the ceiling", () => {
    const deep = `${"[".repeat(200)}1${"]".repeat(200)}`;
    expectCode(() => parseArtifact(file(`deep: ${deep}`)), "FRONT_MATTER_TOO_DEEP");
  });

  it("rejects deep block-style nesting too, not just flow style", () => {
    const lines: string[] = ["deep:"];
    for (let i = 1; i < 40; i += 1) lines.push(`${"  ".repeat(i)}child:`);
    lines.push(`${"  ".repeat(40)}leaf: 1`);
    expectCode(() => parseArtifact(file(lines.join("\n"))), "FRONT_MATTER_TOO_DEEP");
  });

  it("accepts nesting at the ceiling", () => {
    const depth = DEFAULT_LIMITS.maxFrontMatterDepth - 1;
    const nested = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
    expect(parseArtifact(file(`deep: ${nested}`)).frontMatter["deep"]).toBeDefined();
  });

  it("honours a raised ceiling", () => {
    const nested = `deep: ${"[".repeat(18)}1${"]".repeat(18)}`;
    expectCode(() => parseArtifact(file(nested)), "FRONT_MATTER_TOO_DEEP");
    expect(parseArtifact(file(nested), { limits: { maxFrontMatterDepth: 64 } }).frontMatter["deep"]).toBeDefined();
  });

  it("does not blow the host stack while measuring depth", () => {
    // The guard walk must be iterative — a pathological input has to produce an
    // ArtifactFormatError, never a RangeError that escapes the library.
    const pathological = `deep: ${"[".repeat(50_000)}1${"]".repeat(50_000)}`;
    try {
      parseArtifact(file(pathological), { limits: { maxFrontMatterBytes: 1024 * 1024 } });
      throw new Error("expected a loud failure");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("ArtifactFormatError");
    }
  });
});

describe("node-count ceiling", () => {
  it("rejects front matter with too many nodes", () => {
    const many = Array.from({ length: 6000 }, () => "1").join(",");
    expectCode(() => parseArtifact(file(`list: [${many}]`)), "FRONT_MATTER_TOO_MANY_NODES");
  });

  it("counts nodes across the whole tree, not per collection", () => {
    const groups = Array.from({ length: 60 }, (_, i) => `g${i}: [${Array.from({ length: 100 }, () => "1").join(",")}]`);
    expectCode(() => parseArtifact(file(groups.join("\n"))), "FRONT_MATTER_TOO_MANY_NODES");
  });

  it("honours a raised ceiling", () => {
    const many = Array.from({ length: 6000 }, () => "1").join(",");
    expect(
      parseArtifact(file(`list: [${many}]`), { limits: { maxFrontMatterNodes: 20_000 } }).frontMatter["list"],
    ).toHaveLength(6000);
  });
});

describe("alias expansion ceiling", () => {
  it("rejects a billion-laughs bomb", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    let prev = "a";
    for (const next of ["b", "c", "d", "e", "f", "g"]) {
      lines.push(`${next}: &${next} [${Array.from({ length: 10 }, () => `*${prev}`).join(", ")}]`);
      prev = next;
    }
    expectCode(() => parseArtifact(file(lines.join("\n"))), "INVALID_YAML");
  });

  it("allows a modest number of aliases", () => {
    const doc = parseArtifact(file("base: &base value\nfirst: *base\nsecond: *base"));
    expect(doc.frontMatter["first"]).toBe("value");
    expect(doc.frontMatter["second"]).toBe("value");
  });

  it("honours a lowered ceiling", () => {
    const many = Array.from({ length: 20 }, (_, i) => `k${i}: *base`).join("\n");
    expectCode(() => parseArtifact(file(`base: &base value\n${many}`), { limits: { maxAliasCount: 2 } }), "INVALID_YAML");
  });
});

describe("limit resolution", () => {
  it("defaults every ceiling", () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it("overrides only the named ceilings", () => {
    expect(resolveLimits({ limits: { maxFrontMatterDepth: 99 } })).toEqual({
      ...DEFAULT_LIMITS,
      maxFrontMatterDepth: 99,
    });
  });

  it("exposes all five ceilings", () => {
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual([
      "maxAliasCount",
      "maxDocumentBytes",
      "maxFrontMatterBytes",
      "maxFrontMatterDepth",
      "maxFrontMatterNodes",
    ]);
  });
});
