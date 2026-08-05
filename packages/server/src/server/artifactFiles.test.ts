/**
 * Web artifact reads over the server's STORED artifact history. Byte ingress
 * retired with the folder watcher, so these helpers are strictly read-only; the
 * tests seed the history the way the storage layer holds it (blob bytes into the
 * booted in-memory store via `getBlobStore()`, rows via `store`) rather than
 * through a sync that no longer exists. Covers the list/text/binary/oversize/
 * not-found server-fn core, the download route's byte resolver (path-safety +
 * 404s), and the shared canAccessLoop authorization predicate.
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
let blobs: Awaited<ReturnType<typeof import("./boot.js")["getBlobStore"]>>;

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
  blobs = await boot.getBlobStore();
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

/** Seed one stored file: bytes in the blob store, metadata + row in the DB. */
async function storeFile(loopId: string, p: string, bytes: Buffer, binary = false) {
  const hash = sha256(bytes);
  await blobs.put(hash, bytes);
  await store.recordBlob(hash, bytes.length, binary);
  await store.upsertArtifactFile({ loopId, path: p, hash, size: bytes.length, binary, oversize: false, lastRunId: null });
  return hash;
}

/** Seed one metadata-only (oversize) row: a path with a size and no bytes. */
async function storeOversize(loopId: string, p: string, size: number) {
  await store.upsertArtifactFile({ loopId, path: p, hash: null, size, binary: false, oversize: true, lastRunId: null });
}

test("listLoopArtifacts returns path-sorted summaries; readLoopArtifact decodes text", async () => {
  const { loop } = await seed();
  await storeFile(loop.id, "z.md", Buffer.from("# Z"));
  await storeFile(loop.id, "a/b.txt", Buffer.from("hello"));

  const list = await artifacts.listLoopArtifacts(loop.id);
  expect(list.map((f) => f.path)).toEqual(["a/b.txt", "z.md"]); // path-sorted
  expect(list[0]).toMatchObject({ path: "a/b.txt", size: 5, binary: false, oversize: false });
  expect(typeof list[0]!.updatedAt).toBe("string");

  const content = await artifacts.readLoopArtifact(loop.id, "a/b.txt");
  expect(content).toEqual({ text: "hello" });
});

test("readLoopArtifact returns a binary marker for binary files (download-only)", async () => {
  const { loop } = await seed();
  await storeFile(loop.id, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x4e]), true);
  const content = await artifacts.readLoopArtifact(loop.id, "logo.png");
  expect(content).toEqual({ binary: true, size: 4, oversize: false });
});

test("readLoopArtifact marks oversize (metadata-only) files; no bytes are read", async () => {
  const { loop } = await seed();
  await storeOversize(loop.id, "big.bin", 20 * 1024 * 1024);
  const content = await artifacts.readLoopArtifact(loop.id, "big.bin");
  expect(content).toEqual({ binary: true, size: 20 * 1024 * 1024, oversize: true });
});

test("readLoopArtifact reports not-found for unknown + tombstoned paths", async () => {
  const { loop } = await seed();
  await storeFile(loop.id, "keep.md", Buffer.from("a"));
  expect(await artifacts.readLoopArtifact(loop.id, "nope.md")).toEqual({ error: "file not found" });

  // A tombstoned row (a historical deletion) is no longer readable inline.
  await store.tombstoneMissingArtifacts(loop.id, [], null);
  expect(await artifacts.readLoopArtifact(loop.id, "keep.md")).toEqual({ error: "file not found" });
});

test("readLoopArtifactBytes: path-safe (400), oversize/missing (404), valid bytes (200)", async () => {
  const { loop } = await seed();
  const bytes = Buffer.from("downloadable");
  await storeFile(loop.id, "data/raw.json", bytes, false);

  // Traversal / absolute → rejected before any blob lookup.
  expect((await artifacts.readLoopArtifactBytes(loop.id, "../../etc/passwd")).status).toBe(400);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "/abs")).status).toBe(400);

  // Valid file → bytes stream with the basename as filename.
  const ok = await artifacts.readLoopArtifactBytes(loop.id, "data/raw.json");
  expect(ok.status).toBe(200);
  expect(ok.bytes!.toString()).toBe("downloadable");
  expect(ok.filename).toBe("raw.json");

  // Oversize has no stored bytes → 404.
  await storeOversize(loop.id, "huge.bin", 20 * 1024 * 1024);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "huge.bin")).status).toBe(404);
  expect((await artifacts.readLoopArtifactBytes(loop.id, "ghost.md")).status).toBe(404);
});

test("canAccessLoop authorizes by MEMBERSHIP, not the active team (cross-team-link fix)", async () => {
  // Seed: u1 is a member of two teams (their active team A + a second team B), and
  // NOT a member of team C. ensureTeam(id, name, ownerUserId) adds ownerUserId as a
  // member, which is exactly "u1 can access this team".
  await store.ensureTeam("team-cas-a", "A", "u1"); // active team
  await store.ensureTeam("team-cas-b", "B", "u1"); // other team u1 belongs to
  await store.ensureTeam("team-cas-c", "C", "u2"); // a team u1 is NOT in

  const open = { enforce: false, userId: null, teamId: "team-shared" };
  expect(await auth.canAccessLoop("team-x", open)).toBe(true); // open mode ⇒ all visible

  const scoped = { enforce: true, userId: "u1", teamId: "team-cas-a" };
  expect(await auth.canAccessLoop("team-cas-a", scoped)).toBe(true); // active team (fast path)
  // The reported bug: a loop in team B, opened while active team = A. u1 IS a member
  // of B, so it must OPEN — not return not-found.
  expect(await auth.canAccessLoop("team-cas-b", scoped)).toBe(true); // cross-team MEMBER
  // A team u1 does not belong to stays denied — indistinguishable from a missing loop.
  expect(await auth.canAccessLoop("team-cas-c", scoped)).toBe(false); // non-member

  // A signed-out request (no userId) can't fall through to a membership check.
  const anon = { enforce: true, userId: null, teamId: "team-cas-a" };
  expect(await auth.canAccessLoop("team-cas-b", anon)).toBe(false);
});
