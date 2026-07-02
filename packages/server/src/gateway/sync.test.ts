import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { MemoryBlobStore } from "./blobstore.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-sync-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.sqlite.exec("DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

const scheduler = {
  maybeFlagEvolve(): void {},
  finishEvolution(): void {},
  finishEdit(): void {},
  addLoop(): void {},
  removeLoop(): void {},
  runNow(): void {},
} as any;

/** A gateway with an injected in-memory blob store we can assert against. */
function gatewayWithStore(): { gw: InstanceType<typeof gatewayMod.MachineGateway>; blobs: MemoryBlobStore } {
  const blobs = new MemoryBlobStore();
  return { gw: new gatewayMod.MachineGateway(scheduler, blobs), blobs };
}

/** A registered machine (by device token) + a loop bound to it. */
function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  return { token, machineId, loop };
}

test("negotiated upload: manifest → needHashes → PUT blob lands bytes in the store", async () => {
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const content = "# Breakfast report\n4g dispensed\n";
  const hash = sha256(content);

  // 1. Post the manifest only — server has no bytes yet → it asks for the hash.
  const r1 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash, size: content.length }],
  });
  expect(r1.status).toBe(200);
  expect((r1.body as any).needHashes).toEqual([hash]);
  expect(await blobs.has(hash)).toBe(false); // not stored until the PUT

  // artifact_files already reflects the file (hash recorded, pointing at the pending blob).
  const files = store.listArtifacts(loop.id);
  expect(files.map((f) => f.path)).toEqual(["report.md"]);
  expect(files[0]!.hash).toBe(hash);
  expect(files[0]!.deleted).toBe(false);

  // 2. PUT the bytes → they land in the blob store + a blobs row is recorded.
  const put = await gw.putBlob(token, hash, Buffer.from(content));
  expect(put.status).toBe(200);
  expect((await blobs.get(hash))!.toString()).toBe(content);
  expect(store.blobExists(hash)).toBe(true);

  // 3. Re-sync the unchanged manifest → content-addressed dedupe ⇒ zero uploads.
  const r2 = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash, size: content.length }],
  });
  expect((r2.body as any).needHashes).toEqual([]);
});

test("inline small text blobs are stored in one round-trip (no needHashes)", async () => {
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const content = "hello inline";
  const hash = sha256(content);

  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "note.txt", hash, size: content.length }],
    blobs: [{ hash, encoding: "base64", data: Buffer.from(content).toString("base64") }],
  });
  expect(r.status).toBe(200);
  expect((r.body as any).needHashes).toEqual([]);
  expect((await blobs.get(hash))!.toString()).toBe(content);
});

test("inline blob whose bytes don't match its hash is rejected (anti-poisoning) → needs PUT", async () => {
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const claimed = sha256("the real bytes");

  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "f.txt", hash: claimed, size: 14 }],
    blobs: [{ hash: claimed, encoding: "base64", data: Buffer.from("WRONG bytes").toString("base64") }],
  });
  // The poisoned inline blob is dropped → the server still needs the hash.
  expect((r.body as any).needHashes).toEqual([claimed]);
  expect(await blobs.has(claimed)).toBe(false);
});

test("files over 10MB are recorded as metadata only (no bytes, no needHashes)", async () => {
  const { token, loop } = seed();
  const { gw } = gatewayWithStore();
  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "big.bin", hash: sha256("x"), size: 11 * 1024 * 1024, oversize: true }],
  });
  expect((r.body as any).needHashes).toEqual([]);
  const file = store.getArtifactFile(loop.id, "big.bin")!;
  expect(file.oversize).toBe(true);
  expect(file.hash).toBeNull();
  expect(file.size).toBe(11 * 1024 * 1024);
});

test("a size over the cap is treated as oversize even if oversize flag is absent", async () => {
  const { token, loop } = seed();
  const { gw } = gatewayWithStore();
  const hash = sha256("doesn't matter");
  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "huge.dat", hash, size: 20 * 1024 * 1024 }],
  });
  expect((r.body as any).needHashes).toEqual([]); // server won't request oversize bytes
  expect(store.getArtifactFile(loop.id, "huge.dat")!.oversize).toBe(true);
});

test("ignore rules keep .git / node_modules / secrets out entirely (server defense in depth)", async () => {
  const { token, loop } = seed();
  const { gw } = gatewayWithStore();
  const h = (s: string) => sha256(s);
  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "report.md", hash: h("ok"), size: 2 },
      { path: ".git/config", hash: h("g"), size: 1 },
      { path: "node_modules/dep/index.js", hash: h("n"), size: 1 },
      { path: ".env", hash: h("e"), size: 1 },
      { path: "secrets/server.pem", hash: h("p"), size: 1 },
      { path: "nested/id_rsa", hash: h("k"), size: 1 },
    ],
  });
  expect(r.status).toBe(200);
  // Only the report survives; everything ignored never becomes an artifact row.
  expect(store.listArtifacts(loop.id).map((f) => f.path)).toEqual(["report.md"]);
  // …and the server never asked for any secret/junk hash.
  expect((r.body as any).needHashes).toEqual([h("ok")]);
});

test("path traversal / absolute paths are rejected", async () => {
  const { token, loop } = seed();
  const { gw } = gatewayWithStore();
  const r = await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "../../etc/passwd", hash: sha256("a"), size: 1 },
      { path: "/abs/path", hash: sha256("b"), size: 1 },
      { path: "ok/file.txt", hash: sha256("c"), size: 1 },
    ],
  });
  expect(store.listArtifacts(loop.id).map((f) => f.path)).toEqual(["ok/file.txt"]);
});

test("deletions: a path absent from the manifest is tombstoned, not hard-deleted", async () => {
  const { token, loop } = seed();
  const { gw } = gatewayWithStore();
  const a = sha256("a-content");
  const b = sha256("b-content");

  await gw.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "a.md", hash: a, size: 9 },
      { path: "b.md", hash: b, size: 9 },
    ],
  });
  expect(store.listArtifacts(loop.id).map((f) => f.path)).toEqual(["a.md", "b.md"]);

  // Re-sync with b.md gone → it tombstones (drops out of the live set, kept as a row).
  await gw.sync(token, { loopId: loop.id, manifest: [{ path: "a.md", hash: a, size: 9 }] });
  expect(store.listArtifacts(loop.id).map((f) => f.path)).toEqual(["a.md"]);
  const tomb = store.getArtifactFile(loop.id, "b.md")!;
  expect(tomb.deleted).toBe(true);
  expect(tomb.hash).toBeNull();
});

test("runId is attributed onto the synced file when it names a run on the loop", async () => {
  const { token, machineId, loop } = seed();
  const { gw } = gatewayWithStore();
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const hash = sha256("from a run");
  await gw.sync(token, {
    loopId: loop.id,
    runId: run.id,
    manifest: [{ path: "out.md", hash, size: 10 }],
  });
  expect(store.getArtifactFile(loop.id, "out.md")!.lastRunId).toBe(run.id);

  // A runId for a different loop is ignored (not attributed).
  await gw.sync(token, { loopId: loop.id, runId: "run-bogus", manifest: [{ path: "out.md", hash, size: 10 }] });
  expect(store.getArtifactFile(loop.id, "out.md")!.lastRunId).toBeNull();
});

test("device-token auth: unknown machine 401; a loop on another machine 404", async () => {
  const { loop } = seed();
  const { gw } = gatewayWithStore();
  const stranger = tokens.mintDeviceToken();
  const unknown = await gw.sync(stranger, { loopId: loop.id, manifest: [] });
  expect(unknown.status).toBe(401);

  // A registered machine that doesn't own the loop → 404.
  const otherToken = tokens.mintDeviceToken();
  const otherId = tokens.machineIdFromToken(otherToken);
  store.createMachine({ id: otherId, userId: "u2", name: "B", tokenHash: tokens.sha256(otherToken), online: true });
  const wrong = await gw.sync(otherToken, { loopId: loop.id, manifest: [] });
  expect(wrong.status).toBe(404);
});

test("putBlob rejects a hash that doesn't match the body, and a bad hash format", async () => {
  const { token, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const realHash = sha256("real");
  // The handshake first: sync writes the referencing row + asks for the hash
  // (an unsolicited PUT is refused outright — see the upload-gate test below).
  await gw.sync(token, { loopId: loop.id, manifest: [{ path: "real.txt", hash: realHash, size: 4 }] });

  const mismatch = await gw.putBlob(token, realHash, Buffer.from("tampered"));
  expect(mismatch.status).toBe(400);
  expect(await blobs.has(realHash)).toBe(false);

  const badFormat = await gw.putBlob(token, "not-a-hash", Buffer.from("x"));
  expect(badFormat.status).toBe(400);

  const ok = await gw.putBlob(token, realHash, Buffer.from("real"));
  expect(ok.status).toBe(200);
  expect(store.blobExists(realHash)).toBe(true);
});

test("putBlob refuses a blob the sync handshake never asked this machine for (403, no write amplification)", async () => {
  const { token } = seed();
  const { gw, blobs } = gatewayWithStore();

  // A well-formed, self-consistent blob that NO artifact_files row references —
  // accepting it would make any device token an uncapped R2 write channel.
  const content = "unsolicited bytes";
  const hash = sha256(content);
  const res = await gw.putBlob(token, hash, Buffer.from(content));
  expect(res.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);
  expect(store.blobExists(hash)).toBe(false);
});

test("putBlob refuses a hash only ANOTHER machine's loop references (per-machine scoping)", async () => {
  const { token: tokenA, loop } = seed();
  const { gw, blobs } = gatewayWithStore();
  const content = "machine A's file";
  const hash = sha256(content);
  // Machine A's sync legitimately requests the hash…
  await gw.sync(tokenA, { loopId: loop.id, manifest: [{ path: "a.txt", hash, size: content.length }] });

  // …but machine B (registered, unrelated) may not supply the bytes for it.
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true });
  const denied = await gw.putBlob(tokenB, hash, Buffer.from(content));
  expect(denied.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);

  // Machine A itself still can (the handshake path is unaffected).
  const ok = await gw.putBlob(tokenA, hash, Buffer.from(content));
  expect(ok.status).toBe(200);
  expect(await blobs.has(hash)).toBe(true);
});

test("poll response carries the watch set for every loop bound to the machine", () => {
  const { token, machineId } = seed();
  // A second loop on the same machine, one with a taskFile.
  store.createLoop({ userId: "u1", machineId, name: "L2", cron: "0 0 1 1 *", enabled: true, notify: "auto", taskFile: "/proj/loopany/l2/README.md", workdir: "/proj" });
  const { gw } = gatewayWithStore();
  const res = gw.poll(token);
  const watch = (res.body as any).watch as Array<{ loopId: string; workdir: string | null; taskFile: string | null }>;
  expect(watch).toHaveLength(2);
  const withTask = watch.find((w) => w.taskFile)!;
  expect(withTask.taskFile).toBe("/proj/loopany/l2/README.md");
  expect(withTask.workdir).toBe("/proj");
});
