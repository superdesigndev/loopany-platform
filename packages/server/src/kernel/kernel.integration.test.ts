/**
 * The kernel's invariants, proven against a REAL pglite database — the same
 * migrations, the same CHECKs, the same partial indexes production gets.
 *
 * Every assertion here corresponds to a named contract line:
 *   - event dedup: same derivation → ONE row          (design §2 invariant 1)
 *   - attested close                                   (design §3, spec §3.4)
 *   - key idempotency, and its kind mismatch           (spec §4.1)
 *   - the kind firewalls, at BOTH altitudes            (design §4 rule 2)
 *   - one queued run per loop                          (design §5)
 *   - a mutation and its event are ONE transaction     (spec §4)
 *
 * The firewalls are asserted twice on purpose: once through the kernel (the
 * teaching refusal an agent sees) and once by writing raw SQL past it (the DDL
 * CHECK, the floor that holds even if a verb guard were removed). A firewall
 * proven only at the verb is a firewall that quietly evaporates on the next
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let kernelStore: typeof import("../db/kernelStore.js");
let kernel: typeof import("./applyTransition.js");
let ids: typeof import("./ids.js");
let schema: typeof import("../db/kernel-schema.js");
let runsTable: typeof import("../db/schema.js").runs;

const TEAM = "team-alpha";
const AGENT = { entrance: "agent", actorId: "run-1" } as const;
const HUMAN = { entrance: "human", actorId: "u_alice" } as const;
const T0 = "2026-08-03T07:00:00.000Z";
const T1 = "2026-08-03T08:00:00.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-kernel-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";

  db = await import("../db/index.js");
  await db.runMigrations();
  kernelStore = await import("../db/kernelStore.js");
  kernel = await import("./applyTransition.js");
  ids = await import("./ids.js");
  schema = await import("../db/kernel-schema.js");
  runsTable = (await import("../db/schema.js")).runs;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Assert a DDL CHECK fired, BY NAME. Drizzle wraps a driver error in a generic
 * "Failed query: …", so matching the message would silently pass on any failure
 * — including a typo in the fixture. The constraint name lives on the cause
 * (`code` 23514), which is the only thing worth asserting.
 */
async function expectCheckViolation(run: () => Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  const cause = (caught as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  expect(caught, `expected ${constraint} to fire`).toBeDefined();
  expect(cause?.code, "expected a CHECK violation (SQLSTATE 23514)").toBe("23514");
  expect(cause?.constraint).toBe(constraint);
}

beforeEach(async () => {
  await db.db.delete(schema.events);
  await db.db.delete(schema.objects);
  await db.db.delete(runsTable);
});

/** A plain open task. */
async function task(over: Record<string, unknown> = {}) {
  const r = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, title: "t", ...over });
  if (!r.ok) throw new Error(`fixture create failed: ${r.code} ${r.message}`);
  return r.object;
}

/** An active loop with a cadence. */
async function loop(over: Record<string, unknown> = {}) {
  const r = await kernel.createObject({
    teamId: TEAM,
    kind: "loop",
    actor: HUMAN,
    now: T0,
    title: "Housekeeper",
    cron: "0 7 * * *",
    nextFire: T1,
    body: "the charter",
    ...over,
  });
  if (!r.ok) throw new Error(`fixture create failed: ${r.code} ${r.message}`);
  return r.object;
}

// ---------------------------------------------------------------- create

describe("createObject", () => {
  it("writes the object and its object-created event in one call", async () => {
    const t = await task({ title: "Observe the impact of PR #201" });
    expect(t.id).toMatch(/^task-/);
    expect(t.status).toBe("open");
    const events = await kernelStore.listObjectEvents(undefined, t.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("object-created");
    expect(events[0]!.origin).toBe("derived");
    expect(events[0]!.entrance).toBe("agent");
    expect(events[0]!.actorId).toBe("run-1");
  });

  it("kind-prefixes every id", async () => {
    expect((await task()).id).toMatch(/^task-/);
    expect((await loop()).id).toMatch(/^loop-/);
    const d = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: AGENT, now: T0, format: "markdown" });
    expect(d.ok && d.object.id).toMatch(/^doc-/);
  });

  it("records a born-gated question in the SAME creation event, not a second transition", async () => {
    const t = await task({ pendingQuestion: "post this reply? (a) yes (b) no" });
    const events = await kernelStore.listObjectEvents(undefined, t.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.diff).toEqual({ pendingQuestion: { old: null, new: "post this reply? (a) yes (b) no" } });
  });

  it("derives the creation event from the object id, so a racing double-create writes one row", async () => {
    const id = ids.derivedObjectId("doc", { runId: "run-42", seed: "report" });
    const first = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: AGENT, now: T0, id, body: "a" });
    const second = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: AGENT, now: T1, id, body: "a" });
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect(await kernelStore.countEventsById(undefined, ids.createdEventId(id))).toBe(1);
  });
});

describe("key idempotency (spec §4.1)", () => {
  it("returns the EXISTING object on a repeated key — 200, never a conflict", async () => {
    const a = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, key: "pr-201", title: "x" });
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T1, key: "pr-201", title: "x" });
    expect(a.ok && a.created).toBe(true);
    expect(b.ok && b.created).toBe(false);
    expect(b.ok && b.object.id).toBe(a.ok ? a.object.id : "");
    expect(b.ok && b.contentDiffers).toBe(false);
  });

  it("writes exactly ONE row and ONE event for a replayed key", async () => {
    await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, key: "k", title: "x" });
    await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T1, key: "k", title: "x" });
    expect(await db.db.select().from(schema.objects)).toHaveLength(1);
    expect(await db.db.select().from(schema.events)).toHaveLength(1);
  });

  it("REPORTS a content difference and applies nothing — replay is free, silent discard forbidden", async () => {
    const a = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, key: "k", title: "first" });
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T1, key: "k", title: "second" });
    expect(b.ok && b.contentDiffers).toBe(true);
    expect(b.ok && b.object.title).toBe("first");
    expect(a.ok && (await kernelStore.getObject(undefined, a.object.id))!.title).toBe("first");
  });

  it("scopes the key PER TEAM — the same key in another team is a different object", async () => {
    const a = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, key: "k", title: "x" });
    const b = await kernel.createObject({ teamId: "team-beta", kind: "task", actor: AGENT, now: T0, key: "k", title: "y" });
    expect(b.ok && b.created).toBe(true);
    expect(a.ok && b.ok && a.object.id).not.toBe(b.ok ? b.object.id : "");
  });

  it("refuses only a KIND mismatch — returning a doc from a task create would be worse", async () => {
    await kernel.createObject({ teamId: TEAM, kind: "doc", actor: AGENT, now: T0, key: "k" });
    const clash = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T1, key: "k" });
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.code).toBe("KEY_KIND_MISMATCH");
    expect(!clash.ok && clash.hint).toContain("doc-");
  });

  it("leaves an object with NO key free to duplicate (caller's risk, by design)", async () => {
    await task({ title: "same" });
    await task({ title: "same" });
    expect(await db.db.select().from(schema.objects)).toHaveLength(2);
  });
});

// ---------------------------------------------------------- kind firewalls

describe("kind firewalls (design §4 rule 2)", () => {
  it("refuses a cadence on a task at the VERB, with teaching", async () => {
    const r = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, cron: "0 7 * * *" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("WRONG_KIND");
    expect(!r.ok && r.issues[0]!.path).toBe("cron");
    expect(!r.ok && r.hint).toContain("follow_up");
  });

  it("refuses a cadence on a task at the DDL FLOOR, past the verb entirely", async () => {
    await expectCheckViolation(
      () =>
        db.db.insert(schema.objects).values({
          id: "task-raw",
          teamId: TEAM,
          kind: "task",
          status: "open",
          cron: "0 7 * * *",
          createdAt: T0,
          updatedAt: T0,
        }),
      "objects_cron_loop_only",
    );
  });

  it("refuses task facets on a loop, at both altitudes", async () => {
    const l = await loop();
    const viaVerb = await kernel.applyUpdate({ objectId: l.id, actor: AGENT, now: T1, fields: { watcher: "loop-x" } });
    expect(!viaVerb.ok && viaVerb.code).toBe("WRONG_KIND");
    await expectCheckViolation(
      () =>
        db.db.insert(schema.objects).values({
          id: "loop-raw",
          teamId: TEAM,
          kind: "loop",
          status: "active",
          pendingQuestion: "?",
          createdAt: T0,
          updatedAt: T0,
        }),
      "objects_task_facets_only",
    );
  });

  it("refuses format on a non-doc at the DDL floor", async () => {
    await expectCheckViolation(
      () =>
        db.db.insert(schema.objects).values({
          id: "task-fmt",
          teamId: TEAM,
          kind: "task",
          status: "open",
          format: "html",
          createdAt: T0,
          updatedAt: T0,
        }),
      "objects_format_doc_only",
    );
  });

  it("refuses `close` on a loop by name, and names the legal move", async () => {
    const l = await loop();
    const r = await kernel.applyTransition({ objectId: l.id, transition: "close", actor: HUMAN, now: T1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("WRONG_KIND");
    expect(!r.ok && r.hint).toBe("loops do not close — pause or retire instead");
    expect((await kernelStore.getObject(undefined, l.id))!.status).toBe("active");
  });

  it("refuses a loop transition on a task", async () => {
    const t = await task();
    const r = await kernel.applyTransition({ objectId: t.id, transition: "pause", actor: HUMAN, now: T1 });
    expect(!r.ok && r.code).toBe("WRONG_KIND");
  });

  it("CLEARING a foreign facet is a no-op, not a firewall breach", async () => {
    const t = await task();
    const r = await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { cron: null } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.changed).toBe(false);
  });
});

// ------------------------------------------------------------ attested close

describe("attested close (design §3)", () => {
  it("REFUSES while a question is waiting, with the answer path in the hint", async () => {
    const t = await task({ pendingQuestion: "error rate doubled — (a) revert (b) one more day" });
    const r = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: AGENT, now: T1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("OPEN_QUESTION");
    expect(!r.ok && r.issues[0]!.path).toBe("pendingQuestion");
    expect(!r.ok && r.hint).toContain(`/api/tasks/${t.id}/verdict`);
  });

  it("writes NOTHING on a refused close — not the status, not an event", async () => {
    const t = await task({ pendingQuestion: "?" });
    await kernel.applyTransition({ objectId: t.id, transition: "close", actor: AGENT, now: T1 });
    expect((await kernelStore.getObject(undefined, t.id))!.status).toBe("open");
    expect(await kernelStore.listObjectEvents(undefined, t.id)).toHaveLength(1); // only the create
  });

  it("treats a whitespace-only question as no question", async () => {
    const t = await task({ pendingQuestion: "   " });
    const r = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: AGENT, now: T1 });
    expect(r.ok).toBe(true);
  });

  it("closes once the question is cleared", async () => {
    const t = await task({ pendingQuestion: "?" });
    await kernel.applyUpdate({ objectId: t.id, actor: HUMAN, now: T1, fields: { pendingQuestion: null }, eventKind: "question-answered", note: "(b)" });
    const r = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: AGENT, now: T1, note: "recovered" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.object.status).toBe("closed");
    expect(r.ok && r.object.closedAt).toBe(T1);
  });

  it("allows an EARLY close — follow_up_at is a resurface schedule, not an obligation", async () => {
    const t = await task({ followUpAt: "2099-01-01T00:00:00.000Z" });
    const r = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: AGENT, now: T1 });
    expect(r.ok).toBe(true);
  });
});

// ------------------------------------------------------------- transitions

describe("applyTransition", () => {
  it("records the transition NAME and a status diff on the event", async () => {
    const t = await task();
    const r = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: HUMAN, now: T1, note: "done" });
    expect(r.ok).toBe(true);
    const ev = (r as { event: { transition: string; diff: unknown; note: string | null } }).event;
    expect(ev.transition).toBe("close");
    expect(ev.diff).toMatchObject({ status: { old: "open", new: "closed" } });
    expect(ev.note).toBe("done");
  });

  it("refuses an illegal source state rather than applying over the top", async () => {
    const t = await task();
    await kernel.applyTransition({ objectId: t.id, transition: "close", actor: HUMAN, now: T1 });
    const again = await kernel.applyTransition({ objectId: t.id, transition: "close", actor: HUMAN, now: T1 });
    expect(!again.ok && again.code).toBe("ILLEGAL_FROM_STATE");
  });

  it("DISARMS a loop it pauses — the cursor is what makes a cadence live", async () => {
    const l = await loop();
    expect(l.nextFire).toBe(T1);
    const r = await kernel.applyTransition({ objectId: l.id, transition: "pause", actor: HUMAN, now: T1 });
    expect(r.ok && r.object.status).toBe("paused");
    expect(r.ok && r.object.nextFire).toBeNull();
    expect(r.ok && r.event.diff).toMatchObject({ nextFire: { old: T1, new: null } });
  });

  it("keeps auto-pause distinguishable from a deliberate pause on the timeline", async () => {
    const l = await loop();
    const r = await kernel.applyTransition({
      objectId: l.id,
      transition: "auto-pause",
      actor: { entrance: "agent", actorId: "run-9" },
      now: T1,
      derivedFrom: { runId: "run-9" },
    });
    expect(r.ok && r.event.transition).toBe("auto-pause");
    expect(r.ok && r.event.kind).toBe("loop-paused");
  });

  it("resumes and retires a loop", async () => {
    const l = await loop();
    await kernel.applyTransition({ objectId: l.id, transition: "pause", actor: HUMAN, now: T1 });
    const back = await kernel.applyTransition({ objectId: l.id, transition: "resume", actor: HUMAN, now: T1 });
    expect(back.ok && back.object.status).toBe("active");
    const gone = await kernel.applyTransition({ objectId: l.id, transition: "retire", actor: HUMAN, now: T1 });
    expect(gone.ok && gone.object.status).toBe("retired");
  });

  it("refuses an unknown transition name arriving from the wire", async () => {
    const t = await task();
    const r = await kernel.applyTransition({
      objectId: t.id,
      transition: "reopen" as never,
      actor: HUMAN,
      now: T1,
    });
    expect(!r.ok && r.code).toBe("UNKNOWN_TRANSITION");
  });

  it("refuses an unknown object", async () => {
    const r = await kernel.applyTransition({ objectId: "task-nope", transition: "close", actor: HUMAN, now: T1 });
    expect(!r.ok && r.code).toBe("NOT_FOUND");
  });
});

// ------------------------------------------------------------- event dedup

describe("event dedup — same derivation, one row (design §2 invariant 1)", () => {
  it("makes a re-derived transition a REPLAY that applies nothing twice", async () => {
    const l = await loop();
    const seed = { runId: "run-9", streak: 10 };
    const first = await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: seed });
    const second = await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: seed });
    expect(first.ok && first.replay).toBe(false);
    expect(second.ok && second.replay).toBe(true);
    expect(first.ok && second.ok && first.event.id).toBe(second.ok ? second.event.id : "");
    // ONE loop-paused row, despite the second call.
    const paused = (await kernelStore.listObjectEvents(undefined, l.id)).filter((e) => e.kind === "loop-paused");
    expect(paused).toHaveLength(1);
  });

  it("does NOT let the replay latch mask a genuinely different fact", async () => {
    const l = await loop();
    await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: { runId: "run-9" } });
    await kernel.applyTransition({ objectId: l.id, transition: "resume", actor: HUMAN, now: T1 });
    const other = await kernel.applyTransition({ objectId: l.id, transition: "auto-pause", actor: AGENT, now: T1, derivedFrom: { runId: "run-10" } });
    expect(other.ok && other.replay).toBe(false);
  });

  it("never deduplicates an ORGANIC fact — two identical patches are two facts", async () => {
    const t = await task({ title: "a" });
    await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { title: "b" } });
    await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { title: "a" } });
    await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { title: "b" } });
    const updates = (await kernelStore.listObjectEvents(undefined, t.id)).filter((e) => e.kind === "object-updated");
    expect(updates).toHaveLength(3);
  });

  it("is a plain ON CONFLICT DO NOTHING at the store, reported as inserted:false", async () => {
    const id = ids.derivedEventId({ probe: 1 });
    const row = {
      id,
      teamId: TEAM,
      kind: "probe",
      origin: "derived" as const,
      entrance: "clock" as const,
      actorId: "sched",
      ts: T0,
    };
    expect((await kernelStore.appendEvent(undefined, row)).inserted).toBe(true);
    expect((await kernelStore.appendEvent(undefined, { ...row, ts: T1 })).inserted).toBe(false);
    expect(await kernelStore.countEventsById(undefined, id)).toBe(1);
  });

  /**
   * SPEC CORRECTION, pinned here so it cannot regress into a wrong assumption.
   * §5.4 claims a swallowed insert consumes no `seq` and therefore leaves no
   * gap. Postgres draws the identity value BEFORE detecting the conflict, so it
   * DOES burn one. What the stream actually needs — and all it needs — is that
   * `seq` is strictly increasing and that a dedup returns the ORIGINAL row's
   * seq, so `WHERE seq > :since ORDER BY seq` resumes losslessly. A consumer
   * must never read a gap as a dropped event or derive a count from a delta.
   */
  it("keeps seq strictly increasing (gaps allowed) and returns the ORIGINAL seq on dedup", async () => {
    const a = await kernelStore.appendEvent(undefined, {
      id: ids.derivedEventId({ p: "a" }), teamId: TEAM, kind: "p", origin: "derived", entrance: "clock", actorId: "s", ts: T0,
    });
    const dup = await kernelStore.appendEvent(undefined, {
      id: ids.derivedEventId({ p: "a" }), teamId: TEAM, kind: "p", origin: "derived", entrance: "clock", actorId: "s", ts: T1,
    });
    const b = await kernelStore.appendEvent(undefined, {
      id: ids.derivedEventId({ p: "b" }), teamId: TEAM, kind: "p", origin: "derived", entrance: "clock", actorId: "s", ts: T0,
    });
    expect(dup.inserted).toBe(false);
    expect(dup.event.seq).toBe(a.event.seq);
    expect(b.event.seq).toBeGreaterThan(a.event.seq);
    // The tail predicate is what actually has to hold: nothing after `a` is lost.
    const tail = (await db.db.select().from(schema.events)).filter((e) => e.seq > a.event.seq);
    expect(tail.map((e) => e.id)).toContain(b.event.id);
  });
});

// ------------------------------------------------- payload sufficiency (DDL)

describe("payload sufficiency (spec §5.2)", () => {
  it("makes a status diff without its transition name NON-INSERTABLE", async () => {
    await expectCheckViolation(
      () =>
        db.db.insert(schema.events).values({
          id: "ev-smuggle",
          teamId: TEAM,
          kind: "object-updated",
          origin: "organic",
          entrance: "agent",
          actorId: "run-1",
          diff: { status: { old: "open", new: "closed" } },
          ts: T0,
        }),
      "events_state_change_sufficient",
    );
  });

  it("still admits an ordinary field diff with no transition", async () => {
    const ok = await kernelStore.appendEvent(undefined, {
      id: "ev-plain",
      teamId: TEAM,
      kind: "object-updated",
      origin: "organic",
      entrance: "agent",
      actorId: "run-1",
      diff: { title: { old: "a", new: "b" } },
      ts: T0,
    });
    expect(ok.inserted).toBe(true);
  });
});

describe("the closed-pair CHECK", () => {
  it("refuses a closed task with no stamp", async () => {
    await expectCheckViolation(
      () =>
        db.db.insert(schema.objects).values({
          id: "task-unstamped", teamId: TEAM, kind: "task", status: "closed", createdAt: T0, updatedAt: T0,
        }),
      "objects_closed_pair",
    );
  });

  it("refuses an open task that carries one", async () => {
    await expectCheckViolation(
      () =>
        db.db.insert(schema.objects).values({
          id: "task-ghost", teamId: TEAM, kind: "task", status: "open", closedAt: T0, createdAt: T0, updatedAt: T0,
        }),
      "objects_closed_pair",
    );
  });
});

// -------------------------------------------------------------- update

describe("applyUpdate", () => {
  it("kernel itself refuses an agent clearing or replacing a live question", async () => {
    const t = await task({ pendingQuestion: "Post this reply?" });
    for (const pendingQuestion of [null, "Ask a different question?"]) {
      const r = await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { pendingQuestion } });
      expect(!r.ok && r.code).toBe("NOT_HUMAN");
    }
    expect((await kernelStore.getObject(undefined, t.id))!.pendingQuestion).toBe("Post this reply?");
  });

  it("writes the diff over exactly the fields it changed", async () => {
    const t = await task({ title: "a", followUpAt: null });
    const r = await kernel.applyUpdate({
      objectId: t.id, actor: AGENT, now: T1,
      fields: { watcher: "loop-steward", followUpAt: "2026-08-06T00:00:00.000Z" },
    });
    expect(r.ok && r.changed).toBe(true);
    expect(r.ok && r.event!.diff).toEqual({
      watcher: { old: null, new: "loop-steward" },
      followUpAt: { old: null, new: "2026-08-06T00:00:00.000Z" },
    });
  });

  it("writes NO event for a no-op — a no-op is not a fact", async () => {
    const t = await task({ title: "a" });
    const r = await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { title: "a" } });
    expect(r.ok && r.changed).toBe(false);
    expect(r.ok && r.event).toBeNull();
    expect(await kernelStore.listObjectEvents(undefined, t.id)).toHaveLength(1);
  });

  it("REFUSES a status smuggled in as a content field", async () => {
    const t = await task();
    const r = await kernel.applyUpdate({
      objectId: t.id, actor: AGENT, now: T1,
      fields: { status: "closed" } as never,
    });
    expect(!r.ok && r.code).toBe("IMMUTABLE_KEY");
    expect(!r.ok && r.hint).toContain("transition");
    expect((await kernelStore.getObject(undefined, t.id))!.status).toBe("open");
  });

  it("refuses to mutate a closed task", async () => {
    const t = await task();
    await kernel.applyTransition({ objectId: t.id, transition: "close", actor: HUMAN, now: T1 });
    const r = await kernel.applyUpdate({ objectId: t.id, actor: AGENT, now: T1, fields: { title: "z" } });
    expect(!r.ok && r.code).toBe("CLOSED");
  });

  it("carries a custom event kind for the caller's own vocabulary", async () => {
    const l = await loop();
    const r = await kernel.applyUpdate({
      objectId: l.id, actor: AGENT, now: T1, fields: { body: "new charter" }, eventKind: "charter-evolved",
    });
    expect(r.ok && r.event!.kind).toBe("charter-evolved");
    expect(r.ok && r.event!.diff).toEqual({ body: { old: "the charter", new: "new charter" } });
  });
});

// --------------------------------------------------------- runs queue

describe("one queued run per loop (design §5 queue discipline)", () => {
  const baseRun = { userId: "u_alice", machineId: "m_1", phase: "pending" as const, role: "exec" as const };

  it("admits the first queued run", async () => {
    const r = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-a", loopId: "loop-1", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect(r.outcome).toBe("queued");
  });

  it("REFUSES a second — a machine offline for two days owes one run, not forty-eight", async () => {
    await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-a", loopId: "loop-1", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    const second = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-b", loopId: "loop-1", ts: T1, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect(second.outcome).toBe("loop-busy");
    expect(second.run!.id).toBe("run-a");
    expect(await kernelStore.getRunRow(undefined, "run-b")).toBeUndefined();
  });

  it("distinguishes a REPLAY (same derived id) from the queue skip", async () => {
    const id = ids.clockRunId("loop-1", T0);
    await kernelStore.queueRun(undefined, {
      ...baseRun, id, loopId: "loop-1", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    const replay = await kernelStore.queueRun(undefined, {
      ...baseRun, id, loopId: "loop-1", ts: T1, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect(replay.outcome).toBe("replay");
  });

  it("frees the slot once the run leaves `queued`", async () => {
    await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-a", loopId: "loop-1", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    await db.db.update(runsTable).set({ queueState: "claimed" }).where((await import("drizzle-orm")).eq(runsTable.id, "run-a"));
    const next = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-b", loopId: "loop-1", ts: T1, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect(next.outcome).toBe("queued");
  });

  it("bounds nothing ACROSS loops — two loops each get their own queued run", async () => {
    const a = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-a", loopId: "loop-1", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    const b = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-b", loopId: "loop-2", ts: T0, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect([a.outcome, b.outcome]).toEqual(["queued", "queued"]);
  });

  it("is invisible to LEGACY run rows (queue_state NULL), so the shipping table is untouched", async () => {
    await db.db.insert(runsTable).values([
      { ...baseRun, id: "run-legacy-1", loopId: "loop-9", ts: T0 },
      { ...baseRun, id: "run-legacy-2", loopId: "loop-9", ts: T1 },
    ]);
    const fresh = await kernelStore.queueRun(undefined, {
      ...baseRun, id: "run-new", loopId: "loop-9", ts: T1, queueState: "queued", scope: "routine", reason: "clock", entrance: "clock",
    });
    expect(fresh.outcome).toBe("queued");
    expect((await kernelStore.queuedRunForLoop(undefined, "loop-9"))!.id).toBe("run-new");
  });
});

// ------------------------------------------------ atomicity of mutation+event

describe("a mutation and its event are ONE transaction (spec §4)", () => {
  it("rolls both back when the transaction body throws after the write", async () => {
    const t = await task();
    const { db: handle } = db;
    await expect(
      handle.transaction(async (tx) => {
        const r = await kernel.applyTransitionIn(tx as never, {
          objectId: t.id, transition: "close", actor: HUMAN, now: T1,
        });
        expect(r.ok).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await kernelStore.getObject(undefined, t.id))!.status).toBe("open");
    expect(await kernelStore.listObjectEvents(undefined, t.id)).toHaveLength(1);
  });
});
