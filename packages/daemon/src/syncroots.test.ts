/**
 * resolveSyncRoots — extra watch/sync folders. Path resolution (workdir-relative
 * / absolute), prefixes (basename default, `as` override), the LOOPANY_ROOTS
 * jail, nesting/collision guards, and the `.loopany-sync.json` local union.
 * Every invalid entry is SKIPPED (never fatal) so one bad path can't take the
 * healthy roots down.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LOCAL_SYNC_CONFIG, resolveSyncRoots } from "./syncroots.js";
import { resolveRoots } from "./roots.js";

let root: string;
let main: string; // the loop folder
let work: string; // the loop workdir (parent repo)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-syncroots-"));
  work = path.join(root, "repo");
  main = path.join(work, "loopany", "my-loop");
  fs.mkdirSync(main, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveSyncRoots — resolution + prefixes", () => {
  test("a workdir-relative string entry resolves against workdir with its basename as prefix", () => {
    const signals = path.join(work, "signals");
    fs.mkdirSync(signals);
    const roots = resolveSyncRoots("l1", ["signals"], main, work, []);
    expect(roots).toEqual([{ absDir: signals, prefix: "signals" }]);
  });

  test("an absolute entry works and {path, as} overrides the prefix", () => {
    const elsewhere = path.join(root, "other-repo", "out");
    fs.mkdirSync(elsewhere, { recursive: true });
    const roots = resolveSyncRoots("l1", [{ path: elsewhere, as: "ext" }], main, work, []);
    expect(roots).toEqual([{ absDir: elsewhere, prefix: "ext" }]);
  });

  test("without a workdir, relative entries resolve against the loop folder", () => {
    const sib = path.join(work, "loopany", "shared");
    fs.mkdirSync(sib, { recursive: true });
    const roots = resolveSyncRoots("l1", ["../shared"], main, null, []);
    expect(roots).toEqual([{ absDir: sib, prefix: "shared" }]);
  });

  test("a nonexistent folder and a file (non-directory) are skipped", () => {
    const file = path.join(work, "notes.md");
    fs.writeFileSync(file, "x");
    const roots = resolveSyncRoots("l1", ["missing", "notes.md"], main, work, []);
    expect(roots).toEqual([]);
  });

  test("a traversal-shaped `as` prefix is refused", () => {
    const signals = path.join(work, "signals");
    fs.mkdirSync(signals);
    expect(resolveSyncRoots("l1", [{ path: "signals", as: "../up" }], main, work, [])).toEqual([]);
    expect(resolveSyncRoots("l1", [{ path: "signals", as: "/abs" }], main, work, [])).toEqual([]);
  });
});

describe("resolveSyncRoots — jail", () => {
  test("an entry outside LOOPANY_ROOTS is skipped; one inside is kept", () => {
    const inside = path.join(work, "signals");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    const jail = resolveRoots([work]);
    const roots = resolveSyncRoots("l1", [inside, outside], main, work, jail);
    expect(roots).toEqual([{ absDir: inside, prefix: "signals" }]);
  });

  test("a relative entry cannot traverse out of the jail", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const jail = resolveRoots([work]);
    expect(resolveSyncRoots("l1", ["../outside"], main, work, jail)).toEqual([]);
  });
});

describe("resolveSyncRoots — nesting + collision guards", () => {
  test("a root inside the loop folder (already synced) and one containing it are both skipped", () => {
    const sub = path.join(main, "sub");
    fs.mkdirSync(sub);
    const roots = resolveSyncRoots("l1", [sub, work], main, work, []);
    expect(roots).toEqual([]);
  });

  test("overlapping extra roots keep only the first", () => {
    const signals = path.join(work, "signals");
    const nested = path.join(signals, "deep");
    fs.mkdirSync(nested, { recursive: true });
    const roots = resolveSyncRoots("l1", ["signals", "signals/deep"], main, work, []);
    expect(roots).toEqual([{ absDir: signals, prefix: "signals" }]);
  });

  test("a duplicate prefix and a prefix shadowing a loop-folder entry are skipped", () => {
    const a = path.join(work, "a", "reports");
    const b = path.join(work, "b", "reports");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    // Same basename → same default prefix → only the first survives.
    expect(resolveSyncRoots("l1", ["a/reports", "b/reports"], main, work, [])).toEqual([
      { absDir: a, prefix: "reports" },
    ]);
    // A prefix equal to an existing loop-folder entry would interleave two trees.
    fs.writeFileSync(path.join(main, "taken"), "x");
    const tk = path.join(work, "taken");
    fs.mkdirSync(tk);
    expect(resolveSyncRoots("l1", ["taken"], main, work, [])).toEqual([]);
  });
});

describe("resolveSyncRoots — .loopany-sync.json local union", () => {
  test("local entries union with the server-sent list (server first)", () => {
    const signals = path.join(work, "signals");
    const tickets = path.join(work, "tickets");
    fs.mkdirSync(signals);
    fs.mkdirSync(tickets);
    fs.writeFileSync(path.join(main, LOCAL_SYNC_CONFIG), JSON.stringify({ syncPaths: ["tickets"] }));
    const roots = resolveSyncRoots("l1", ["signals"], main, work, []);
    expect(roots).toEqual([
      { absDir: signals, prefix: "signals" },
      { absDir: tickets, prefix: "tickets" },
    ]);
  });

  test("an unparseable or wrongly-shaped local file is ignored, keeping server entries", () => {
    const signals = path.join(work, "signals");
    fs.mkdirSync(signals);
    fs.writeFileSync(path.join(main, LOCAL_SYNC_CONFIG), "{nope");
    expect(resolveSyncRoots("l1", ["signals"], main, work, [])).toHaveLength(1);
    fs.writeFileSync(path.join(main, LOCAL_SYNC_CONFIG), JSON.stringify({ paths: ["signals"] }));
    expect(resolveSyncRoots("l1", ["signals"], main, work, [])).toHaveLength(1);
  });
});
