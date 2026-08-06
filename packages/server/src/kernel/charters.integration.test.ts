import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let temp: string;
let database: typeof import("../db/index.js");
let kernelSchema: typeof import("../db/kernel-schema.js");
let prodSchema: typeof import("../db/schema.js");
let prodStore: typeof import("../db/store.js");
let charters: typeof import("./charters.js");
let kernel: typeof import("./applyTransition.js");
let ids: typeof import("./ids.js");
let objectApi: typeof import("./objectApi.js");
let mirrorApi: typeof import("./mirrorApi.js");
let views: typeof import("./views.js");

const TEAM = "team-charters";
const LOOP = "loop-charters";
const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T01:00:00.000Z";
const T2 = "2026-08-06T02:00:00.000Z";
const owner = { entrance: "human", actorId: "u-owner" } as const;
const run = { entrance: "agent", actorId: "run-charter" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-charters-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  kernelSchema = await import("../db/kernel-schema.js");
  prodSchema = await import("../db/schema.js");
  prodStore = await import("../db/store.js");
  charters = await import("./charters.js");
  kernel = await import("./applyTransition.js");
  ids = await import("./ids.js");
  objectApi = await import("./objectApi.js");
  mirrorApi = await import("./mirrorApi.js");
  views = await import("./views.js");
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(kernelSchema.events);
  await database.db.delete(kernelSchema.objects);
  await database.db.delete(prodSchema.runs);
  await database.db.delete(prodSchema.loops);
  await prodStore.createLoop({
    id: LOOP,
    userId: "u-owner",
    teamId: TEAM,
    machineId: "m-charters",
    name: "Daily charter",
    cron: "0 7 * * *",
    timezone: "UTC",
    enabled: true,
    notify: "auto",
  });
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function code(result: { ok: boolean; error?: { code: string } }): string {
  return result.ok ? "OK" : result.error!.code;
}

describe("attached charter identity and compare-and-swap", () => {
  it("converges concurrent ensure calls on one deterministic doc and event", async () => {
    const input = { teamId: TEAM, loopId: LOOP, loopName: "Daily charter", body: "# Charter\n", actor: owner, now: T0 };
    const [a, b] = await Promise.all([charters.ensureCharter(input), charters.ensureCharter(input)]);
    expect(value(a).charter.id).toBe(ids.charterDocId(TEAM, LOOP));
    expect(value(b).charter.id).toBe(ids.charterDocId(TEAM, LOOP));
    expect([value(a).created, value(b).created].sort()).toEqual([false, true]);
    expect(await database.db.select().from(kernelSchema.objects)).toHaveLength(1);
    expect(await database.db.select().from(kernelSchema.events)).toHaveLength(1);
    expect(value(a).charter).toMatchObject({ key: ids.charterKey(LOOP), docKind: "charter", format: "markdown", version: expect.any(Number) });
  });

  it("preserves provenance, treats same-body stale retries as no-ops, and refuses different stale bytes", async () => {
    const made = value(await charters.ensureCharter({ teamId: TEAM, loopId: LOOP, body: "one", actor: owner, now: T0 }));
    const changed = value(await charters.replaceCharter({ teamId: TEAM, loopId: LOOP, body: "two", expectedVersion: made.charter.version, actor: run, now: T1, source: "report-fallback" }));
    expect(changed.changed).toBe(true);
    const same = value(await charters.replaceCharter({ teamId: TEAM, loopId: LOOP, body: "two", expectedVersion: made.charter.version, actor: owner, now: T2, source: "owner-edit" }));
    expect(same).toMatchObject({ changed: false, charter: { version: changed.charter.version } });
    const stale = await charters.replaceCharter({ teamId: TEAM, loopId: LOOP, body: "three", expectedVersion: made.charter.version, actor: owner, now: T2, source: "owner-edit" });
    expect(code(stale)).toBe("VERSION_CONFLICT");
    expect(value(await charters.readCharter(TEAM, LOOP))?.body).toBe("two");
    const history = await database.db.select().from(kernelSchema.events);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ entrance: "human", actorId: "u-owner", kind: "object-created" });
    expect(history[1]).toMatchObject({ entrance: "agent", actorId: "run-charter", kind: "charter-updated", payload: { loopId: LOOP, source: "report-fallback" } });
  });

  it("applies file carries under the delivered version and records stale carries on the loop stream", async () => {
    const made = value(await charters.ensureCharter({ teamId: TEAM, loopId: LOOP, body: "one", actor: owner, now: T0 })).charter;
    const carried = value(await charters.applyCharterCarry({
      teamId: TEAM, loopId: LOOP, runId: "run-one", now: T1,
      candidate: { baseVersion: made.version, content: "two" },
    }));
    expect(carried).toMatchObject({ changed: true, seeded: false, charter: { body: "two" } });

    const ownerEdit = value(await charters.replaceCharter({
      teamId: TEAM, loopId: LOOP, body: "newest", expectedVersion: carried.charter!.version,
      actor: owner, now: T2, source: "owner-edit",
    })).charter;
    const stale = value(await charters.applyCharterCarry({
      teamId: TEAM, loopId: LOOP, runId: "run-stale", now: T2,
      candidate: { baseVersion: carried.charter!.version, content: "stale bytes" },
    }));
    expect(stale.warning).toMatch(/refused/);
    expect(stale.charter).toMatchObject({ body: "newest", version: ownerEdit.version });
    const conflict = (await database.db.select().from(kernelSchema.events)).find((event) => event.kind === "charter-update-conflict");
    expect(conflict).toMatchObject({ objectId: LOOP, entrance: "agent", actorId: "run-stale", payload: { expectedVersion: carried.charter!.version, currentVersion: ownerEdit.version } });
  });

  it("seeds unseeded legacy loops from complete candidates and never from a truncated tail", async () => {
    const skipped = value(await charters.applyCharterCarry({
      teamId: TEAM, loopId: LOOP, runId: "run-old", now: T0,
      legacyContent: "… (truncated — last 256KB of 600KB)\n\npartial",
    }));
    expect(skipped.charter).toBeNull();
    const seeded = value(await charters.applyCharterCarry({
      teamId: TEAM, loopId: LOOP, runId: "run-new", now: T1,
      candidate: { baseVersion: null, content: "# Complete\n" },
      legacyContent: "older",
    }));
    expect(seeded).toMatchObject({ seeded: true, changed: true, charter: { body: "# Complete\n" } });
  });

  it("refuses reserved product keys and detects a derived-id collision", async () => {
    const product = await kernel.createObject({ teamId: TEAM, kind: "doc", key: ids.charterKey(LOOP), body: "squat", actor: owner, now: T0 });
    expect(product.ok ? "OK" : product.code).toBe("RESERVED_KEY");

    await database.db.insert(kernelSchema.objects).values({
      id: ids.charterDocId(TEAM, LOOP),
      teamId: "team-foreign",
      kind: "doc",
      docKind: "product",
      status: "current",
      title: "collision",
      format: "markdown",
      body: "foreign",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(code(await charters.ensureCharter({ teamId: TEAM, loopId: LOOP, body: "mine", actor: owner, now: T0 }))).toBe("ID_COLLISION");
  });

  it("hard delete removes only the charter and its events", async () => {
    const charter = value(await charters.ensureCharter({ teamId: TEAM, loopId: LOOP, body: "charter", actor: owner, now: T0 })).charter;
    const product = await kernel.createObject({ teamId: TEAM, kind: "doc", body: "product", createdByLoop: LOOP, actor: owner, now: T0 });
    const task = await kernel.createObject({ teamId: TEAM, kind: "task", title: "keep", watcher: LOOP, createdByLoop: LOOP, actor: owner, now: T0 });
    expect(product.ok && task.ok).toBe(true);

    expect(await prodStore.deleteLoop(LOOP)).toBe(true);
    const remaining = await database.db.select().from(kernelSchema.objects);
    expect(remaining.map((row) => row.id)).not.toContain(charter.id);
    expect(remaining).toHaveLength(2);
    expect((await database.db.select().from(kernelSchema.events)).some((event) => event.objectId === charter.id)).toBe(false);
  });

  it("fences a run lease to its own loop and keeps charters out of product surfaces", async () => {
    const made = value(await charters.ensureCharter({ teamId: TEAM, loopId: LOOP, body: "charter", actor: owner, now: T0 })).charter;
    const ownLease = { teamId: TEAM, mode: "lease", actor: run, loop: { id: LOOP }, run: { id: run.actorId } } as never;
    const otherLease = { teamId: TEAM, mode: "lease", actor: run, loop: { id: "loop-other" }, run: { id: run.actorId } } as never;
    expect(code(await charters.readCharterForContext(LOOP, ownLease))).toBe("OK");
    expect(code(await charters.readCharterForContext(LOOP, otherLease))).toBe("NOT_YOUR_CHARTER");
    expect(code(await charters.replaceCharterForContext(LOOP, "changed", made.version, otherLease, new Date(T1)))).toBe("NOT_YOUR_CHARTER");

    const ownerContext = { teamId: TEAM, mode: "owner", actor: owner } as never;
    expect(code(await objectApi.showObject("doc", made.id, ownerContext))).toBe("CHARTER_ONLY");
    expect(code(await objectApi.replaceFromArtifact("doc", made.id, "---\ntitle: squat\n---\n\nbody\n", ownerContext))).toBe("CHARTER_ONLY");
    expect(code(await mirrorApi.attachMirror({ objectId: made.id, kind: "url", coords: "https://example.com" }, ownerContext))).toBe("CHARTER_ONLY");
    expect(value(await views.docsView(ownerContext)).docs).toEqual([]);
  });
});
