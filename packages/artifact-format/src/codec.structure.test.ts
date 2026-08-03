/**
 * STAGE 2 — structural validation and loud failure.
 *
 * The codec validates STRUCTURE and nothing else: the file has one YAML
 * mapping as its head, the YAML is well formed, and every value is something
 * YAML can actually carry. Domain rules are the server seam's business.
 */

import { describe, expect, it } from "vitest";
import { expectCode, file } from "../test/assert.js";
import { parseArtifact, splitArtifact } from "./parse.js";
import { serializeArtifact, updateArtifactFrontMatter } from "./serialize.js";

describe("the file must have a front-matter block", () => {
  it("rejects a file with no front matter", () => {
    expectCode(() => parseArtifact("# Just a body\n"), "MISSING_FRONT_MATTER");
  });

  it("rejects an empty file", () => {
    expectCode(() => parseArtifact(""), "MISSING_FRONT_MATTER");
  });

  it("rejects a body-only file even when it contains a delimiter later on", () => {
    // The block must OPEN the file; a delimiter further down does not count.
    expectCode(() => parseArtifact("intro\n---\nkind: note\n---\n"), "MISSING_FRONT_MATTER");
  });

  it("rejects an opening line that is not exactly a delimiter", () => {
    expectCode(() => parseArtifact("--- yaml\nkind: note\n---\n"), "MISSING_FRONT_MATTER");
    expectCode(() => parseArtifact("----\nkind: note\n---\n"), "MISSING_FRONT_MATTER");
  });

  it("codes a malformed opening line by what is wrong, not by whether a newline follows", () => {
    expectCode(() => parseArtifact("--- yaml"), "MISSING_FRONT_MATTER");
    expectCode(() => parseArtifact("--- yaml\nkind: note\n---\n"), "MISSING_FRONT_MATTER");
  });

  it("rejects an unterminated block instead of treating the whole file as body", () => {
    const err = expectCode(() => parseArtifact("---\nkind: note\nstill going\n"), "UNTERMINATED_FRONT_MATTER");
    expect(err.message).toMatch(/never closed/);
  });

  it("rejects a bare delimiter with nothing after it", () => {
    expectCode(() => parseArtifact("---"), "UNTERMINATED_FRONT_MATTER");
    expectCode(() => parseArtifact("---\n"), "UNTERMINATED_FRONT_MATTER");
  });

  it("accepts a well-formed block with no body", () => {
    expect(parseArtifact("---\nkind: note\n---\n").body).toBe("");
    expect(parseArtifact("---\nkind: note\n---").body).toBe("");
  });

  it("tolerates a leading BOM", () => {
    expect(parseArtifact(`﻿${file("kind: note")}`).frontMatter["kind"]).toBe("note");
  });

  it("tolerates CRLF delimiters", () => {
    const doc = parseArtifact("---\r\nkind: note\r\n---\r\nbody\r\n");
    expect(doc.frontMatter["kind"]).toBe("note");
    expect(doc.body).toBe("body\r\n");
  });

  it("tolerates trailing whitespace on the delimiter lines", () => {
    expect(parseArtifact("---  \nkind: note\n---\t\nbody").frontMatter["kind"]).toBe("note");
  });
});

describe("front matter must be a mapping", () => {
  it("rejects a sequence at the top level", () => {
    expectCode(() => parseArtifact("---\n- one\n- two\n---\n"), "FRONT_MATTER_NOT_MAPPING");
  });

  it("rejects a bare scalar at the top level", () => {
    expectCode(() => parseArtifact("---\njust a scalar\n---\n"), "FRONT_MATTER_NOT_MAPPING");
    expectCode(() => parseArtifact("---\n42\n---\n"), "FRONT_MATTER_NOT_MAPPING");
  });

  it("rejects an empty block, which YAML reads as null rather than a mapping", () => {
    expectCode(() => parseArtifact("---\n---\n"), "FRONT_MATTER_NOT_MAPPING");
  });

  it("accepts an explicitly empty mapping", () => {
    expect(parseArtifact("---\n{}\n---\n").frontMatter).toEqual({});
  });
});

describe("the YAML itself is parsed strictly", () => {
  it("rejects malformed YAML and reports a document line", () => {
    const err = expectCode(() => parseArtifact("---\nkind: note\n  bad: [1, 2\n---\nbody"), "INVALID_YAML");
    expect(err.line).toBeGreaterThanOrEqual(2);
  });

  it("rejects duplicate keys instead of silently keeping one", () => {
    expectCode(() => parseArtifact(file("kind: note\nkind: other")), "INVALID_YAML");
  });

  it("rejects an unresolved tag rather than degrading it to a string", () => {
    expectCode(() => parseArtifact(file("x: !!python/object:os.system []")), "INVALID_YAML");
  });

  it("does not coerce dates to host objects", () => {
    // YAML 1.2 core schema: no !!timestamp. A date-shaped scalar stays a string,
    // which is what keeps the value round-trippable.
    expect(parseArtifact(file("dueOn: 2026-07-29")).frontMatter["dueOn"]).toBe("2026-07-29");
  });

  it("does not apply YAML 1.1 boolean coercion", () => {
    const doc = parseArtifact(file("norway: no\nanswer: yes\nmaybe: on"));
    expect(doc.frontMatter["norway"]).toBe("no");
    expect(doc.frontMatter["answer"]).toBe("yes");
    expect(doc.frontMatter["maybe"]).toBe("on");
  });
});

describe("host objects are rejected, never silently flattened", () => {
  class Widget {
    readonly n = 1;
  }

  const hostValues: Array<[name: string, value: unknown]> = [
    ["a Date", new Date(0)],
    ["a Map", new Map([["a", 1]])],
    ["a Set", new Set([1, 2])],
    ["a class instance", new Widget()],
    ["a RegExp", /x/],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", BigInt(1)],
  ];

  for (const [name, value] of hostValues) {
    it(`rejects ${name} at the top level`, () => {
      expectCode(() => serializeArtifact({ frontMatter: { kind: "note", bad: value }, body: "" }), "SCHEMA_VIOLATION");
    });
  }

  it("rejects a host object nested inside a mapping", () => {
    expectCode(
      () => serializeArtifact({ frontMatter: { outer: { inner: new Date(0) } }, body: "" }),
      "SCHEMA_VIOLATION",
    );
  });

  it("rejects a host object inside a list", () => {
    expectCode(() => serializeArtifact({ frontMatter: { list: [1, new Set()] }, body: "" }), "SCHEMA_VIOLATION");
  });

  it("names the offending kind in the error", () => {
    const err = expectCode(
      () => serializeArtifact({ frontMatter: { at: new Date(0) }, body: "" }),
      "SCHEMA_VIOLATION",
    );
    expect(err.message).toMatch(/Date/);
  });

  it("accepts a null-prototype mapping, which is structurally a plain mapping", () => {
    const bag = Object.create(null) as Record<string, unknown>;
    bag["kind"] = "note";
    expect(parseArtifact(serializeArtifact({ frontMatter: bag, body: "" })).frontMatter).toEqual({ kind: "note" });
  });
});

describe("issue accumulation", () => {
  /** One malformed document reports every problem at once, so a caller fixing
   *  a file is not led through them one round trip at a time. */
  it("reports every unrepresentable value in a single error", () => {
    const err = expectCode(
      () =>
        serializeArtifact({
          frontMatter: { first: new Date(0), second: new Map(), nested: { third: new Set() } },
          body: "",
        }),
      "SCHEMA_VIOLATION",
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(3);
    expect(err.issues.map((i) => i.path).sort()).toEqual(["first", "nested.third", "second"]);
  });

  it("gives each issue a path a caller can act on", () => {
    const err = expectCode(
      () => serializeArtifact({ frontMatter: { list: [1, new Date(0)] }, body: "" }),
      "SCHEMA_VIOLATION",
    );
    expect(err.issues[0]?.path).toBe("list[1]");
    expect(err.issues[0]?.message).toBeTruthy();
  });

  it("summarizes the issues in the error message", () => {
    const err = expectCode(
      () => serializeArtifact({ frontMatter: { a: new Date(0), b: new Map() }, body: "" }),
      "SCHEMA_VIOLATION",
    );
    expect(err.message).toMatch(/a/);
    expect(err.message).toMatch(/b/);
  });
});

describe("splitArtifact", () => {
  it("returns the raw head text without parsing it", () => {
    const split = splitArtifact("---\nkind: note\nbroken: [\n---\nbody");
    expect(split.frontMatterText).toBe("kind: note\nbroken: [\n");
    expect(split.body).toBe("body");
  });

  it("fails as loudly as a full parse on a missing block", () => {
    expectCode(() => splitArtifact("no head"), "MISSING_FRONT_MATTER");
  });
});

describe("updateArtifactFrontMatter", () => {
  const SOURCE = file("kind: task\nstate: reproduced\nowner: ana", "\n# Report\n");

  it("merges a patch and keeps the body identical", () => {
    const before = parseArtifact(SOURCE);
    const after = updateArtifactFrontMatter(before, { state: "fixing" });
    expect(after.body).toBe(before.body);
    expect(after.frontMatter["state"]).toBe("fixing");
    expect(after.frontMatter["owner"]).toBe("ana");
  });

  it("removes a key when the patch value is undefined", () => {
    const after = updateArtifactFrontMatter(parseArtifact(SOURCE), { owner: undefined });
    expect("owner" in after.frontMatter).toBe(false);
  });

  it("accepts any key, since the codec has no field vocabulary", () => {
    const after = updateArtifactFrontMatter(parseArtifact(SOURCE), { anythingAtAll: { nested: true } });
    expect(parseArtifact(serializeArtifact(after)).frontMatter["anythingAtAll"]).toEqual({ nested: true });
  });

  it("rejects an unrepresentable patch value", () => {
    expectCode(() => updateArtifactFrontMatter(parseArtifact(SOURCE), { at: new Date(0) }), "SCHEMA_VIOLATION");
  });

  it("lands a prototype-shadowing key as an own property", () => {
    const after = updateArtifactFrontMatter(parseArtifact(SOURCE), { ["__proto__"]: { polluted: true } });
    expect(Object.keys(after.frontMatter)).toContain("__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("hands back an ordinary object, prototype-shadowing key and all", () => {
    // The null prototype is load-bearing for the MERGE — it is what makes a
    // `__proto__` patch key an own property — but a document from this path
    // must behave like every other one the library returns.
    const after = updateArtifactFrontMatter(parseArtifact(SOURCE), { ["__proto__"]: { polluted: true } });
    expect(Object.prototype.hasOwnProperty.call(after.frontMatter, "__proto__")).toBe(true);
    expect(after.frontMatter.hasOwnProperty("state")).toBe(true);
    expect(String(after.frontMatter)).toBe("[object Object]");
    expect(Object.getPrototypeOf(after.frontMatter)).toBe(Object.prototype);
  });

  it("does not mutate the input document", () => {
    const before = parseArtifact(SOURCE);
    updateArtifactFrontMatter(before, { state: "fixing" });
    expect(before.frontMatter["state"]).toBe("reproduced");
  });
});
