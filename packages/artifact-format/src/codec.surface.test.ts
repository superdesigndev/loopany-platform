/**
 * STAGE 2 — the public surface: the `format` enum, the timestamp helper, the
 * result-shaped batch entry point, and the ABSENCE of the render projection.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectCode, file } from "../test/assert.js";
import { parseArtifact } from "./parse.js";
import { serializeArtifact } from "./serialize.js";
import { bodyFormatOf } from "./schema.js";
import { safeParseArtifact } from "./index.js";
import { SUPPORTED_BODY_FORMATS, type ArtifactDocument } from "./types.js";
import { REMOVED_DEPENDENCIES, REMOVED_EXPORTS, TARGET_EXPORTS, api, surface } from "../test/target.js";

describe("the format field is an enum and nothing more", () => {
  it("supports markdown and html", () => {
    expect([...SUPPORTED_BODY_FORMATS]).toEqual(["markdown", "html"]);
  });

  it("accepts format: markdown", () => {
    expect(parseArtifact(file("format: markdown")).frontMatter["format"]).toBe("markdown");
  });

  it("accepts format: html", () => {
    // Which object kinds may use html is server-side policy, not the codec's.
    expect(parseArtifact(file("format: html")).frontMatter["format"]).toBe("html");
  });

  it("treats an absent format as markdown", () => {
    expect(bodyFormatOf(parseArtifact(file("kind: note")).frontMatter)).toBe("markdown");
  });

  it("rejects any other value loudly, never falling back", () => {
    const err = expectCode(() => parseArtifact(file("format: rtf")), "UNSUPPORTED_FORMAT");
    expect(err.message).toMatch(/rtf/);
    expectCode(() => parseArtifact(file("format: Markdown")), "UNSUPPORTED_FORMAT");
    expectCode(() => parseArtifact(file("format: 1")), "UNSUPPORTED_FORMAT");
    expectCode(() => parseArtifact(file("format: null")), "UNSUPPORTED_FORMAT");
    expectCode(() => parseArtifact(file("format: [markdown]")), "UNSUPPORTED_FORMAT");
  });

  it("refuses to serialize an unsupported format", () => {
    // The TYPE forbids this value; the point of the case is that the RUNTIME
    // refuses it too, for the untyped callers a codec actually serves.
    const doc = { frontMatter: { format: "rtf" }, body: "" } as unknown as ArtifactDocument;
    expectCode(() => serializeArtifact(doc), "UNSUPPORTED_FORMAT");
  });

  it("carries no rendering semantics: an html body is still opaque bytes", () => {
    const body = "<p>literal <b>markup</b></p>\n";
    const doc = parseArtifact(file("format: html", body));
    expect(doc.body).toBe(body);
    expect(parseArtifact(serializeArtifact(doc)).body).toBe(body);
  });

  it("treats a markdown body identically to an html one", () => {
    const body = "# not rendered\n";
    expect(parseArtifact(file("format: markdown", body)).body).toBe(
      parseArtifact(file("format: html", body)).body,
    );
  });
});

describe("the timestamp helper", () => {
  /** Survives as an exported helper the library applies to NO key — callers
   *  decide which of their own keys are timestamps. */
  const valid = [
    "2026-07-29T09:15:00Z",
    "2026-07-29T09:15:00z",
    "2026-07-29t09:15:00Z",
    "2026-07-29T09:15:00.500Z",
    "2026-07-29T09:15:00+02:00",
    "2026-07-29T09:15:00-05:30",
    "2026-07-29 09:15:00Z",
    // A real leap day: February 29 exists in 2024 and must stay accepted.
    "2024-02-29T00:00:00Z",
  ];

  const invalid: Array<[name: string, value: unknown]> = [
    ["a naive date-time with no offset", "2026-07-29T09:15:00"],
    ["a date only", "2026-07-29"],
    ["a time only", "09:15:00Z"],
    ["a bare year", "2026"],
    ["free text", "yesterday"],
    ["an empty string", ""],
    ["a number", 20260729],
    ["null", null],
    ["undefined", undefined],
    ["a list", ["2026-07-29T09:15:00Z"]],
    ["a mapping", { at: "2026-07-29T09:15:00Z" }],
    // A day that never happened is not an instant. `Date.parse` disagrees — it
    // rolls February 30 forward to March 2 and reports a valid time — so a
    // caller re-deriving the date would get a different day than the file says.
    ["a February 30th", "2026-02-30T00:00:00Z"],
    ["an April 31st", "2026-04-31T00:00:00Z"],
    ["a leap day in a non-leap year", "2026-02-29T00:00:00Z"],
    ["a zeroth day", "2026-07-00T00:00:00Z"],
    ["a thirteenth month", "2026-13-01T00:00:00Z"],
  ];

  for (const value of valid) {
    it(`accepts ${value}`, () => {
      expect(api("checkTimestamp")(value, "at")).toBeNull();
    });
  }

  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      const issue = api("checkTimestamp")(value, "at");
      expect(issue).not.toBeNull();
      expect(issue?.path).toBe("at");
    });
  }

  it("keeps the teaching message about the explicit offset", () => {
    const issue = api("checkTimestamp")("2026-07-29T09:15:00", "createdAt");
    expect(issue?.message).toMatch(/RFC 3339/);
    expect(issue?.message).toMatch(/explicit offset/);
  });

  it("reports the caller's own path, since the library owns no timestamp keys", () => {
    expect(api("checkTimestamp")("nope", "meta.observedAt")?.path).toBe("meta.observedAt");
  });

  it("is applied to no key by the library itself", () => {
    // Every one of these was timestamp-validated in v1 and is now plain data.
    const doc = parseArtifact(file("createdAt: yesterday\nupdatedAt: 2026-07-29\nobservedAt: 5"));
    expect(doc.frontMatter["createdAt"]).toBe("yesterday");
    expect(doc.frontMatter["updatedAt"]).toBe("2026-07-29");
    expect(doc.frontMatter["observedAt"]).toBe(5);
  });

  it("composes into a caller's own issue accumulation", () => {
    // The shape a server seam uses: pick the keys it calls timestamps, collect
    // every complaint, report once.
    const check = api("checkTimestamp");
    const frontMatter = parseArtifact(file("createdAt: yesterday\nupdatedAt: 2026-07-29T09:15:00Z\nseenAt: 3"))
      .frontMatter;
    const issues = ["createdAt", "updatedAt", "seenAt"]
      .map((key) => check(frontMatter[key], key))
      .filter((issue) => issue !== null);
    expect(issues.map((i) => i?.path)).toEqual(["createdAt", "seenAt"]);
  });
});

describe("safeParseArtifact", () => {
  it("returns a value result for a well-formed file", () => {
    const result = safeParseArtifact(file("kind: note", "body"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toBe("body");
  });

  it("returns an error result instead of throwing", () => {
    const result = safeParseArtifact("no head here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MISSING_FRONT_MATTER");
  });

  it("never throws for any malformed class", () => {
    const inputs = [
      "",
      "no head",
      "---\nkind: note\nunterminated\n",
      "---\n- a list\n---\n",
      "---\nbroken: [\n---\n",
      file("format: rtf"),
      file(`pad: ${"x".repeat(70 * 1024)}`),
      file("a: &a [x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]"),
    ];
    for (const input of inputs) {
      const result = safeParseArtifact(input);
      expect(result.ok, `expected a failure result for: ${input.slice(0, 30)}`).toBe(false);
      if (!result.ok) expect(result.error.name).toBe("ArtifactFormatError");
    }
  });

  it("suits a batch ingress: one bad file never aborts the batch", () => {
    const batch = [file("kind: a", "one"), "not an artifact", file("kind: c", "three")];
    const results = batch.map((text) => safeParseArtifact(text));
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results.filter((r) => r.ok).length).toBe(2);
  });

  it("carries the same typed error a throwing parse would", () => {
    const result = safeParseArtifact(file("format: rtf"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_FORMAT");
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("the render projection is gone", () => {
  it("exports no rendering API", () => {
    for (const name of REMOVED_EXPORTS) {
      expect(surface[name], `\`${name}\` must not be exported by the codec`).toBeUndefined();
    }
  });

  it("pins the whole runtime export surface", () => {
    expect(Object.keys(surface).sort()).toEqual([...TARGET_EXPORTS].sort());
  });

  it("declares no markdown or sanitizer dependency", () => {
    // Path in a VARIABLE: vite statically rewrites a literal `new URL(...,
    // import.meta.url)` into an asset URL that fileURLToPath then rejects.
    const rel = "../package.json";
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const dep of REMOVED_DEPENDENCIES) {
      expect(declared[dep], `\`${dep}\` must be gone once the render module is deleted`).toBeUndefined();
    }
  });

  it("keeps yaml as the one runtime dependency", () => {
    const rel = "../package.json";
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["yaml"]);
  });
});
