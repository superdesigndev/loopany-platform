/**
 * WORLD PROBE reader - recorded PRs from disk + task parsing from `lk list
 * --json` (flat array OR nested tree, tolerant of junk).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProbe, parseTasks, readRecordedPrs } from "../src/probe.js";

describe("readRecordedPrs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-probe-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads pr-*.json records with their changed files, sorted", () => {
    mkdirSync(join(root, "github"), { recursive: true });
    writeFileSync(
      join(root, "github", "pr-2.json"),
      JSON.stringify({ number: 2, branch: "b2", changedFiles: ["y.js"] }),
    );
    writeFileSync(
      join(root, "github", "pr-1.json"),
      JSON.stringify({ number: 1, branch: "b1", changedFiles: ["public/install-wrapper.js"] }),
    );
    const prs = readRecordedPrs(root);
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(prs[0].changedFiles).toEqual(["public/install-wrapper.js"]);
  });

  it("an absent github/ dir yields []", () => {
    expect(readRecordedPrs(root)).toEqual([]);
  });
});

describe("parseTasks", () => {
  it("parses a flat array of task objects", () => {
    const json = JSON.stringify([
      { id: "t1", archetype: "task", status: "todo", assignee: "claude" },
      { id: "t2", archetype: "task", status: "done", assignee: null },
    ]);
    const tasks = parseTasks(json);
    expect(tasks).toEqual([
      { id: "t1", status: "todo", assignee: "claude" },
      { id: "t2", status: "done", assignee: null },
    ]);
  });

  it("flattens a nested tree (children)", () => {
    const json = JSON.stringify([
      {
        id: "root",
        status: "in-progress",
        assignee: "claude",
        children: [{ id: "child", status: "todo", assignee: "tim" }],
      },
    ]);
    const ids = parseTasks(json).map((t) => t.id);
    expect(ids).toEqual(["root", "child"]);
  });

  it("returns [] on unparseable json (never throws)", () => {
    expect(parseTasks("not json")).toEqual([]);
  });
});

describe("buildProbe file reads", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sim-probe-ws-"));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("fileExists / fileContains read a real workspace file", () => {
    mkdirSync(join(ws, "content", "trial"), { recursive: true });
    writeFileSync(join(ws, "content", "trial", "ai-design-agent.md"), "# trial page\ntarget: ai design agent\n");
    const probe = buildProbe(ws, "[]", ws);
    expect(probe.fileExists("content/trial/ai-design-agent.md")).toBe(true);
    expect(probe.fileContains("content/trial/ai-design-agent.md", "ai design agent")).toBe(true);
    expect(probe.fileContains("content/trial/ai-design-agent.md", "figma alternative")).toBe(false);
  });

  it("an absent file reads false (never throws)", () => {
    const probe = buildProbe(ws, "[]", ws);
    expect(probe.fileExists("content/scale/whatever.md")).toBe(false);
    expect(probe.fileContains("content/scale/whatever.md", "x")).toBe(false);
  });

  it("a traversal outside the workspace reads false (path-jailed)", () => {
    writeFileSync(join(ws, "..", "outside.txt"), "secret");
    const probe = buildProbe(ws, "[]", ws);
    expect(probe.fileExists("../outside.txt")).toBe(false);
    rmSync(join(ws, "..", "outside.txt"), { force: true });
  });

  it("dirHasFiles gates on ANY file under the dir - the agent picks the names", () => {
    const probe = buildProbe(ws, "[]", ws);
    // Absent dir, then empty dir: both false.
    expect(probe.dirHasFiles("content/scale/ai-design-agent")).toBe(false);
    mkdirSync(join(ws, "content", "scale", "ai-design-agent"), { recursive: true });
    expect(probe.dirHasFiles("content/scale/ai-design-agent")).toBe(false);
    // Any filename the agent invents flips it - no index.md required.
    writeFileSync(join(ws, "content", "scale", "ai-design-agent", "ai-uiux-generation.md"), "# page");
    expect(probe.dirHasFiles("content/scale/ai-design-agent")).toBe(true);
    // A FILE at the path (not a dir) reads false, and a traversal stays jailed.
    expect(probe.dirHasFiles("content/scale/ai-design-agent/ai-uiux-generation.md")).toBe(false);
    expect(probe.dirHasFiles("..")).toBe(false);
  });
});
