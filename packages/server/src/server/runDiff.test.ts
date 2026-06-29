/**
 * Phase 3 — per-run snapshot + diff. Runs the real path: gateway sync (stores
 * blobs + reconciles artifact_files) → gateway report (writes the run snapshot at
 * finalize) → computeRunDiff (lazily diffs run N vs N-1 with a pure-string text
 * diff). All against the booted gateway's in-memory blob store (no R2/creds).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let boot: typeof import("./boot.js");
let tokens: typeof import("../gateway/tokens.js");
let runDiff: typeof import("./runDiff.js");
let gw: ReturnType<typeof import("./boot.js")["getGateway"]>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-diff-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  db.runMigrations();
  store = await import("../db/store.js");
  boot = await import("./boot.js");
  tokens = await import("../gateway/tokens.js");
  runDiff = await import("./runDiff.js");
  gw = boot.getGateway();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  db.sqlite.exec("DELETE FROM run_snapshots; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", teamId: "team-u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  return { token, machineId, loop };
}

interface FileSpec {
  path: string;
  bytes: Buffer;
  binary?: boolean;
  oversize?: boolean;
}

/** One full run cycle: create the run, sync its files (run-tagged), report → snapshot. */
async function doRun(token: string, machineId: string, loopId: string, ts: string, files: FileSpec[]) {
  const run = store.addRun({ loopId, userId: "u1", machineId, phase: "running", role: "exec", ts });
  const runToken = tokens.registerRunToken({
    runId: run.id,
    loopId,
    machineId,
    role: "exec",
    allowControl: false,
    canSetUi: false,
    canSetSchema: false,
    canSetWorkflow: false,
  });
  const manifest = files.map((f) =>
    f.oversize
      ? { path: f.path, hash: sha256(f.bytes), size: f.bytes.length, oversize: true }
      : { path: f.path, hash: sha256(f.bytes), size: f.bytes.length, binary: !!f.binary },
  );
  const blobs = files
    .filter((f) => !f.oversize)
    .map((f) => ({ hash: sha256(f.bytes), encoding: "base64" as const, data: f.bytes.toString("base64") }));
  await gw.sync(token, { loopId, runId: run.id, manifest, blobs });
  const r = gw.report(runToken, { ok: true, durationMs: 1 });
  expect(r.status).toBe(200);
  return run;
}

test("report writes a run snapshot capturing the loop's end-state manifest", async () => {
  const { token, machineId, loop } = seed();
  const run = await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [
    { path: "report.md", bytes: Buffer.from("hello") },
  ]);
  const snap = store.getRunSnapshot(run.id);
  expect(snap).toBeDefined();
  expect(Object.keys(snap!.manifest)).toEqual(["report.md"]);
  expect(snap!.manifest["report.md"]).toMatchObject({ hash: sha256("hello"), size: 5, binary: false, oversize: false });
});

test("getRunDiff: added / modified / removed / unchanged across two runs", async () => {
  const { token, machineId, loop } = seed();
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("line one\nline two\n") },
    { path: "keep.md", bytes: Buffer.from("unchanged") },
    { path: "gone.md", bytes: Buffer.from("bye") },
  ]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [
    { path: "a.md", bytes: Buffer.from("line one\nline TWO changed\n") }, // modified
    { path: "keep.md", bytes: Buffer.from("unchanged") }, // unchanged → skipped
    { path: "new.md", bytes: Buffer.from("brand new") }, // added
    // gone.md omitted → removed
  ]);

  const diff = await runDiff.computeRunDiff(run2.id);
  expect(diff.hasSnapshot).toBe(true);
  const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
  expect(Object.keys(byPath).sort()).toEqual(["a.md", "gone.md", "new.md"]); // keep.md skipped

  expect(byPath["a.md"]!.status).toBe("modified");
  expect(byPath["a.md"]!.diff).toContain("line TWO changed");
  expect(byPath["new.md"]!.status).toBe("added");
  expect(byPath["new.md"]!.diff).toContain("brand new");
  expect(byPath["new.md"]!.sizeDelta).toBe(9);
  expect(byPath["gone.md"]!.status).toBe("removed");
  expect(byPath["gone.md"]!.sizeDelta).toBe(-3);
});

test("getRunDiff: binary/oversize change emits a size-delta marker, no inline diff", async () => {
  const { token, machineId, loop } = seed();
  const small = Buffer.from([0x00, 0x01, 0x02]);
  const bigger = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [{ path: "blob.bin", bytes: small, binary: true }]);
  const run2 = await doRun(token, machineId, loop.id, "2026-06-02T00:00:00.000Z", [{ path: "blob.bin", bytes: bigger, binary: true }]);

  const diff = await runDiff.computeRunDiff(run2.id);
  const f = diff.files.find((x) => x.path === "blob.bin")!;
  expect(f.status).toBe("modified");
  expect(f.binary).toBe(true);
  expect(f.diff).toBeUndefined();
  expect(f.sizeDelta).toBe(2);
});

test("getRunDiff: first run (no previous snapshot) shows everything as added", async () => {
  const { token, machineId, loop } = seed();
  const run = await doRun(token, machineId, loop.id, "2026-06-01T00:00:00.000Z", [{ path: "first.md", bytes: Buffer.from("hi") }]);
  const diff = await runDiff.computeRunDiff(run.id);
  expect(diff.hasSnapshot).toBe(true);
  expect(diff.files.map((f) => [f.path, f.status])).toEqual([["first.md", "added"]]);
});

test("getRunDiff degrades cleanly for a run with no snapshot (predates the feature)", async () => {
  const { machineId, loop } = seed();
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-05-01T00:00:00.000Z" });
  const diff = await runDiff.computeRunDiff(run.id);
  expect(diff).toEqual({ hasSnapshot: false, files: [] });
});
