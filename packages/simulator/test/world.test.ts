/**
 * WORLD writer unit - mirror overwrite/append + the path jail, and the
 * human-note argv/env shaping.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMirrorWrite, humanNoteArgv, humanNoteEnv } from "../src/index.js";

describe("applyMirrorWrite", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sim-world-"));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("content writes (and overwrites) a mirror file, creating parent dirs", () => {
    applyMirrorWrite(ws, { kind: "mirror-write", path: "mirrors/releases.md", content: "one\n" });
    expect(readFileSync(join(ws, "mirrors", "releases.md"), "utf8")).toBe("one\n");
    applyMirrorWrite(ws, { kind: "mirror-write", path: "mirrors/releases.md", content: "two\n" });
    expect(readFileSync(join(ws, "mirrors", "releases.md"), "utf8")).toBe("two\n");
  });

  it("append adds to an existing mirror file", () => {
    mkdirSync(join(ws, "mirrors"), { recursive: true });
    writeFileSync(join(ws, "mirrors", "gsc.md"), "line1\n");
    applyMirrorWrite(ws, { kind: "mirror-write", path: "mirrors/gsc.md", append: "line2\n" });
    expect(readFileSync(join(ws, "mirrors", "gsc.md"), "utf8")).toBe("line1\nline2\n");
  });

  it("a path escaping the workspace throws (jail)", () => {
    expect(() =>
      applyMirrorWrite(ws, { kind: "mirror-write", path: "../escape.md", content: "x" }),
    ).toThrow(/escapes the workspace/);
  });

  it("neither content nor append is an error", () => {
    expect(() =>
      applyMirrorWrite(ws, { kind: "mirror-write", path: "mirrors/x.md" }),
    ).toThrow(/neither content nor append/);
  });
});

describe("humanNote shaping", () => {
  it("argv is a bare `note <task> <text>` (no --actor)", () => {
    expect(humanNoteArgv({ kind: "human-note", task: "t1", actor: "tim", text: "hi" })).toEqual([
      "note",
      "t1",
      "hi",
    ]);
  });

  it("the actor rides via LOOPANY_ACTOR env (keeps human provenance)", () => {
    expect(humanNoteEnv({ kind: "human-note", task: "t1", actor: "tim", text: "hi" })).toEqual({
      LOOPANY_ACTOR: "tim",
    });
  });
});
