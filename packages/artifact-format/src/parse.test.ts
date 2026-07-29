import { describe, expect, it } from "vitest";
import { ArtifactFormatError, isArtifactFormatError } from "./errors.js";
import { parseArtifact, splitArtifact } from "./parse.js";
import { safeParseArtifact } from "./index.js";

const MINIMAL = ["---", "type: note", "---", "", "# Hello"].join("\n");

/** Assert a throw is OUR typed error and carries the expected code. */
function expectCode(fn: () => unknown, code: string): ArtifactFormatError {
  try {
    fn();
  } catch (err) {
    if (!isArtifactFormatError(err)) throw err;
    expect(err.code).toBe(code);
    expect(err.name).toBe("ArtifactFormatError");
    return err;
  }
  throw new Error(`expected a ${code} failure, but nothing was thrown`);
}

describe("parseArtifact", () => {
  it("splits the head from the body", () => {
    const doc = parseArtifact(MINIMAL);
    expect(doc.frontMatter.type).toBe("note");
    // The blank line after `---` belongs to the body and is preserved.
    expect(doc.body).toBe("\n# Hello");
  });

  it("preserves the body byte-exactly, including trailing whitespace", () => {
    const body = "\n# Title\n\ntext with trailing spaces   \n\n\n";
    const doc = parseArtifact(`---\ntype: note\n---\n${body}`);
    expect(doc.body).toBe(body);
  });

  it("accepts an empty body", () => {
    expect(parseArtifact("---\ntype: note\n---\n").body).toBe("");
    expect(parseArtifact("---\ntype: note\n---").body).toBe("");
  });

  it("strips a leading BOM", () => {
    expect(parseArtifact(`﻿${MINIMAL}`).frontMatter.type).toBe("note");
  });

  it("tolerates CRLF delimiters and keeps CRLF body bytes", () => {
    const doc = parseArtifact("---\r\ntype: note\r\n---\r\nline one\r\nline two");
    expect(doc.frontMatter.type).toBe("note");
    expect(doc.body).toBe("line one\r\nline two");
  });

  it("tolerates trailing spaces on the delimiter lines", () => {
    expect(parseArtifact("---  \ntype: note\n---\t\nbody").frontMatter.type).toBe("note");
  });

  it("preserves unknown fields untouched", () => {
    const doc = parseArtifact(
      [
        "---",
        "type: defect",
        "status: fixing",
        "severity: p1",
        "reviewers:",
        "  - ana",
        "  - bo",
        "compile:",
        "  budget: 3",
        "  armed: false",
        "---",
        "body",
      ].join("\n"),
    );
    expect(doc.frontMatter["severity"]).toBe("p1");
    expect(doc.frontMatter["reviewers"]).toEqual(["ana", "bo"]);
    expect(doc.frontMatter["compile"]).toEqual({ budget: 3, armed: false });
  });

  it("keeps dates as strings (core schema, no !!timestamp coercion)", () => {
    const doc = parseArtifact("---\ntype: note\ndueOn: 2026-07-29\n---\n");
    expect(doc.frontMatter["dueOn"]).toBe("2026-07-29");
  });

  it("does not coerce YAML 1.1 booleans", () => {
    const doc = parseArtifact("---\ntype: note\nnorway: no\nanswer: yes\n---\n");
    expect(doc.frontMatter["norway"]).toBe("no");
    expect(doc.frontMatter["answer"]).toBe("yes");
  });
});

describe("malformed files fail loudly", () => {
  it("rejects a file with no front matter", () => {
    expectCode(() => parseArtifact("# Just markdown\n"), "MISSING_FRONT_MATTER");
  });

  it("rejects an empty file", () => {
    expectCode(() => parseArtifact(""), "MISSING_FRONT_MATTER");
  });

  it("rejects an opening line that is not exactly `---`", () => {
    expectCode(() => parseArtifact("--- yaml\ntype: note\n---\n"), "MISSING_FRONT_MATTER");
  });

  it("rejects an unterminated block instead of treating it all as body", () => {
    const err = expectCode(() => parseArtifact("---\ntype: note\nstill going\n"), "UNTERMINATED_FRONT_MATTER");
    expect(err.message).toMatch(/never closed/);
  });

  it("rejects a bare `---` file", () => {
    const err = expectCode(() => parseArtifact("---"), "UNTERMINATED_FRONT_MATTER");
    expect(err.message).toMatch(/never closed/);
  });

  it("codes a malformed opening line by WHAT is wrong, not by whether a newline follows", () => {
    // Same input class, with and without a line break: both are a missing block.
    expectCode(() => parseArtifact("--- yaml\ntype: note\n---\n"), "MISSING_FRONT_MATTER");
    const err = expectCode(() => parseArtifact("--- yaml"), "MISSING_FRONT_MATTER");
    expect(err.message).toMatch(/exactly `---`/);
    // A well-formed opening line with no closer is the unterminated case.
    expectCode(() => parseArtifact("---   "), "UNTERMINATED_FRONT_MATTER");
  });

  it("rejects malformed YAML with a document line number", () => {
    const err = expectCode(() => parseArtifact("---\ntype: note\n  bad: [1, 2\n---\nbody"), "INVALID_YAML");
    expect(err.line).toBeGreaterThanOrEqual(2);
  });

  it("rejects duplicate keys", () => {
    expectCode(() => parseArtifact("---\ntype: note\ntype: other\n---\n"), "INVALID_YAML");
  });

  it("rejects an unresolved YAML tag rather than degrading it to a string", () => {
    expectCode(() => parseArtifact("---\ntype: note\nx: !!python/object:os.system []\n---\n"), "INVALID_YAML");
  });

  it("rejects front matter that is not a mapping", () => {
    expectCode(() => parseArtifact("---\n- one\n- two\n---\n"), "FRONT_MATTER_NOT_MAPPING");
    expectCode(() => parseArtifact("---\njust a scalar\n---\n"), "FRONT_MATTER_NOT_MAPPING");
  });

  it("rejects empty front matter (type is required)", () => {
    expectCode(() => parseArtifact("---\n---\n"), "FRONT_MATTER_NOT_MAPPING");
  });

  it("reports errors as a result when asked not to throw", () => {
    const result = safeParseArtifact("no head here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MISSING_FRONT_MATTER");
  });
});

describe("core schema", () => {
  it("requires a non-empty type", () => {
    expectCode(() => parseArtifact("---\nstatus: open\n---\n"), "SCHEMA_VIOLATION");
    expectCode(() => parseArtifact('---\ntype: "   "\n---\n'), "SCHEMA_VIOLATION");
    expectCode(() => parseArtifact("---\ntype: 7\n---\n"), "SCHEMA_VIOLATION");
    expectCode(() => parseArtifact("---\ntype:\n---\n"), "SCHEMA_VIOLATION");
  });

  it("collects every violation into one error", () => {
    const err = expectCode(
      () => parseArtifact("---\ntype: note\nstatus: 3\ncreatedAt: yesterday\n---\n"),
      "SCHEMA_VIOLATION",
    );
    expect(err.issues.map((i) => i.path).sort()).toEqual(["createdAt", "status"]);
  });

  it("requires timestamps to carry an explicit offset", () => {
    expect(parseArtifact("---\ntype: note\ncreatedAt: 2026-07-29T09:15:00Z\n---\n").frontMatter.createdAt).toBe(
      "2026-07-29T09:15:00Z",
    );
    expect(
      parseArtifact("---\ntype: note\nupdatedAt: 2026-07-29T09:15:00.500+02:00\n---\n").frontMatter.updatedAt,
    ).toBe("2026-07-29T09:15:00.500+02:00");
    expectCode(() => parseArtifact("---\ntype: note\ncreatedAt: 2026-07-29T09:15:00\n---\n"), "SCHEMA_VIOLATION");
    expectCode(() => parseArtifact("---\ntype: note\ncreatedAt: 2026-07-29\n---\n"), "SCHEMA_VIOLATION");
  });

  it("rejects an externalId with no source (half a mirror key)", () => {
    const err = expectCode(
      () => parseArtifact("---\ntype: pr\nexternalId: org/repo/pull/1\n---\n"),
      "SCHEMA_VIOLATION",
    );
    expect(err.issues[0]?.path).toBe("externalId");
    expect(
      parseArtifact("---\ntype: pr\nsource: github\nexternalId: org/repo/pull/1\n---\n").frontMatter.externalId,
    ).toBe("org/repo/pull/1");
  });

  it("accepts attachments as a string list and rejects other shapes", () => {
    expect(parseArtifact("---\ntype: note\nattachments:\n  - a.png\n---\n").frontMatter.attachments).toEqual([
      "a.png",
    ]);
    expectCode(() => parseArtifact("---\ntype: note\nattachments: a.png\n---\n"), "SCHEMA_VIOLATION");
    expectCode(() => parseArtifact("---\ntype: note\nattachments:\n  - 3\n---\n"), "SCHEMA_VIOLATION");
  });

  it("accepts format: markdown and rejects any other value loudly", () => {
    expect(parseArtifact("---\ntype: note\nformat: markdown\n---\n").frontMatter.format).toBe("markdown");
    const err = expectCode(() => parseArtifact("---\ntype: note\nformat: html\n---\n"), "UNSUPPORTED_FORMAT");
    expect(err.message).toMatch(/"html"/);
    expectCode(() => parseArtifact("---\ntype: note\nformat: 1\n---\n"), "UNSUPPORTED_FORMAT");
  });
});

describe("hostile YAML", () => {
  it("cannot be injected via a `---` line inside the body", () => {
    const doc = parseArtifact(
      ["---", "type: note", "status: draft", "---", "", "intro", "", "---", "type: admin", "status: approved", "---", "", "outro"].join(
        "\n",
      ),
    );
    // Only the FIRST closing delimiter closes the head; the rest is body text.
    expect(doc.frontMatter.status).toBe("draft");
    expect(doc.frontMatter.type).toBe("note");
    expect(doc.body).toContain("type: admin");
  });

  it("rejects a billion-laughs alias bomb", () => {
    const lines = ["---", "type: note", "a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (const [i, prev] of ["a", "b", "c", "d", "e", "f"].entries()) {
      const next = String.fromCharCode("b".charCodeAt(0) + i);
      lines.push(`${next}: &${next} [${Array.from({ length: 10 }, () => `*${prev}`).join(", ")}]`);
    }
    lines.push("---", "body");
    expectCode(() => parseArtifact(lines.join("\n")), "INVALID_YAML");
  });

  it("rejects front matter nested past the depth ceiling", () => {
    const deep = `${"[".repeat(200)}1${"]".repeat(200)}`;
    expectCode(() => parseArtifact(`---\ntype: note\ndeep: ${deep}\n---\n`), "FRONT_MATTER_TOO_DEEP");
  });

  it("rejects front matter with too many nodes", () => {
    // Flow style so the node count blows well before the byte ceiling does.
    const many = Array.from({ length: 6000 }, () => "1").join(",");
    expectCode(() => parseArtifact(`---\ntype: note\nlist: [${many}]\n---\n`), "FRONT_MATTER_TOO_MANY_NODES");
  });

  it("rejects an oversized front-matter block before parsing it", () => {
    const padding = "x".repeat(70 * 1024);
    expectCode(() => parseArtifact(`---\ntype: note\npad: ${padding}\n---\n`), "FRONT_MATTER_TOO_LARGE");
  });

  it("rejects an oversized document", () => {
    const body = "y".repeat(5 * 1024 * 1024);
    expectCode(() => parseArtifact(`---\ntype: note\n---\n${body}`), "DOCUMENT_TOO_LARGE");
  });

  it("honours overridden limits", () => {
    expectCode(
      () => parseArtifact(MINIMAL, { limits: { maxDocumentBytes: 4 } }),
      "DOCUMENT_TOO_LARGE",
    );
    // A pathological file is still parseable if the caller raises the ceiling.
    const nested = "---\ntype: note\nd: [[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]\n---\n";
    expectCode(() => parseArtifact(nested), "FRONT_MATTER_TOO_DEEP");
    expect(parseArtifact(nested, { limits: { maxFrontMatterDepth: 64 } }).frontMatter["d"]).toBeDefined();
  });

  it("never lets a deeply nested body cost anything (the body is never parsed)", () => {
    const doc = parseArtifact(`---\ntype: note\n---\n${"[".repeat(500_000)}`);
    expect(doc.body.length).toBe(500_000);
  });
});

describe("splitArtifact", () => {
  it("returns the raw head text without parsing it", () => {
    const split = splitArtifact("---\ntype: note\nbroken: [\n---\nbody");
    expect(split.frontMatterText).toBe("type: note\nbroken: [\n");
    expect(split.body).toBe("body");
  });
});
