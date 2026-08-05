/**
 * Convergence S3.2 regression: the watcher's FILE-DESCRIPTOR model.
 *
 * The live failure: the daemon's loop-folder watcher held one open fd per
 * watched FILE (chokidar v4 has no fsevents backend, so on macOS every file got
 * its own `fs.watch` ⇒ its own kqueue fd). Loops bound to whole-repo workdirs
 * warmed the daemon past `SPAWN_FD_CEILING` open fds, and from that moment every
 * `child_process.spawn` threw `spawn EBADF` — the daemon could no longer run the
 * coding agent it exists to run, until it was restarted.
 *
 * These tests pin the two halves of the fix:
 *  1. the fd CEILING itself — watching a folder with thousands of files must cost
 *     a bounded, tree-size-INDEPENDENT number of descriptors, and spawning must
 *     still work after the watcher has fully warmed up;
 *  2. the content-home CONTRACT — a loop whose folder is its own bound workspace
 *     (a checkout) syncs that folder's top-level files only, and is never even
 *     enumerated below depth 0.
 *
 * The mechanism itself (why `EBADF` and at exactly which count) is documented on
 * `SPAWN_FD_CEILING` in spawn.ts; it was measured, not assumed. We deliberately
 * do NOT exhaust 10240 descriptors inside the suite — the ceiling assertion below
 * fails on the old per-file model long before that point, and much faster.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openFdCount, SPAWN_FD_CEILING } from "./spawn.js";
import { probeFileCount, resolveHomeScope, WatchManager, type SyncFetch } from "./watcher.js";

/** Big enough that the old one-fd-per-file model is unmistakable (it would open
 *  ~4000 descriptors here), small enough to stay a fast unit test. */
const FILES = 4000;
/** The whole watch layer's descriptor budget for one loop. macOS spends 0-1 (a
 *  single FSEvents stream); Linux spends one inotify watcher per DIRECTORY. Both
 *  are independent of FILE count, which is the property under test — so a budget
 *  two orders of magnitude under `FILES` is a sharp regression fence. */
const FD_BUDGET = 200;

let root: string;
let mgr: WatchManager | undefined;

/** A sync server that accepts everything and stores nothing — these tests are
 *  about descriptors, not bytes. */
const acceptAll: SyncFetch = async () => new Response(JSON.stringify({ needHashes: [] }), { status: 200 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-fd-"));
});
afterEach(async () => {
  await mgr?.closeAll();
  mgr = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A repo-shaped tree: `.git`, a few top-level files, and `count` files spread
 *  over nested source directories. */
function makeRepo(dir: string, count: number): void {
  fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "objects", "pack"), "x");
  fs.writeFileSync(path.join(dir, "loopany-task.md"), "# Loop\n\n## Spec\n\nwork\n");
  fs.writeFileSync(path.join(dir, "README.md"), "readme");
  for (let i = 0; i < count; i++) {
    const sub = path.join(dir, "src", `pkg${Math.floor(i / 100)}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `m${i}.ts`), `export const m${i} = ${i};\n`);
  }
}

/** Can this process still spawn a child? Returns the errno when it cannot. */
function trySpawn(): string {
  const r = spawnSync("/bin/echo", ["ok"], { stdio: ["ignore", "pipe", "pipe"] });
  return r.error ? ((r.error as NodeJS.ErrnoException).code ?? "ERROR") : "ok";
}

describe("watcher fd ceiling (S3.2)", () => {
  test("warming up on a repo-scale folder costs a bounded number of descriptors, and spawning still works", async () => {
    const dir = path.join(root, "repo");
    makeRepo(dir, FILES);

    const before = openFdCount();
    expect(before).toBeGreaterThan(0); // /dev/fd readable — otherwise this test proves nothing
    expect(trySpawn()).toBe("ok");

    mgr = new WatchManager("https://srv.test", "dk_x", [], acceptAll);
    mgr.reconcile([{ loopId: "l1", workdir: dir, taskFile: path.join(dir, "loopany-task.md") }]);
    // Let the watch layer fully settle (the old model reached its full per-file
    // descriptor count within a second on a tree this size).
    await new Promise((r) => setTimeout(r, 1500));

    const growth = openFdCount() - before;
    expect(growth).toBeLessThan(FD_BUDGET); // the regression fence: NOT ~FILES
    expect(growth).toBeLessThan(FILES / 10);
    // The acceptance criterion the whole fix exists for.
    expect(trySpawn()).toBe("ok");
    expect(openFdCount()).toBeLessThan(SPAWN_FD_CEILING);
  });

  test("closing the watchers releases every descriptor it took", async () => {
    const dir = path.join(root, "repo");
    makeRepo(dir, 500);
    const before = openFdCount();
    mgr = new WatchManager("https://srv.test", "dk_x", [], acceptAll);
    mgr.reconcile([{ loopId: "l1", workdir: dir, taskFile: path.join(dir, "loopany-task.md") }]);
    await new Promise((r) => setTimeout(r, 500));
    await mgr.closeAll();
    mgr = undefined;
    await new Promise((r) => setTimeout(r, 300));
    expect(openFdCount()).toBeLessThanOrEqual(before);
  });
});

describe("content-home contract (S3.2)", () => {
  test("a loop whose folder IS its bound workspace syncs the folder root only — the checkout below it is never walked", async () => {
    const dir = path.join(root, "repo");
    makeRepo(dir, 300);

    const syncs: Array<{ manifest: Array<{ path: string }> }> = [];
    const capture: SyncFetch = async (url, init) => {
      if (url.endsWith("/api/machine/sync")) syncs.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ needHashes: [] }), { status: 200 });
    };

    mgr = new WatchManager("https://srv.test", "dk_x", [], capture);
    mgr.reconcile([{ loopId: "l1", workdir: dir, taskFile: path.join(dir, "loopany-task.md") }]);
    expect(mgr.watchedScopes().get("l1")).toBe("root-only");

    const { flushLoop } = await import("./watcher.js");
    await flushLoop("l1");

    expect(syncs).toHaveLength(1);
    const paths = syncs[0].manifest.map((e) => e.path).sort();
    // The task file plus the products beside it — and nothing from the workspace.
    expect(paths).toEqual(["README.md", "loopany-task.md"]);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
  });

  test("a dedicated loop folder inside a workspace keeps FULL recursive syncing", () => {
    const repo = path.join(root, "repo");
    makeRepo(repo, 5);
    const home = path.join(repo, "loopany", "daily-report");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "loopany-task.md"), "# Loop\n");
    fs.mkdirSync(path.join(home, "reports"));
    fs.writeFileSync(path.join(home, "reports", "2026-08-05.md"), "report");

    // The loop folder is NOT the bound workdir, so the workspace rule does not
    // fire and the folder is comfortably under the cap.
    const spec = { loopId: "l1", workdir: repo, taskFile: path.join(home, "loopany-task.md") };
    expect(resolveHomeScope(spec, home)).toEqual({ scope: "recursive", reason: null });
  });

  test("a plain (non-VCS) folder bound as workdir is a content home, not a workspace", () => {
    const dir = path.join(root, "loopfolder");
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reports", "a.md"), "a");
    expect(resolveHomeScope({ loopId: "l1", workdir: dir, taskFile: null }, dir)).toEqual({ scope: "recursive", reason: null });

    // …until a VCS marker makes it a checkout.
    fs.mkdirSync(path.join(dir, ".git"));
    expect(resolveHomeScope({ loopId: "l1", workdir: dir, taskFile: null }, dir)).toEqual({ scope: "root-only", reason: "workspace" });
  });

  test("probeFileCount aborts at the limit instead of enumerating a huge tree", () => {
    const dir = path.join(root, "big");
    makeRepo(dir, 800);
    expect(probeFileCount(dir, 50)).toBe(51); // stopped one past the limit
    expect(probeFileCount(dir, 5000)).toBe(802); // .git is ignored; 800 sources + 2 root files
  });
});
