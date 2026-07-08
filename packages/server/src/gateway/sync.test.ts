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
let syncMod: typeof import("./sync.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-sync-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  syncMod = await import("./sync.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
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

/** An ArtifactSync with an injected in-memory blob store we can assert against. */
function syncWithStore(): { art: InstanceType<typeof syncMod.ArtifactSync>; blobs: MemoryBlobStore } {
  const blobs = new MemoryBlobStore();
  return { art: new syncMod.ArtifactSync(blobs), blobs };
}

/** A registered machine (by device token) + a loop bound to it. */
async function seed() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  return { token, machineId, loop };
}

test("negotiated upload: manifest → needHashes → PUT blob lands bytes in the store", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const content = "# Breakfast report\n4g dispensed\n";
  const hash = sha256(content);

  // 1. Post the manifest only — server has no bytes yet → it asks for the hash.
  const r1 = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash, size: content.length }],
  });
  expect(r1.status).toBe(200);
  expect((r1.body as any).needHashes).toEqual([hash]);
  expect(await blobs.has(hash)).toBe(false); // not stored until the PUT

  // artifact_files already reflects the file (hash recorded, pointing at the pending blob).
  const files = (await store.listArtifacts(loop.id));
  expect(files.map((f) => f.path)).toEqual(["report.md"]);
  expect(files[0]!.hash).toBe(hash);
  expect(files[0]!.deleted).toBe(false);

  // 2. PUT the bytes → they land in the blob store + a blobs row is recorded.
  const put = await art.putBlob(token, hash, Buffer.from(content));
  expect(put.status).toBe(200);
  expect((await blobs.get(hash))!.toString()).toBe(content);
  expect((await store.blobExists(hash))).toBe(true);

  // 3. Re-sync the unchanged manifest → content-addressed dedupe ⇒ zero uploads.
  const r2 = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "report.md", hash, size: content.length }],
  });
  expect((r2.body as any).needHashes).toEqual([]);
});

test("inline small text blobs are stored in one round-trip (no needHashes)", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const content = "hello inline";
  const hash = sha256(content);

  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "note.txt", hash, size: content.length }],
    blobs: [{ hash, encoding: "base64", data: Buffer.from(content).toString("base64") }],
  });
  expect(r.status).toBe(200);
  expect((r.body as any).needHashes).toEqual([]);
  expect((await blobs.get(hash))!.toString()).toBe(content);
});

test("inline blob whose bytes don't match its hash is rejected (anti-poisoning) → needs PUT", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const claimed = sha256("the real bytes");

  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "f.txt", hash: claimed, size: 14 }],
    blobs: [{ hash: claimed, encoding: "base64", data: Buffer.from("WRONG bytes").toString("base64") }],
  });
  // The poisoned inline blob is dropped → the server still needs the hash.
  expect((r.body as any).needHashes).toEqual([claimed]);
  expect(await blobs.has(claimed)).toBe(false);
});

test("files over 10MB are recorded as metadata only (no bytes, no needHashes)", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "big.bin", hash: sha256("x"), size: 11 * 1024 * 1024, oversize: true }],
  });
  expect((r.body as any).needHashes).toEqual([]);
  const file = (await store.getArtifactFile(loop.id, "big.bin"))!;
  expect(file.oversize).toBe(true);
  expect(file.hash).toBeNull();
  expect(file.size).toBe(11 * 1024 * 1024);
});

test("a size over the cap is treated as oversize even if oversize flag is absent", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const hash = sha256("doesn't matter");
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "huge.dat", hash, size: 20 * 1024 * 1024 }],
  });
  expect((r.body as any).needHashes).toEqual([]); // server won't request oversize bytes
  expect((await store.getArtifactFile(loop.id, "huge.dat"))!.oversize).toBe(true);
});

test("ignore rules keep .git / node_modules / secrets out entirely (server defense in depth)", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const h = (s: string) => sha256(s);
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "report.md", hash: h("ok"), size: 2 },
      { path: ".git/config", hash: h("g"), size: 1 },
      { path: "node_modules/dep/index.js", hash: h("n"), size: 1 },
      { path: ".worktrees/2026-07-07-fix/src/App.jsx", hash: h("w"), size: 1 },
      { path: ".next/cache/blob", hash: h("c"), size: 1 },
      { path: ".env", hash: h("e"), size: 1 },
      { path: "secrets/server.pem", hash: h("p"), size: 1 },
      { path: "nested/id_rsa", hash: h("k"), size: 1 },
    ],
  });
  expect(r.status).toBe(200);
  // Only the report survives; everything ignored never becomes an artifact row.
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["report.md"]);
  // …and the server never asked for any secret/junk hash.
  expect((r.body as any).needHashes).toEqual([h("ok")]);
});

test("path traversal / absolute paths are rejected", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "../../etc/passwd", hash: sha256("a"), size: 1 },
      { path: "/abs/path", hash: sha256("b"), size: 1 },
      { path: "ok/file.txt", hash: sha256("c"), size: 1 },
    ],
  });
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["ok/file.txt"]);
});

test("deletions: a path absent from the manifest is tombstoned, not hard-deleted", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const a = sha256("a-content");
  const b = sha256("b-content");

  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "a.md", hash: a, size: 9 },
      { path: "b.md", hash: b, size: 9 },
    ],
  });
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["a.md", "b.md"]);

  // Re-sync with b.md gone → it tombstones (drops out of the live set, kept as a row).
  await art.sync(token, { loopId: loop.id, manifest: [{ path: "a.md", hash: a, size: 9 }] });
  expect((await store.listArtifacts(loop.id)).map((f) => f.path)).toEqual(["a.md"]);
  const tomb = (await store.getArtifactFile(loop.id, "b.md"))!;
  expect(tomb.deleted).toBe(true);
  expect(tomb.hash).toBeNull();
});

test("runId is attributed onto the synced file when it names a run on the loop", async () => {
  const { token, machineId, loop } = (await seed());
  const { art } = syncWithStore();
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const hash = sha256("from a run");
  await art.sync(token, {
    loopId: loop.id,
    runId: run.id,
    manifest: [{ path: "out.md", hash, size: 10 }],
  });
  expect((await store.getArtifactFile(loop.id, "out.md"))!.lastRunId).toBe(run.id);

  // A runId for a different loop is ignored (not attributed).
  await art.sync(token, { loopId: loop.id, runId: "run-bogus", manifest: [{ path: "out.md", hash, size: 10 }] });
  expect((await store.getArtifactFile(loop.id, "out.md"))!.lastRunId).toBeNull();
});

test("device-token auth: unknown machine 401; a loop on another machine 404", async () => {
  const { loop } = (await seed());
  const { art } = syncWithStore();
  const stranger = tokens.mintDeviceToken();
  const unknown = await art.sync(stranger, { loopId: loop.id, manifest: [] });
  expect(unknown.status).toBe(401);

  // A registered machine that doesn't own the loop → 404.
  const otherToken = tokens.mintDeviceToken();
  const otherId = tokens.machineIdFromToken(otherToken);
  (await store.createMachine({ id: otherId, userId: "u2", name: "B", tokenHash: tokens.sha256(otherToken), online: true }));
  const wrong = await art.sync(otherToken, { loopId: loop.id, manifest: [] });
  expect(wrong.status).toBe(404);
});

test("putBlob rejects a hash that doesn't match the body, and a bad hash format", async () => {
  const { token, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const realHash = sha256("real");
  // The handshake first: sync writes the referencing row + asks for the hash
  // (an unsolicited PUT is refused outright — see the upload-gate test below).
  await art.sync(token, { loopId: loop.id, manifest: [{ path: "real.txt", hash: realHash, size: 4 }] });

  const mismatch = await art.putBlob(token, realHash, Buffer.from("tampered"));
  expect(mismatch.status).toBe(400);
  expect(await blobs.has(realHash)).toBe(false);

  const badFormat = await art.putBlob(token, "not-a-hash", Buffer.from("x"));
  expect(badFormat.status).toBe(400);

  const ok = await art.putBlob(token, realHash, Buffer.from("real"));
  expect(ok.status).toBe(200);
  expect((await store.blobExists(realHash))).toBe(true);
});

test("putBlob refuses a blob the sync handshake never asked this machine for (403, no write amplification)", async () => {
  const { token } = (await seed());
  const { art, blobs } = syncWithStore();

  // A well-formed, self-consistent blob that NO artifact_files row references —
  // accepting it would make any device token an uncapped R2 write channel.
  const content = "unsolicited bytes";
  const hash = sha256(content);
  const res = await art.putBlob(token, hash, Buffer.from(content));
  expect(res.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);
  expect((await store.blobExists(hash))).toBe(false);
});

test("putBlob refuses a hash only ANOTHER machine's loop references (per-machine scoping)", async () => {
  const { token: tokenA, loop } = (await seed());
  const { art, blobs } = syncWithStore();
  const content = "machine A's file";
  const hash = sha256(content);
  // Machine A's sync legitimately requests the hash…
  await art.sync(tokenA, { loopId: loop.id, manifest: [{ path: "a.txt", hash, size: content.length }] });

  // …but machine B (registered, unrelated) may not supply the bytes for it.
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true }));
  const denied = await art.putBlob(tokenB, hash, Buffer.from(content));
  expect(denied.status).toBe(403);
  expect(await blobs.has(hash)).toBe(false);

  // Machine A itself still can (the handshake path is unaffected).
  const ok = await art.putBlob(tokenA, hash, Buffer.from(content));
  expect(ok.status).toBe(200);
  expect(await blobs.has(hash)).toBe(true);
});

// ---- front-matter meta indexing (batch 1) ----

const PRODUCT = `---\ntype: idea\ntitle: My Idea\ndate: 2026-07-01\n---\n\n# Body\n`;

/** The joined-out meta for a loop's live file at `path` (null when untyped). */
async function metaOf(loopId: string, path: string) {
  return (await store.listArtifactsWithMeta(loopId)).find((f) => f.path === path)?.meta ?? null;
}

test("sync inline path parses + persists front-matter meta on the blob", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const hash = sha256(PRODUCT);
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "idea.md", hash, size: PRODUCT.length }],
    blobs: [{ hash, encoding: "utf8", data: PRODUCT }],
  });
  expect(r.status).toBe(200);
  expect((await metaOf(loop.id, "idea.md"))).toEqual({ type: "idea", title: "My Idea", date: "2026-07-01" });
});

test("putBlob path parses + persists front-matter meta", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const hash = sha256(PRODUCT);
  // Manifest first (no inline) → the server asks for the hash…
  const r1 = await art.sync(token, { loopId: loop.id, manifest: [{ path: "idea.md", hash, size: PRODUCT.length }] });
  expect((r1.body as any).needHashes).toEqual([hash]);
  // …then the PUT lands the bytes and parses meta at that ingress point.
  const put = await art.putBlob(token, hash, Buffer.from(PRODUCT));
  expect(put.status).toBe(200);
  expect((await metaOf(loop.id, "idea.md"))).toEqual({ type: "idea", title: "My Idea", date: "2026-07-01" });
});

test("dedup: a re-referenced hash keeps its already-parsed meta (no re-parse needed)", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const hash = sha256(PRODUCT);
  await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "idea.md", hash, size: PRODUCT.length }],
    blobs: [{ hash, encoding: "utf8", data: PRODUCT }],
  });
  // Re-sync the SAME content under a NEW path (same hash → content-addressed dedup,
  // no bytes re-uploaded) — the new file row inherits the blob's stored meta.
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "idea.md", hash, size: PRODUCT.length },
      { path: "copy.md", hash, size: PRODUCT.length },
    ],
  });
  expect((r.body as any).needHashes).toEqual([]); // dedup: nothing re-requested
  expect((await metaOf(loop.id, "copy.md"))).toEqual({ type: "idea", title: "My Idea", date: "2026-07-01" });
});

test("malformed front matter stores null meta and never fails the sync", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const broken = "---\ntype: idea\nnever closes the fence\n"; // no closing `---`
  const plain = "# Just a heading, no front matter\n";
  const bh = sha256(broken);
  const ph = sha256(plain);
  const r = await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "broken.md", hash: bh, size: broken.length },
      { path: "plain.md", hash: ph, size: plain.length },
    ],
    blobs: [
      { hash: bh, encoding: "utf8", data: broken },
      { hash: ph, encoding: "utf8", data: plain },
    ],
  });
  expect(r.status).toBe(200);
  expect((await metaOf(loop.id, "broken.md"))).toBeNull();
  expect((await metaOf(loop.id, "plain.md"))).toBeNull();
});

test("getArtifacts (listLoopArtifacts) surfaces meta per file; null for untyped", async () => {
  const { token, loop } = (await seed());
  const { art } = syncWithStore();
  const plain = "# no front matter\n";
  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "idea.md", hash: sha256(PRODUCT), size: PRODUCT.length },
      { path: "plain.md", hash: sha256(plain), size: plain.length },
    ],
    blobs: [
      { hash: sha256(PRODUCT), encoding: "utf8", data: PRODUCT },
      { hash: sha256(plain), encoding: "utf8", data: plain },
    ],
  });
  const { listLoopArtifacts } = await import("../server/artifactFiles.js");
  const rows = await listLoopArtifacts(loop.id);
  expect(rows.find((f) => f.path === "idea.md")!.meta).toEqual({ type: "idea", title: "My Idea", date: "2026-07-01" });
  expect(rows.find((f) => f.path === "plain.md")!.meta).toBeNull();
});

test("poll response carries the watch set for every loop bound to the machine", async () => {
  const { token, machineId } = (await seed());
  // A second loop on the same machine, one with a taskFile.
  (await store.createLoop({ userId: "u1", machineId, name: "L2", cron: "0 0 1 1 *", enabled: true, notify: "auto", taskFile: "/proj/loopany/l2/README.md", workdir: "/proj" }));
  const machineGw = new gatewayMod.MachineGateway(scheduler, new MemoryBlobStore());
  const res = (await machineGw.poll(token));
  const watch = (res.body as any).watch as Array<{ loopId: string; workdir: string | null; taskFile: string | null }>;
  expect(watch).toHaveLength(2);
  const withTask = watch.find((w) => w.taskFile)!;
  expect(withTask.taskFile).toBe("/proj/loopany/l2/README.md");
  expect(withTask.workdir).toBe("/proj");
});

// ---- task-file content refresh (the create-time README gap) ----
// The loop record's taskFileContent is what the Files panel's task pane renders.
// It used to be written ONLY by report(), so a brand-new loop showed no README
// until its first run finished — even though the watcher had already synced the
// bytes. sync()/putBlob now mirror the task file's bytes onto the loop record.

/** A machine + a loop whose task file lives at an ABSOLUTE machine path (the
 *  daemon syncs paths RELATIVE to the watched folder — suffix matching applies). */
async function seedWithTaskFile(taskFile = "/home/u/loops/demo/README.md") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", taskFile }));
  return { token, machineId, loop };
}

test("syncing the task file mirrors its content onto the loop record — no run needed", async () => {
  const { token, loop } = (await seedWithTaskFile());
  const { art } = syncWithStore();
  const content = "# Demo loop\n\n## Spec\nDo the thing daily.\n";
  const hash = sha256(content);

  expect((await store.getLoop(loop.id))!.taskFileContent).toBeNull();
  await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "README.md", hash, size: content.length }],
    blobs: [{ hash, encoding: "utf8", data: content }],
  });
  const after = (await store.getLoop(loop.id))!;
  expect(after.taskFileContent).toBe(content);
  expect(after.taskFileSyncedAt).toBeTruthy();
});

test("task-file bytes arriving via PUT (over the inline cap path) also mirror onto the loop", async () => {
  const { token, loop } = (await seedWithTaskFile());
  const { art } = syncWithStore();
  const content = "# Big spec\n" + "x".repeat(100);
  const hash = sha256(content);

  // Manifest only — bytes not in hand yet ⇒ no mirror (and no stale write).
  const r1 = await art.sync(token, { loopId: loop.id, manifest: [{ path: "README.md", hash, size: content.length }] });
  expect((r1.body as any).needHashes).toEqual([hash]);
  expect((await store.getLoop(loop.id))!.taskFileContent).toBeNull();

  // The PUT lands the bytes → the loop record catches up without another sync.
  await art.putBlob(token, hash, Buffer.from(content));
  expect((await store.getLoop(loop.id))!.taskFileContent).toBe(content);
});

test("a non-task artifact never touches taskFileContent", async () => {
  const { token, loop } = (await seedWithTaskFile());
  const { art } = syncWithStore();
  const content = "not the task file";
  const hash = sha256(content);
  await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "notes.md", hash, size: content.length }],
    blobs: [{ hash, encoding: "utf8", data: content }],
  });
  expect((await store.getLoop(loop.id))!.taskFileContent).toBeNull();
});

test("best-match selection: root README wins over a nested one (same rule as the Files panel)", async () => {
  const { token, loop } = (await seedWithTaskFile());
  const { art } = syncWithStore();
  const root = "# the real spec\n";
  const nested = "# archived copy\n";
  await art.sync(token, {
    loopId: loop.id,
    manifest: [
      { path: "ARCHIVE/README.md", hash: sha256(nested), size: nested.length },
      { path: "README.md", hash: sha256(root), size: root.length },
    ],
    blobs: [
      { hash: sha256(nested), encoding: "utf8", data: nested },
      { hash: sha256(root), encoding: "utf8", data: root },
    ],
  });
  expect((await store.getLoop(loop.id))!.taskFileContent).toBe(root);
});

test("a loop without a taskFile is untouched by sync's mirror", async () => {
  const { token, loop } = (await seed()); // no taskFile
  const { art } = syncWithStore();
  const content = "README.md content on a taskFile-less loop";
  const hash = sha256(content);
  await art.sync(token, {
    loopId: loop.id,
    manifest: [{ path: "README.md", hash, size: content.length }],
    blobs: [{ hash, encoding: "utf8", data: content }],
  });
  expect((await store.getLoop(loop.id))!.taskFileContent).toBeNull();
});
