/**
 * THE COLLISION PATHS, against a real pglite database.
 *
 * Short ids (design §8) make a collision an ordinary event rather than a
 * theoretical one, so the two halves of the posture are proven here rather than
 * reasoned about:
 *
 *   ORGANIC  — a fresh random id carries no identity, so a taken number is a
 *              mistake with a cheap fix: draw again inside the same transaction.
 *              The failure this rules out is the dangerous one — resolving the
 *              swallowed insert into the STRANGER'S row and reporting it to the
 *              caller as an idempotent replay.
 *   DERIVED  — a derived id is never re-minted, because being a pure function of
 *              its seed IS replay idempotency. A repeated derivation must stay
 *              exactly one row, forever.
 *
 * The mint is scripted through a partial mock of `ids.js`: the module under test
 * imports it, so handing back an already-taken id is the honest way to stage a
 * collision without waiting ~5,000 rows for one to happen by itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Ids the scripted mint hands out before falling back to real randomness. */
const scripted = vi.hoisted(() => ({ objects: [] as string[], events: [] as string[], runs: [] as string[] }));

vi.mock("./ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ids.js")>();
  return {
    ...actual,
    newObjectId: (kind: never, attempt = 0, random?: never) =>
      scripted.objects.shift() ?? actual.newObjectId(kind, attempt, random),
    organicEventId: (attempt = 0, random?: never) => scripted.events.shift() ?? actual.organicEventId(attempt, random),
    newRunId: (attempt = 0, random?: never) => scripted.runs.shift() ?? actual.newRunId(attempt, random),
  };
});

let tmp: string;
let db: typeof import("../db/index.js");
let kernelStore: typeof import("../db/kernelStore.js");
let kernel: typeof import("./applyTransition.js");
let ids: typeof import("./ids.js");
let schema: typeof import("../db/kernel-schema.js");
let runQueue: typeof import("./runQueue.js");
let runsTable: typeof import("../db/schema.js").runs;

const TEAM = "team-alpha";
const AGENT = { entrance: "agent", actorId: "run-4a19c2" } as const;
const HUMAN = { entrance: "human", actorId: "u_alice" } as const;
const T0 = "2026-08-03T07:00:00.000Z";
const T1 = "2026-08-03T08:00:00.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-idcollision-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";

  db = await import("../db/index.js");
  await db.runMigrations();
  kernelStore = await import("../db/kernelStore.js");
  kernel = await import("./applyTransition.js");
  ids = await import("./ids.js");
  schema = await import("../db/kernel-schema.js");
  runQueue = await import("./runQueue.js");
  runsTable = (await import("../db/schema.js")).runs;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  scripted.objects.length = 0;
  scripted.events.length = 0;
  scripted.runs.length = 0;
  await db.db.delete(schema.events);
  await db.db.delete(schema.objects);
  await db.db.delete(runsTable);
});

async function task(over: Record<string, unknown> = {}) {
  const r = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, title: "t", ...over });
  if (!r.ok) throw new Error(`fixture create failed: ${r.code} ${r.message}`);
  return r;
}

async function loop(over: Record<string, unknown> = {}) {
  const r = await kernel.createObject({
    teamId: TEAM, kind: "loop", actor: HUMAN, now: T0, title: "Housekeeper", cron: "0 7 * * *", nextFire: T1, ...over,
  });
  if (!r.ok) throw new Error(`fixture create failed: ${r.code} ${r.message}`);
  return r.object;
}

// ------------------------------------------------------------------- organic

describe("an organic object id collision", () => {
  it("re-mints instead of resolving the stranger's row as a replay", async () => {
    const first = await task({ title: "Observe the impact of PR #201" });
    scripted.objects.push(first.object.id); // the next mint draws a taken number

    const second = await task({ title: "Draft the pricing FAQ" });

    expect(second.created).toBe(true);
    expect(second.object.id).not.toBe(first.object.id);
    expect(second.object.title).toBe("Draft the pricing FAQ");
    // The stranger is untouched — this is the whole point of the retry.
    expect((await kernelStore.getObject(undefined, first.object.id))!.title).toBe("Observe the impact of PR #201");
    expect(await db.db.select().from(schema.objects)).toHaveLength(2);
  });

  it("keeps re-minting across a run of collisions, and still lands the shape", async () => {
    const first = await task({ title: "one" });
    scripted.objects.push(first.object.id, first.object.id, first.object.id);

    const second = await task({ title: "two" });

    expect(second.created).toBe(true);
    expect(second.object.id).toMatch(/^task-[0-9a-f]{6,}$/);
    expect(second.object.id).not.toBe(first.object.id);
  });

  it("fails LOUDLY rather than returning a stranger when the ladder is exhausted", async () => {
    const first = await task({ title: "one" });
    for (let i = 0; i < ids.ORGANIC_MINT_ATTEMPTS; i++) scripted.objects.push(first.object.id);

    await expect(task({ title: "two" })).rejects.toThrow(/could not mint a free task id/);
    expect(await db.db.select().from(schema.objects)).toHaveLength(1);
  });

  it("still honours KEY idempotency — a keyed re-create is a replay, never a re-mint", async () => {
    const first = await task({ key: "pr-201-impact", title: "Observe the impact of PR #201" });
    scripted.objects.push("task-ffffff"); // a free id: only the key can swallow this

    const again = await task({ key: "pr-201-impact", title: "Observe the impact of PR #201" });

    expect(again.created).toBe(false);
    expect(again.object.id).toBe(first.object.id);
    expect(await db.db.select().from(schema.objects)).toHaveLength(1);
  });
});

describe("an organic event id collision", () => {
  it("re-mints, so two real facts stay two rows", async () => {
    const t = await task({ title: "one" });
    const first = await kernel.applyUpdate({ objectId: t.object.id, actor: AGENT, now: T0, fields: { title: "two" } });
    if (!first.ok || !first.event) throw new Error("fixture update failed");
    scripted.events.push(first.event.id);

    const second = await kernel.applyUpdate({ objectId: t.object.id, actor: AGENT, now: T1, fields: { title: "three" } });

    expect(second.ok && second.changed).toBe(true);
    expect(second.ok && second.event!.id).not.toBe(first.event.id);
    // created + two updates: the second update is NOT swallowed as a dedup hit.
    expect(await kernelStore.listObjectEvents(undefined, t.object.id)).toHaveLength(3);
  });

  it("re-mints on the ORGANIC transition path too (a close is not a re-derivable fact)", async () => {
    const a = await task({ title: "a" });
    const b = await task({ title: "b" });
    const closedA = await kernel.applyTransition({ objectId: a.object.id, transition: "close", actor: AGENT, now: T0, note: "done" });
    if (!closedA.ok) throw new Error("fixture close failed");
    scripted.events.push(closedA.event.id);

    const closedB = await kernel.applyTransition({ objectId: b.object.id, transition: "close", actor: AGENT, now: T1, note: "done" });

    expect(closedB.ok && closedB.replay).toBe(false);
    expect(closedB.ok && closedB.event.id).not.toBe(closedA.event.id);
    expect((await kernelStore.getObject(undefined, b.object.id))!.status).toBe("closed");
  });
});

describe("an organic run id collision", () => {
  it("re-mints a manual fire rather than reporting the stranger's run as a replay", async () => {
    const first = await loop({ key: "hk" });
    const second = await loop({ key: "fu", title: "FollowUp" });
    const one = await db.db.transaction(async (tx) =>
      runQueue.queueKernelRun(tx as never, { loop: first, now: T0, reason: "manual" }),
    );
    scripted.runs.push(one.run!.id);

    const two = await db.db.transaction(async (tx) =>
      runQueue.queueKernelRun(tx as never, { loop: second, now: T0, reason: "manual" }),
    );

    expect(two.outcome).toBe("queued");
    expect(two.run!.id).not.toBe(one.run!.id);
    expect(two.run!.loopId).toBe(second.id);
  });
});

// ------------------------------------------------------------------- derived

describe("a derived id", () => {
  it("is NEVER re-minted: a repeated derivation resolves to the one row", async () => {
    const id = ids.reportDocId("run-4a19c2");
    const first = await kernel.createObject({ id, teamId: TEAM, kind: "doc", actor: AGENT, now: T0, title: "report", body: "a" });
    const again = await kernel.createObject({ id, teamId: TEAM, kind: "doc", actor: AGENT, now: T1, title: "report", body: "a" });

    expect(first.ok && first.created).toBe(true);
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.object.id).toBe(id);
    expect(await db.db.select().from(schema.objects)).toHaveLength(1);
  });

  it("survives a scripted organic mint entirely — the explicit id wins", async () => {
    const id = ids.autoPauseTaskId("loop-4c1d77", "run-4a19c2");
    scripted.objects.push("task-ffffff");
    const created = await kernel.createObject({ id, teamId: TEAM, kind: "task", actor: AGENT, now: T0, title: "paused" });
    expect(created.ok && created.object.id).toBe(id);
  });

  it("keeps its derived event a single row across repeated derivations", async () => {
    const l = await loop();
    const one = await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T0, derivedFrom: { runId: "run-4a19c2", streak: 10 } });
    const two = await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: { runId: "run-4a19c2", streak: 10 } });

    expect(one.ok && one.replay).toBe(false);
    expect(two.ok && two.replay).toBe(true);
    expect(one.ok && two.ok && one.event.id).toBe(two.ok ? two.event.id : "");
    expect(await kernelStore.countEventsById(undefined, one.ok ? one.event.id : "")).toBe(1);
  });
});
