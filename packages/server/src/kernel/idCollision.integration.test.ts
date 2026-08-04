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

/** Ids the scripted mint hands out before falling back to real randomness. The
 *  DERIVED entries stage the other half: a truncation collision between two
 *  distinct seeds, which is unreachable by waiting (2^48 values) and is the
 *  posture's one genuinely dangerous failure. */
const scripted = vi.hoisted(() => ({
  objects: [] as string[],
  events: [] as string[],
  runs: [] as string[],
  derivedEvents: [] as string[],
  clockRuns: [] as string[],
}));

vi.mock("./ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ids.js")>();
  return {
    ...actual,
    newObjectId: (kind: never, attempt = 0, random?: never) =>
      scripted.objects.shift() ?? actual.newObjectId(kind, attempt, random),
    organicEventId: (attempt = 0, random?: never) => scripted.events.shift() ?? actual.organicEventId(attempt, random),
    newRunId: (attempt = 0, random?: never) => scripted.runs.shift() ?? actual.newRunId(attempt, random),
    derivedEventId: (seed: unknown) => scripted.derivedEvents.shift() ?? actual.derivedEventId(seed),
    clockRunId: (loopId: string, scheduledFor: string) =>
      scripted.clockRuns.shift() ?? actual.clockRunId(loopId, scheduledFor),
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
  scripted.derivedEvents.length = 0;
  scripted.clockRuns.length = 0;
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

// -------------------------------------------------- the derived identity guards

/**
 * A DERIVED-ID TRUNCATION COLLISION — two DISTINCT seeds landing on one id.
 *
 * This is the failure width alone cannot remove: `derivedSuffix` truncates a
 * sha256, truncation is not injective, and a derived id may never be re-minted
 * (that purity IS replay idempotency). What CAN be removed is the silence.
 * Every case below stages the collision the way the code would actually meet it
 * — equal explicit ids for objects, a scripted `derivedEventId`/`clockRunId` for
 * events and runs — and asserts the same three things: the call is REFUSED, the
 * stranger's row is untouched, and the caller is never handed an identity it did
 * not ask for.
 *
 * THE ONE RESIDUE, deliberate and pinned below: two seeds colliding on one
 * team's object cannot be told apart without the seed persisted alongside the
 * row, which is a schema change held as a separate decision.
 */
describe("a derived-id truncation collision between two DIFFERENT seeds", () => {
  it("refuses a CROSS-TEAM conflict instead of handing over the other team's object", async () => {
    const collided = "doc-bbbbbbbbbbbb";
    const alpha = await kernel.createObject({
      id: collided, teamId: TEAM, kind: "doc", actor: AGENT, now: T0,
      title: "Alpha's report", body: "alpha-confidential",
    });
    expect(alpha.ok && alpha.created).toBe(true);

    const beta = await kernel.createObject({
      id: collided, teamId: "team-beta", kind: "doc", actor: AGENT, now: T1,
      title: "Beta's report", body: "beta content",
    });

    expect(beta.ok).toBe(false);
    expect(!beta.ok && beta.code).toBe("ID_COLLISION");
    // The refusal names the id, never the stranger's contents.
    expect(!beta.ok && beta.message).toContain(collided);
    expect(!beta.ok && beta.message).not.toContain("alpha-confidential");
    expect(!beta.ok && beta.hint).toMatch(/escalate rather than retry/);
    // Nothing moved: one row, still alpha's.
    const rows = await db.db.select().from(schema.objects);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teamId).toBe(TEAM);
    expect(rows[0]!.body).toBe("alpha-confidential");
  });

  it("refuses a SAME-TEAM transition event collision instead of dropping the transition as a replay", async () => {
    const a = await loop({ key: "a", title: "Loop A" });
    const b = await loop({ key: "b", title: "Loop B" });
    // One id for two different objects' auto-pause seeds — the collision.
    scripted.derivedEvents.push("ev-cccccccccccc", "ev-cccccccccccc");

    const pauseA = await kernel.applyTransition({
      objectId: a.id, transition: "auto-pause", actor: AGENT, now: T0, derivedFrom: { runId: "run-000001", streak: 10 },
    });
    const pauseB = await kernel.applyTransition({
      objectId: b.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: { runId: "run-000002", streak: 10 },
    });

    expect(pauseA.ok && pauseA.replay).toBe(false);
    expect((await kernelStore.getObject(undefined, a.id))!.status).toBe("paused");
    // B's pause is REFUSED, not silently swallowed as A's replay.
    expect(pauseB.ok).toBe(false);
    expect(!pauseB.ok && pauseB.code).toBe("ID_COLLISION");
    expect(!pauseB.ok && pauseB.message).toContain(a.id);
    expect(!pauseB.ok && pauseB.hint).toMatch(/did NOT happen/);
    // Loop B is still active — which is exactly what the refusal is telling the
    // caller, instead of reporting a pause that never happened.
    expect((await kernelStore.getObject(undefined, b.id))!.status).toBe("active");
    // A's timeline keeps its one event; B's never gained a foreign one.
    expect(await kernelStore.countEventsById(undefined, "ev-cccccccccccc")).toBe(1);
    expect((await kernelStore.listObjectEvents(undefined, b.id)).map((e) => e.kind)).toEqual(["object-created"]);
  });

  it("refuses at the POST-APPEND backstop too — the branch the latch cannot reach", async () => {
    // The latch above catches the ordinary case. Its backstop exists for the
    // race where the colliding row commits between the latch's read and the
    // append, which no amount of sequential calling can produce — so the read is
    // blinded here instead: the executor hands the latch an empty result and the
    // insert still meets the committed row. That is exactly the race's shape,
    // and the swallow branch has to make the same decision the latch would have.
    const a = await loop({ key: "a", title: "Loop A" });
    const b = await loop({ key: "b", title: "Loop B" });
    const shared = "ev-dddddddddddd";
    scripted.derivedEvents.push(shared, shared);

    const first = await kernel.applyTransition({
      objectId: a.id, transition: "auto-pause", actor: AGENT, now: T0, derivedFrom: { runId: "run-1", streak: 10 },
    });
    expect(first.ok).toBe(true);

    // select #1 is the row lock, #2 is the latch's event read — blind that one.
    const raw = db.db;
    let selects = 0;
    const blinded = {
      select: (...args: unknown[]) => {
        selects += 1;
        if (selects === 2) return { from: () => ({ where: async () => [] }) };
        return (raw.select as (...a: unknown[]) => unknown)(...args);
      },
      insert: (...args: unknown[]) => (raw.insert as (...a: unknown[]) => unknown)(...args),
      update: (...args: unknown[]) => (raw.update as (...a: unknown[]) => unknown)(...args),
      delete: (...args: unknown[]) => (raw.delete as (...a: unknown[]) => unknown)(...args),
      execute: (...args: unknown[]) => (raw.execute as (...a: unknown[]) => unknown)(...args),
    };

    const second = await kernel.applyTransitionIn(blinded as never, {
      objectId: b.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: { runId: "run-2", streak: 10 },
    });

    expect(second.ok).toBe(false);
    expect(!second.ok && second.code).toBe("ID_COLLISION");
    expect(!second.ok && second.message).toContain(a.id);
    expect((await kernelStore.getObject(undefined, b.id))!.status).toBe("active");
    // Proof the blinding worked and this is the BACKSTOP, not the latch: the
    // append ran, and its post-swallow re-read is a third select.
    expect(selects).toBeGreaterThanOrEqual(3);
  });

  it("refuses the KIND-mismatched explicit id without inventing a key that was never supplied", async () => {
    // F5: this path carries no `key`, so the old message rendered `key
    // "undefined"` — teaching a fiction about a field the caller never sent.
    const id = "doc-eeeeeeeeeeee";
    await kernel.createObject({ id, teamId: TEAM, kind: "doc", actor: AGENT, now: T0, title: "a report" });

    const clash = await kernel.createObject({ id, teamId: TEAM, kind: "task", actor: AGENT, now: T1, title: "a task" });

    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.code).toBe("KEY_KIND_MISMATCH");
    expect(!clash.ok && clash.message).not.toContain("undefined");
    expect(!clash.ok && clash.message).toBe(`id ${id} already names a doc in this team`);
    expect(!clash.ok && clash.issues[0]).toMatchObject({ path: "id", got: id });
    // A real key still reads as a key.
    await kernel.createObject({ teamId: TEAM, kind: "doc", actor: AGENT, now: T0, key: "weekly", title: "d" });
    const keyed = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T1, key: "weekly", title: "t" });
    expect(!keyed.ok && keyed.message).toBe('key "weekly" already names a doc in this team');
  });

  /**
   * THE KNOWN RESIDUE, pinned so it can never be mistaken for coverage: two
   * seeds colliding inside ONE team on ONE kind still resolve as a replay,
   * because nothing stored beside the row distinguishes them. Closing it needs
   * the seed (or its full 64-hex hash) persisted in a column — a schema change
   * held as its own decision. If that ever lands, THIS test is the one to
   * rewrite: it should then refuse like the cases above.
   */
  it("still cannot distinguish two seeds inside one team — the residue held for the schema decision", async () => {
    const collided = "doc-aaaaaaaaaaaa";
    await kernel.createObject({ id: collided, teamId: TEAM, kind: "doc", actor: AGENT, now: T0, title: "Run A report", body: "a" });
    const second = await kernel.createObject({
      id: collided, teamId: TEAM, kind: "doc", actor: AGENT, now: T1, title: "Run B report", body: "b",
    });

    expect(second.ok && second.created).toBe(false);
    expect(second.ok && second.object.title).toBe("Run A report");
    // It is at least REPORTED as differing content rather than silently equal.
    expect(second.ok && second.contentDiffers).toBe(true);
  });
});

describe("a derived RUN id collision", () => {
  it("reports a foreign-loop id hit as taken, never as this loop's replay", async () => {
    const a = await loop({ key: "a", title: "Loop A" });
    const b = await loop({ key: "b", title: "Loop B" });
    const shared = "run-ffffffffffff";
    const base = {
      userId: TEAM, machineId: "", phase: "pending", role: "exec", ts: T0,
      queueState: "queued", scope: "routine", reason: "clock", entrance: "clock", scheduledFor: T1,
    } as const;

    const first = await kernelStore.queueRun(undefined, { ...base, id: shared, loopId: a.id });
    expect(first.outcome).toBe("queued");

    const second = await kernelStore.queueRun(undefined, { ...base, id: shared, loopId: b.id });
    expect(second.outcome).toBe("id-taken");
    // Same id, same loop, is still the ordinary replay the queue is built on.
    const replay = await kernelStore.queueRun(undefined, { ...base, id: shared, loopId: a.id });
    expect(replay.outcome).toBe("replay");
    expect(replay.run!.loopId).toBe(a.id);
  });

  it("fails a clock fire loudly rather than skipping the loop's run as a replay", async () => {
    const a = await loop({ key: "a", title: "Loop A" });
    const b = await loop({ key: "b", title: "Loop B" });
    const shared = "run-eeeeeeeeeeee";
    scripted.clockRuns.push(shared, shared);

    const first = await db.db.transaction(async (tx) =>
      runQueue.queueKernelRun(tx as never, { loop: a, now: T0, reason: "clock", scheduledFor: T1 }),
    );
    expect(first.outcome).toBe("queued");

    await expect(
      db.db.transaction(async (tx) =>
        runQueue.queueKernelRun(tx as never, { loop: b, now: T0, reason: "clock", scheduledFor: T1 }),
      ),
    ).rejects.toThrow(/already belongs to/);
    // Loop B queued nothing; loop A's run is untouched.
    const rows = await db.db.select().from(runsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.loopId).toBe(a.id);
  });

  it("keeps the fire DUE when the tick refuses it, and never starves the other loops", async () => {
    // The tick must isolate one loop's identity fault: the healthy loop queues
    // and advances, the collided one is counted, logged, and left due — a lost
    // fire would be the silent half all over again.
    const early = await loop({ key: "a", title: "Loop A", nextFire: "2026-08-03T07:00:00.000Z" });
    const late = await loop({ key: "b", title: "Loop B", nextFire: "2026-08-03T07:30:00.000Z" });
    const shared = "run-dddddddddddd";
    scripted.clockRuns.push(shared, shared);

    const result = await runQueue.tickRunClock(new Date("2026-08-03T08:00:00.000Z"));

    expect(result).toMatchObject({ scanned: 2, queued: 1, failed: 1 });
    expect((await db.db.select().from(runsTable))).toHaveLength(1);
    // The healthy loop advanced its cursor; the refused one did not.
    expect((await kernelStore.getObject(undefined, early.id))!.nextFire).not.toBe("2026-08-03T07:00:00.000Z");
    expect((await kernelStore.getObject(undefined, late.id))!.nextFire).toBe("2026-08-03T07:30:00.000Z");
  });
});
