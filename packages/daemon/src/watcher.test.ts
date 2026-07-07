/**
 * WatchManager.reconcile — the LOCAL roots jail: workdir/taskFile in the watch
 * specs are SERVER-SENT, so when LOOPANY_ROOTS is set a folder outside it is
 * never watched (and therefore never synced out), while in-jail folders and the
 * daemon's own scratch dir still are. No network is hit: watchers are closed
 * before their debounced first flush fires.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LOOPANY_DIR } from "./config.js";
import { WatchManager } from "./watcher.js";

let root: string;
let mgr: WatchManager | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-watch-"));
});
afterEach(async () => {
  await mgr?.closeAll();
  mgr = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("WatchManager.reconcile — local roots jail", () => {
  test("with no local roots every existing folder is watched (unchanged default)", () => {
    const a = path.join(root, "a");
    fs.mkdirSync(a);
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x");
    mgr.reconcile([{ loopId: "l1", workdir: a, taskFile: null }]);
    expect(mgr.watchedDirs().get("l1")).toBe(a);
  });

  test("a folder outside LOOPANY_ROOTS is never watched; one inside is", () => {
    const jail = path.join(root, "jail");
    const inside = path.join(jail, "loop");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    mgr.reconcile([
      { loopId: "in", workdir: inside, taskFile: null },
      { loopId: "out", workdir: outside, taskFile: null },
    ]);
    expect(mgr.watchedDirs().get("in")).toBe(inside);
    expect(mgr.watchedDirs().has("out")).toBe(false);
  });

  test("a server-sent taskFile outside the jail is confined too (dirname(taskFile) wins the resolution)", () => {
    const jail = path.join(root, "jail");
    const inside = path.join(jail, "loop");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    // workdir looks innocent, but the absolute taskFile drags the watch dir out of jail.
    mgr.reconcile([{ loopId: "sneaky", workdir: inside, taskFile: path.join(outside, "README.md") }]);
    expect(mgr.watchedDirs().has("sneaky")).toBe(false);
  });

  test("a taskFile with unresolved `..` cannot escape the jail via the lexical prefix (traversal)", () => {
    const jail = path.join(root, "jail");
    const outside = path.join(root, "outside");
    fs.mkdirSync(jail, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    // Lexically under the jail ("/…/jail/../outside/…"), but resolving OUTSIDE it —
    // a raw startsWith prefix check would admit this and watch/sync the real folder.
    mgr.reconcile([{ loopId: "traversal", workdir: null, taskFile: `${jail}/../outside/README.md` }]);
    expect(mgr.watchedDirs().has("traversal")).toBe(false);
  });

  test("syncPaths extras join the watch (prefixed), out-of-jail extras drop while the loop folder stays watched", () => {
    const jail = path.join(root, "jail");
    const loopDir = path.join(jail, "repo", "loopany", "loop");
    const signals = path.join(jail, "repo", "signals");
    const outside = path.join(root, "outside");
    fs.mkdirSync(loopDir, { recursive: true });
    fs.mkdirSync(signals, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [jail]);
    mgr.reconcile([
      { loopId: "l1", workdir: path.join(jail, "repo"), taskFile: path.join(loopDir, "README.md"), syncPaths: ["signals", outside] },
    ]);
    expect(mgr.watchedDirs().get("l1")).toBe(loopDir);
    const key = mgr.watchedRoots().get("l1")!;
    expect(key).toContain(`signals ${signals}`);
    expect(key).not.toContain(outside);
  });

  test("a syncPaths change (via .loopany-sync.json) reshapes the watch on the next reconcile", () => {
    const repo = path.join(root, "repo");
    const loopDir = path.join(repo, "loop");
    const extra = path.join(repo, "briefs");
    fs.mkdirSync(loopDir, { recursive: true });
    fs.mkdirSync(extra, { recursive: true });
    mgr = new WatchManager("http://127.0.0.1:1", "dk_x");
    const spec = { loopId: "l1", workdir: repo, taskFile: path.join(loopDir, "README.md") };
    mgr.reconcile([spec]);
    const before = mgr.watchedRoots().get("l1")!;
    expect(before).not.toContain("briefs");
    fs.writeFileSync(path.join(loopDir, ".loopany-sync.json"), JSON.stringify({ syncPaths: ["briefs"] }));
    mgr.reconcile([spec]);
    const after = mgr.watchedRoots().get("l1")!;
    expect(after).toContain(`briefs ${extra}`);
  });

  test("the daemon-owned scratch dir stays allowed under a jail (its location is local, not server-chosen)", () => {
    const scratchLoop = `watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const scratchDir = path.join(LOOPANY_DIR, "work", scratchLoop);
    fs.mkdirSync(scratchDir, { recursive: true });
    try {
      mgr = new WatchManager("http://127.0.0.1:1", "dk_x", [path.join(root, "jail")]);
      // No workdir/taskFile → resolveLoopDir falls back to the per-loop scratch dir.
      mgr.reconcile([{ loopId: scratchLoop, workdir: null, taskFile: null }]);
      expect(mgr.watchedDirs().get(scratchLoop)).toBe(scratchDir);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
