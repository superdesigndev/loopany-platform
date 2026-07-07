/**
 * Phase 2 — web artifact reads. Drives the gateway's in-memory blob store
 * (no R2/creds) through `getGateway()` so the read helpers resolve the same
 * bytes the sync wrote. Covers the list/text/binary/oversize/not-found server-fn
 * core, the download route's byte resolver (path-safety + 404s), and the shared
 * loopInScope authorization predicate.
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
let artifacts: typeof import("./artifactFiles.js");
let auth: typeof import("../auth.js");
let gw: Awaited<ReturnType<typeof import("./boot.js")["getGateway"]>>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-art2-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  boot = await import("./boot.js");
  tokens = await import("../gateway/tokens.js");
  artifacts = await import("./artifactFiles.js");
  auth = await import("../auth.js");
  gw = await boot.getGateway();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec("DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = await store.createLoop({ userId: "u1", teamId: "team-u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  return { token, machineId, loop };
}

/** Sync one inline file (text or binary bytes) and return its hash. */
async function syncFile(token: string, loopId: string, p: string, bytes: Buffer, binary = false) {
  const hash = sha256(bytes);
  await gw.sync(token, {
    loopId,
    manifest: [{ path: p, hash, size: bytes.length, binary }],
    blobs: [{ hash, encoding: "base64", data: bytes.toString("base64") }],
  });
  return hash;
}

test("listLoopArtifacts returns path-sorted summaries; readLoopArtifact decodes text", async () => {
  const { token, loop } = await seed();
  // One full-manifest sync (each sync is a complete reconciliation, not append).
  const z = Buffer.from("# Z");
  const b = Buffer.from("hello");
  await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "z.md", hash: sha256(z), size: z.length },
      { path: "a/b.txt", hash: sha256(b), size: b.length },
    ],
    blobs: [
      { hash: sha256(z), encoding: "base64", data: z.toString("base64") },
      { hash: sha256(b), encoding: "base64", data: b.toString("base64") },
    ],
  });

  const list = await artifacts.listLoopArtifacts(loop.id);
  expect(list.map((f) => f.path)).toEqual(["a/b.txt", "z.md"]); // path-sorted
  expect(list[0]).toMatchObject({ path: "a/b.txt", size: 5, binary: false, oversize: false });
  expect(typeof list[0]!.updatedAt).toBe("string");

  const content = await artifacts.readLoopArtifact(loop.id, "a/b.txt");
  expect(content).toEqual({ text: "hello" });
});

test("readLoopArtifact returns a binary marker for binary files (download-only)", async () => {
  const { token, loop } = await seed();
  await syncFile(token, loop.id, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x4e]), true);
  const content = await artifacts.readLoopArtifact(loop.id, "logo.png");
  expect(content).toEqual({ binary: true, size: 4, oversize: false });
});

test("readLoopArtifact marks oversize (metadata-only) files; no bytes are read", async () => {
  const { token, loop } = await seed();
  await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "big.bin", hash: sha256("x"), size: 20 * 1024 * 1024, oversize: true }],
  });
  const content = await artifacts.readLoopArtifact(loop.id, "big.bin");
  expect(content).toEqual({ binary: true, size: 20 * 1024 * 1024, oversize: true });
});

test("readLoopArtifact reports not-found for unknown + tombstoned paths", async () => {
  const { token, loop } = await seed();
  await syncFile(token, loop.id, "keep.md", Buffer.from("a"));
  expect(await artifacts.readLoopArtifact(loop.id, "nope.md")).toEqual({ error: "file not found" });

  // Re-sync without keep.md → it tombstones → no longer readable inline.
  await gw.sync(token, { loopId: loop.id, manifest: [] });
  expect(await artifacts.readLoopArtifact(loop.id, "keep.md")).toEqual({ error: "file not found" });
});

test("readLoopArtifactBytes: path-safe (400), oversize/missing (404), valid bytes (200)", async () => {
  const { token, loop } = await seed();
  const bytes = Buffer.from("downloadable");
  await syncFile(token, loop.id, "data/raw.json", bytes, false);

  // Traversal / absolute → rejected before any blob lookup.
  expect((await artifacts.readLoopArtifactBytes(loop.id, "../../etc/passwd")).status).toBe(400);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "/abs")).status).toBe(400);

  // Valid file → bytes stream with the basename as filename.
  const ok = await artifacts.readLoopArtifactBytes(loop.id, "data/raw.json");
  expect(ok.status).toBe(200);
  expect(ok.bytes!.toString()).toBe("downloadable");
  expect(ok.filename).toBe("raw.json");

  // Oversize has no stored bytes → 404.
  await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "data/raw.json", hash: sha256(bytes), size: bytes.length }, { path: "huge.bin", hash: sha256("h"), size: 20 * 1024 * 1024, oversize: true }],
    blobs: [{ hash: sha256(bytes), encoding: "base64", data: bytes.toString("base64") }],
  });
  expect((await artifacts.readLoopArtifactBytes(loop.id, "huge.bin")).status).toBe(404);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "ghost.md")).status).toBe(404);
});

test("loopInScope gates by team (open mode + admin all-teams see everything)", () => {
  const open = { enforce: false, userId: null, teamId: "team-shared", isAdmin: false, allTeams: false };
  expect(auth.loopInScope("team-x", open)).toBe(true); // open mode ⇒ all visible

  const scoped = { enforce: true, userId: "u1", teamId: "team-u1", isAdmin: false, allTeams: false };
  expect(auth.loopInScope("team-u1", scoped)).toBe(true);
  expect(auth.loopInScope("team-other", scoped)).toBe(false);

  const admin = { enforce: true, userId: "a", teamId: "team-a", isAdmin: true, allTeams: true };
  expect(auth.loopInScope("team-anything", admin)).toBe(true);
});
