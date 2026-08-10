/**
 * The object-file seam over @loopany/artifact-format (the owner-directed codec
 * swap). Covers the parse/serialize inverse over the value space the kernel
 * produces — the value that made the retired hand-rolled codec violate the
 * inverse (C9: `String(1e21)` -> "1e+21" read back as a string) is included as
 * a regression — plus the strict status-enum guard at load (C6).
 */
import { describe, expect, it } from "vitest";
import type { KernelObject } from "@loopany/kernel";
import {
  CodecError,
  documentToObject,
  objectToDocument,
  parseObject,
  serializeObject,
} from "../src/objectFile.js";

const iso = "2026-08-09T12:00:00.000Z";

function task(over: Partial<Extract<KernelObject, { archetype: "task" }>> = {}): KernelObject {
  return {
    archetype: "task",
    id: "t1",
    title: "A task",
    status: "todo",
    assignee: null,
    priority: null,
    type: null,
    parent: null,
    tracks: null,
    refs: [],
    followUpAt: null,
    body: "",
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

describe("objectFile codec (over @loopany/artifact-format)", () => {
  it("round-trips a task: parse ∘ serialize is the identity", () => {
    const obj = task({
      title: "Colon: needs quoting",
      assignee: "claude",
      priority: "P0",
      refs: ["m-abc", "other-task"],
      body: "# Heading\n\nbody text\n",
      version: 7,
    });
    const text = serializeObject(obj);
    expect(parseObject(text)).toEqual(obj);
  });

  it("serialize is idempotent (byte-stable under repetition)", () => {
    const obj = task({ title: "stable", body: "x\n" });
    const once = serializeObject(obj);
    expect(serializeObject(parseObject(once))).toBe(once);
  });

  it("emits the fixed head key order and keeps the body below the fence", () => {
    const text = serializeObject(task({ title: "T", body: "# Body\n" }));
    expect(text.startsWith("---\n")).toBe(true);
    const head = text.slice(4, text.indexOf("\n---\n"));
    const keys = head.split("\n").map((l) => l.split(":")[0]);
    expect(keys.slice(0, 4)).toEqual(["archetype", "id", "title", "status"]);
    expect(text).toContain("# Body"); // body verbatim below the fence
  });

  // C9: the hand-rolled codec serialized String(1e21) as "1e+21" and then read
  // it back as a STRING (its isNumericToken only matched plain digits), breaking
  // the inverse. The real YAML codec round-trips it as a string cleanly.
  it("round-trips a title that looks like exponential notation as a STRING (C9)", () => {
    const obj = task({ id: "c9", title: "1e+21" });
    const back = parseObject(serializeObject(obj));
    expect(back.archetype).toBe("task");
    expect((back as Extract<KernelObject, { archetype: "task" }>).title).toBe("1e+21");
    expect(typeof (back as Extract<KernelObject, { archetype: "task" }>).title).toBe("string");
    expect(back).toEqual(obj);
  });

  it("round-trips docs and mirrors", () => {
    const doc: KernelObject = {
      archetype: "doc",
      id: "d1",
      key: "spec",
      title: "The Spec",
      body: "prose\n",
      version: 2,
      createdAt: iso,
      updatedAt: iso,
    };
    expect(parseObject(serializeObject(doc))).toEqual(doc);
    const mirror: KernelObject = {
      archetype: "mirror",
      id: "m-1",
      kind: "github-pr",
      coords: "acme/web#42",
      version: 1,
      createdAt: iso,
      updatedAt: iso,
    };
    expect(parseObject(serializeObject(mirror))).toEqual(mirror);
  });

  // C6: a hand-edited `status: banana` must be refused as corrupt, not cast
  // blindly to TaskStatus and loaded.
  it("rejects an out-of-enum status at load (C6)", () => {
    const good = serializeObject(task({ status: "in-progress" }));
    const corrupt = good.replace("status: in-progress", "status: banana");
    expect(() => parseObject(corrupt)).toThrow(CodecError);
    expect(() => parseObject(corrupt)).toThrow(/not a valid status/);
  });

  // An unknown front-matter key parses fine but serializeObject writes ONLY the
  // archetype's key list — so loading it and re-serializing would SILENTLY DROP
  // it. This module promises "a drift is a parse/shape error rather than silent
  // data loss", so extras are refused at load.
  it("rejects an unknown front-matter key rather than silently dropping it", () => {
    const good = serializeObject(task());
    const corrupt = good.replace("status: todo", "status: todo\ncustomField: precious");
    expect(() => parseObject(corrupt)).toThrow(CodecError);
    expect(() => parseObject(corrupt)).toThrow(/unknown front-matter key/);
    expect(() => parseObject(corrupt)).toThrow(/customField/);
  });

  it("rejects an unknown archetype", () => {
    const good = serializeObject(task());
    const corrupt = good.replace("archetype: task", "archetype: gremlin");
    expect(() => parseObject(corrupt)).toThrow(/unknown object archetype/);
  });

  it("wraps a malformed front-matter file into a CodecError", () => {
    expect(() => parseObject("no front matter here")).toThrow(CodecError);
  });

  it("documentToObject/objectToDocument are the plumbing under parse/serialize", () => {
    const obj = task({ assignee: "x" });
    expect(documentToObject(objectToDocument(obj))).toEqual(obj);
  });
});
