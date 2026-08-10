/**
 * The adversarial-review combo battery (milestone M1F). Each test pins a
 * finding the review demanded: trigger finalization keyed off final status,
 * CAS preconditions, tick working-state, runtime validation, cron dispatch
 * eligibility, refusal granularity, and the no-op guard.
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Decision,
  type Provenance,
  type Snapshot,
  type Trigger,
  type World,
  applyChangeset,
  onceTriggerId,
  decide,
  emptyWorld,
  tick,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u" };
const T0 = "2026-08-09T07:00:00.000Z";
const T1 = "2026-08-10T07:00:00.000Z";

function run(world: World, cmd: Command, now = T0): { world: World; d: Decision } {
  const d = decide(cmd, world.snapshot, HUMAN, now);
  return { world: d.ok ? foldToWorld(world, d.changeset) : world, d };
}

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.code} ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

function crons(s: Snapshot): Trigger[] {
  return s.triggers.filter((t) => t.kind === "cron");
}

// ---------------------------------------------------------------------------
// Finding #1 — trigger finalization keyed off FINAL status
// ---------------------------------------------------------------------------

describe("finding #1: trigger finalization is single-source, keyed off final status", () => {
  // The four combos of {status: terminal|non-terminal} × {cron: same|new} in ONE patch.
  const cases: Array<{ name: string; status: string; cron: string; enabled: boolean }> = [
    { name: "non-terminal + unchanged cron", status: "in-progress", cron: "0 7 * * *", enabled: true },
    { name: "non-terminal + new cron", status: "in-progress", cron: "0 9 * * *", enabled: true },
    { name: "terminal + unchanged cron", status: "done", cron: "0 7 * * *", enabled: false },
    { name: "terminal + new cron", status: "archived", cron: "0 9 * * *", enabled: false },
  ];
  for (const c of cases) {
    it(`${c.name} yields exactly one cron trigger with enabled=${c.enabled}`, () => {
      const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", status: "in-progress", assignee: "a" });
      // A note keeps the "unchanged" combos from being (correct) no-ops while
      // the finalization result is what we're pinning here.
      const { world, d } = run(w, { op: "update", id: "loop", patch: { status: c.status, cron: c.cron }, note: "combo" });
      expect(d.ok).toBe(true);
      const cronTriggers = crons(world.snapshot);
      expect(cronTriggers).toHaveLength(1); // never two rows for one id
      expect(cronTriggers[0]).toMatchObject({ spec: c.cron, enabled: c.enabled });
      if (!c.enabled) expect(cronTriggers[0].disabledBy).toBe("invariant");
    });
  }

  it("each trigger id appears at most once in a changeset", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", status: "in-progress", assignee: "a" });
    const d = decide({ op: "update", id: "loop", patch: { status: "done", cron: "0 9 * * *" } }, w.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error("unreachable");
    const ids = d.changeset.triggers.map((m) => (m.op === "delete" ? m.id : m.trigger.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("create with a TERMINAL status + cron yields a DISABLED trigger (invariant #2 is level-triggered, not edge-triggered)", () => {
    const { world, d } = run(emptyWorld(), { op: "create", title: "born-done", cron: "0 7 * * *", status: "done" });
    expect(d.ok).toBe(true);
    const cronTriggers = crons(world.snapshot);
    expect(cronTriggers).toHaveLength(1);
    expect(cronTriggers[0]).toMatchObject({ enabled: false, disabledBy: "invariant" });
  });

  it("updating cron on an ALREADY-terminal task keeps the trigger disabled (no zombie enable)", () => {
    const w = seed({ op: "create", title: "loop", status: "done" });
    // arm a cron on a task that is already terminal
    const { world, d } = run(w, { op: "update", id: "loop", patch: { cron: "0 7 * * *" } });
    expect(d.ok).toBe(true);
    const cronTriggers = crons(world.snapshot);
    expect(cronTriggers).toHaveLength(1);
    expect(cronTriggers[0]).toMatchObject({ enabled: false, disabledBy: "invariant" });
  });

  it("apply never resurrects a stale spec — the finalized put is the only cron write", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", status: "in-progress", assignee: "a" });
    const d = decide({ op: "update", id: "loop", patch: { status: "done", cron: "0 9 * * *" } }, w.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error("unreachable");
    const applied = applyChangeset(w.snapshot, d.changeset);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const cronTriggers = crons(applied.snapshot);
    expect(cronTriggers).toHaveLength(1);
    expect(cronTriggers[0].spec).toBe("0 9 * * *"); // the new spec, not the old
    expect(cronTriggers[0].enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding #2 — changeset preconditions (CAS)
// ---------------------------------------------------------------------------

describe("finding #2: applyChangeset validates preconditions and returns a typed conflict", () => {
  it("a stale object CAS (expectedVersion mismatch) is a typed conflict, not a silent fold", () => {
    const w = seed({ op: "create", title: "x" });
    const d = decide({ op: "update", id: "x", patch: { title: "y" } }, w.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error("unreachable");
    // Someone else bumped the object between decide and apply.
    const raced: Snapshot = {
      ...w.snapshot,
      objects: { ...w.snapshot.objects, x: { ...(w.snapshot.objects["x"] as never as { version: number }), version: 5 } as never },
    };
    const applied = applyChangeset(raced, d.changeset);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("object");
    expect(applied.conflict.id).toBe("x");
  });

  it("a create whose id got taken between decide and apply conflicts (must-not-exist)", () => {
    const d = decide({ op: "create", title: "x" }, emptyWorld().snapshot, HUMAN, T0);
    if (!d.ok) throw new Error("unreachable");
    const occupied: Snapshot = {
      objects: { x: { archetype: "task", id: "x", title: "x", status: "todo", assignee: null, priority: null, type: null, parent: null, tracks: null, refs: [], followUpAt: null, body: "", version: 1, createdAt: T0, updatedAt: T0 } },
      triggers: [],
      runs: [],
    };
    const applied = applyChangeset(occupied, d.changeset);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("object");
  });

  it("a run insert whose id already exists conflicts (dispatch dedup at the fold too)", () => {
    const w = seed({ op: "create", title: "x", assignee: "claude" });
    // The birth already dispatched one assignment run. Re-decide the same
    // manual run and apply it twice — the second insert must conflict.
    const dManual = decide({ op: "run", id: "x" }, w.snapshot, HUMAN, T1);
    // there's an active run so run() refuses; craft a raw insert to prove the fold guard
    void dManual;
    const existing = w.snapshot.runs[0];
    const cs = { objects: [], events: [], triggers: [], runs: [{ op: "insert" as const, run: existing }] };
    const applied = applyChangeset(w.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("run");
  });

  it("a run put with a wrong state precondition conflicts", () => {
    const w = seed({ op: "create", title: "x", assignee: "claude" });
    const existing = w.snapshot.runs[0];
    // Precondition demands 'claimed' but the run is 'pending'.
    const cs = {
      objects: [],
      events: [],
      triggers: [],
      runs: [{ op: "put" as const, run: { ...existing, state: "done" as const }, expectedState: ["claimed"] as const }],
    };
    const applied = applyChangeset(w.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// Finding #3 — tick working state (one active run max)
// ---------------------------------------------------------------------------

describe("finding #3: tick folds a working snapshot; a task's cron+once both due create ONE active run", () => {
  it("cron + once due in the same tick never produces two active runs", () => {
    // A follow-up task that is ALSO a loop: cron armed, and a once slot due.
    // (Constructed directly since the model keeps status=follow-up with a cron.)
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    // Hand-craft an overlapping once trigger due at the same window.
    const dueAt = "2026-08-10T06:00:00.000Z";
    const withOnce: Snapshot = {
      ...w.snapshot,
      objects: {
        ...w.snapshot.objects,
        loop: { ...(w.snapshot.objects["loop"] as never as object), status: "follow-up", followUpAt: dueAt } as never,
      },
      triggers: [
        ...w.snapshot.triggers.map((t) => (t.kind === "cron" ? { ...t, nextFireAt: dueAt } : t)),
        { id: onceTriggerId("loop"), taskId: "loop", kind: "once", spec: dueAt, timezone: null, enabled: true, disabledBy: null, nextFireAt: dueAt },
      ],
    };
    w = { snapshot: withOnce, events: [] };
    const r = tick(w.snapshot, T1);
    const folded = r.changesets.reduce(foldToWorld, w);
    const active = folded.snapshot.runs.filter((rr) => rr.state === "pending" || rr.state === "claimed" || rr.state === "running");
    expect(active).toHaveLength(1); // NOT two
  });

  it("tick is order-stable under any permutation of the trigger array", () => {
    // Two loops due at the same instant; permuting the array must not change outcome.
    const base = seed(
      { op: "create", title: "alpha", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" },
      { op: "create", title: "bravo", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "b" },
    );
    const forward = tick(base.snapshot, T1);
    const reversed = tick({ ...base.snapshot, triggers: [...base.snapshot.triggers].reverse() }, T1);
    const runsOf = (r: ReturnType<typeof tick>) =>
      r.changesets
        .flatMap((c) => c.runs)
        .map((m) => (m.op === "insert" ? `${m.run.taskId}:${m.run.cause}` : `put:${m.run.id}`))
        .sort();
    expect(runsOf(forward)).toEqual(runsOf(reversed));
  });
});

// ---------------------------------------------------------------------------
// Finding #4 — runtime validation + no-op guard
// ---------------------------------------------------------------------------

describe("finding #4: malformed input becomes a typed refusal, never a throw", () => {
  it("a non-string assignee (would hit .includes) refuses cleanly", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { assignee: 123 as never } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });

  it("a non-string cron refuses INVALID_CRON without throwing", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { cron: { evil: true } as never } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_CRON");
  });

  it("an invalid timezone paired with a valid cron refuses INVALID_TIMEZONE (never reaches nextFire)", () => {
    const { d } = run(emptyWorld(), { op: "create", title: "x", cron: "0 7 * * *", timezone: "Mars/Phobos" });
    expect(!d.ok && d.refusal.code).toBe("INVALID_TIMEZONE");
  });

  it("a bad refs payload refuses", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { refs: "not-an-array" as never } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });

  it("a no-op update (no field change, no note) refuses NO_OP — never a silent version bump", () => {
    const w = seed({ op: "create", title: "x" });
    const before = w.snapshot.objects["x"];
    const { world, d } = run(w, { op: "update", id: "x", patch: {} });
    expect(!d.ok && d.refusal.code).toBe("NO_OP");
    expect(world.snapshot.objects["x"]).toBe(before); // untouched, version unchanged
  });

  it("a no-op with a --note is NOT a no-op (the note is the change)", () => {
    const w = seed({ op: "create", title: "x" });
    const { world, d } = run(w, { op: "update", id: "x", patch: {}, note: "still watching" });
    expect(d.ok).toBe(true);
    expect(world.events.at(-1)).toMatchObject({ kind: "note", note: "still watching" });
    expect((world.snapshot.objects["x"] as { version: number }).version).toBe(2);
  });

  it("a timezone-only update on a loop re-derives the cron trigger (not a silent no-op)", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const { world, d } = run(w, { op: "update", id: "loop", patch: { timezone: "America/New_York" } });
    expect(d.ok).toBe(true);
    expect(crons(world.snapshot)[0].timezone).toBe("America/New_York");
  });

  it("a timezone-only update on a NON-loop is a no-op refusal (nothing to re-derive)", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { timezone: "America/New_York" } });
    expect(!d.ok && d.refusal.code).toBe("NO_OP");
  });
});

// ---------------------------------------------------------------------------
// Finding #5 — cron dispatch eligibility
// ---------------------------------------------------------------------------

describe("finding #5: a cron fire on an undispatchable assignee advances the cursor with a notice, no run", () => {
  it("null assignee: cursor advances, no run", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress" });
    const r = tick(w.snapshot, T1);
    expect(r.changesets.flatMap((c) => c.runs)).toHaveLength(0);
    expect(r.notices.join()).toContain("not dispatchable");
    const folded = r.changesets.reduce(foldToWorld, w);
    expect(Date.parse(crons(folded.snapshot)[0].nextFireAt as string)).toBeGreaterThan(Date.parse(T1));
  });

  it("person assignee: cursor advances, no run (consistent with once/assignment)", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "tim@x.com" });
    const r = tick(w.snapshot, T1);
    expect(r.changesets.flatMap((c) => c.runs)).toHaveLength(0);
    expect(r.notices.join()).toContain("not dispatchable");
  });
});

// ---------------------------------------------------------------------------
// once spec-vs-nextFireAt mismatch defense + mirror id occupied
// ---------------------------------------------------------------------------

describe("once trigger integrity", () => {
  it("a once trigger whose spec no longer matches the task's followUpAt is discarded, not fired", () => {
    let w = seed({ op: "create", title: "bet", followUpAt: T1, assignee: "claude" });
    // The task moved its wait to a later date, but a stale alarm still points at T1.
    const stale: Snapshot = {
      ...w.snapshot,
      objects: {
        ...w.snapshot.objects,
        bet: { ...(w.snapshot.objects["bet"] as never as object), followUpAt: "2026-08-20T07:00:00.000Z" } as never,
      },
    };
    w = { snapshot: stale, events: [] };
    const r = tick(w.snapshot, T1);
    expect(r.changesets.flatMap((c) => c.runs)).toHaveLength(0);
    const folded = r.changesets.reduce(foldToWorld, w);
    expect(folded.events.at(-1)).toMatchObject({ kind: "trigger-discarded" });
  });
});

describe("mirror id occupied by another archetype", () => {
  it("mirror add whose derived id collides with a task/doc refuses CONFLICT, never returns the occupier", () => {
    const w = seed({ op: "create", title: "x" });
    // Force a collision: place a task at the mirror's derived id.
    const { world } = run(w, { op: "mirror-add", kind: "url", coords: "https://example.com" });
    const mirror = Object.values(world.snapshot.objects).find((o) => o.archetype === "mirror");
    expect(mirror).toBeDefined();
    const collided: Snapshot = {
      ...world.snapshot,
      objects: {
        ...world.snapshot.objects,
        [mirror!.id]: { archetype: "task", id: mirror!.id, title: "squatter", status: "todo", assignee: null, priority: null, type: null, parent: null, tracks: null, refs: [], followUpAt: null, body: "", version: 1, createdAt: T0, updatedAt: T0 },
      },
    };
    const d = decide({ op: "mirror-add", kind: "url", coords: "https://example.com" }, collided, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("CONFLICT");
  });
});

// ===========================================================================
// M1F round 2 — the judge-triaged findings (adversarial review).
// ===========================================================================

// ---------------------------------------------------------------------------
// #1' — trigger mutations carry a CAS precondition
// ---------------------------------------------------------------------------

describe("finding: trigger mutations are CAS-guarded (no stale put/delete overwrite)", () => {
  it("a tick cursor-advance decided against an OLD cron cannot revert a newer owner cron edit (stale put)", () => {
    // The empirically-confirmed scenario: a tick changeset advancing the cursor
    // is decided against spec '0 7 * * *', but by apply time the owner has
    // edited the spec to '0 9 * * *'. The stale put must CONFLICT, not revert.
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const staleTick = tick(w0.snapshot, T1);
    expect(staleTick.changesets.length).toBeGreaterThan(0);
    // Owner edits the cron spec between decide and apply.
    const edit = decide({ op: "update", id: "loop", patch: { cron: "0 9 * * *" } }, w0.snapshot, HUMAN, T0);
    if (!edit.ok) throw new Error("unreachable");
    const editApplied = applyChangeset(w0.snapshot, edit.changeset);
    expect(editApplied.ok).toBe(true);
    if (!editApplied.ok) return;
    // Now apply the STALE tick changeset over the edited snapshot.
    const staleApplied = applyChangeset(editApplied.snapshot, staleTick.changesets[0]);
    expect(staleApplied.ok).toBe(false);
    if (staleApplied.ok) return;
    expect(staleApplied.conflict.kind).toBe("trigger");
    // The spec the owner set survives.
    expect(crons(editApplied.snapshot)[0].spec).toBe("0 9 * * *");
  });

  it("a stale DELETE over a trigger that changed under it conflicts (never silently drops the newer one)", () => {
    const w0 = seed({ op: "create", title: "bet", followUpAt: T1, assignee: "claude" });
    const once = w0.snapshot.triggers.find((t) => t.kind === "once")!;
    // A changeset that deletes the once trigger, decided against the read base.
    const del = { objects: [], events: [], triggers: [{ op: "delete" as const, id: once.id, expected: once }], runs: [] };
    // Between decide and apply, the trigger's nextFireAt changed (a concurrent edit).
    const drifted: Snapshot = {
      ...w0.snapshot,
      triggers: w0.snapshot.triggers.map((t) => (t.id === once.id ? { ...t, nextFireAt: "2026-08-15T07:00:00.000Z" } : t)),
    };
    const applied = applyChangeset(drifted, del);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("trigger");
  });

  it("a put with expected:null over an already-existing trigger conflicts (must-not-exist)", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const existing = crons(w0.snapshot)[0];
    const cs = {
      objects: [],
      events: [],
      triggers: [{ op: "put" as const, trigger: { ...existing, spec: "0 8 * * *" }, expected: null }],
      runs: [],
    };
    const applied = applyChangeset(w0.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("trigger");
  });

  it("a changeset with two ops for one trigger id is refused (reviewer #8 — order independence)", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const existing = crons(w0.snapshot)[0];
    const cs = {
      objects: [],
      events: [],
      triggers: [
        { op: "put" as const, trigger: { ...existing, spec: "0 8 * * *" }, expected: existing },
        { op: "delete" as const, id: existing.id, expected: existing },
      ],
      runs: [],
    };
    const applied = applyChangeset(w0.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("trigger");
    expect(applied.conflict.message).toContain("twice");
  });

  it("a normal (non-stale) decide->apply of a cron edit still succeeds under CAS", () => {
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const edit = decide({ op: "update", id: "loop", patch: { cron: "0 9 * * *" } }, w0.snapshot, HUMAN, T0);
    if (!edit.ok) throw new Error("unreachable");
    const applied = applyChangeset(w0.snapshot, edit.changeset);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(crons(applied.snapshot)[0].spec).toBe("0 9 * * *");
  });
});

// ---------------------------------------------------------------------------
// #2' — once fires off a stale nextFireAt when it diverges from spec (reviewer #3)
// ---------------------------------------------------------------------------

describe("finding: a once trigger whose nextFireAt diverges from spec is discarded, never fired", () => {
  it("spec in the future but a corrupt earlier nextFireAt does NOT flip status or dispatch", () => {
    let w = seed({ op: "create", title: "bet", followUpAt: "2026-08-20T07:00:00.000Z", assignee: "claude" });
    // Corrupt the alarm cursor to fire ten days early while spec (== followUpAt) stays future.
    const corrupt: Snapshot = {
      ...w.snapshot,
      triggers: w.snapshot.triggers.map((t) =>
        t.kind === "once" ? { ...t, nextFireAt: "2026-08-10T07:00:00.000Z" } : t,
      ),
    };
    w = { snapshot: corrupt, events: [] };
    const fireAt = "2026-08-10T07:05:00.000Z";
    const r = tick(w.snapshot, fireAt);
    expect(r.changesets.flatMap((c) => c.runs)).toHaveLength(0); // no early dispatch
    const folded = r.changesets.reduce(foldToWorld, w);
    const bet = folded.snapshot.objects["bet"];
    expect(bet.archetype === "task" && bet.status).toBe("follow-up"); // NOT flipped to todo
    expect(folded.snapshot.triggers).toHaveLength(0); // consumed via discard
    expect(folded.events.at(-1)).toMatchObject({ kind: "trigger-discarded" });
  });
});

// ---------------------------------------------------------------------------
// #3' — invalid timezone on a non-loop update refuses INVALID_TIMEZONE (reviewer #6)
// ---------------------------------------------------------------------------

describe("finding: invalid timezone is refused on update regardless of cron presence", () => {
  it("an invalid tz on a task with NO cron refuses INVALID_TIMEZONE (matches create)", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { timezone: "Mars/Phobos" } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_TIMEZONE");
  });

  it("a VALID tz on a task with no cron still stays a NO_OP (nothing to re-derive)", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { timezone: "America/New_York" } });
    expect(!d.ok && d.refusal.code).toBe("NO_OP");
  });
});

// ---------------------------------------------------------------------------
// #4' — decide never throws on malformed wire input (reviewer #4, #5)
// ---------------------------------------------------------------------------

describe("finding: decide returns a typed Refusal on malformed input, never throws", () => {
  it("create with a numeric title refuses (no slugify throw) — reviewer #4", () => {
    const d = decide({ op: "create", title: 123 as never }, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });

  it("create with a numeric assignee / non-array refs / numeric parent all refuse, none copied verbatim", () => {
    expect(decide({ op: "create", title: "x", assignee: 5 as never }, emptyWorld().snapshot, HUMAN, T0).ok).toBe(false);
    expect(decide({ op: "create", title: "x", refs: 5 as never }, emptyWorld().snapshot, HUMAN, T0).ok).toBe(false);
    expect(decide({ op: "create", title: "x", parent: 5 as never }, emptyWorld().snapshot, HUMAN, T0).ok).toBe(false);
  });

  it("mirror-add with numeric coords refuses (no .trim throw) — reviewer #5", () => {
    const d = decide({ op: "mirror-add", kind: "url", coords: 5 as never }, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });

  it("doc-put with a numeric body refuses (no Buffer.byteLength throw)", () => {
    const d = decide({ op: "doc-put", key: "k", body: 7 as never }, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });

  it("note with a numeric note refuses", () => {
    const w = seed({ op: "create", title: "x" });
    const d = decide({ op: "note", id: "x", note: 7 as never }, w.snapshot, HUMAN, T0);
    expect(!d.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #5' — applyChangeset enforces one-active-run-per-task (reviewer #7)
// ---------------------------------------------------------------------------

describe("finding: applyChangeset enforces one active run per task", () => {
  it("two manual-run inserts from the same snapshot at different nows conflict at the fold", () => {
    const w = seed({ op: "create", title: "x", assignee: "claude", status: "idea" });
    // Move to todo so a manual run is legal; this dispatches nothing (idea->manual path).
    const toTodo = decide({ op: "update", id: "x", patch: { status: "todo" } }, w.snapshot, HUMAN, T0);
    if (!toTodo.ok) throw new Error("unreachable");
    // Applying the assignment dispatch gives us one active run.
    const applied1 = applyChangeset(w.snapshot, toTodo.changeset);
    expect(applied1.ok).toBe(true);
    if (!applied1.ok) return;
    // Craft a second active-run insert for the same task (a raced dispatch).
    const extraRun = {
      id: "run-raced",
      taskId: "x",
      cause: "manual" as const,
      scheduledAt: T1,
      state: "pending" as const,
      assignee: "claude",
      triggerId: null,
      createdAt: T1,
    };
    const cs = { objects: [], events: [], triggers: [], runs: [{ op: "insert" as const, run: extraRun }] };
    const applied2 = applyChangeset(applied1.snapshot, cs);
    expect(applied2.ok).toBe(false);
    if (applied2.ok) return;
    expect(applied2.conflict.kind).toBe("run");
    expect(applied2.conflict.message).toContain("active run");
  });

  it("fireCron's supersede-then-insert stays legal (the put clears the prior active run first)", () => {
    // Two cron fires in sequence: the second supersedes the still-pending first,
    // then inserts a new pending run — one changeset, order-safe under the invariant.
    const w0 = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const r1 = tick(w0.snapshot, T1);
    const applied1 = r1.changesets.reduce<Snapshot>((s, cs) => {
      const res = applyChangeset(s, cs);
      if (!res.ok) throw new Error(`unexpected conflict: ${res.conflict.message}`);
      return res.snapshot;
    }, w0.snapshot);
    // Second fire the next day supersedes the unclaimed run and inserts a fresh one.
    const r2 = tick(applied1, "2026-08-11T07:05:00.000Z");
    const applied2 = r2.changesets.reduce<Snapshot>((s, cs) => {
      const res = applyChangeset(s, cs);
      if (!res.ok) throw new Error(`unexpected conflict: ${res.conflict.message}`);
      return res.snapshot;
    }, applied1);
    const active = applied2.runs.filter((r) => r.state === "pending" || r.state === "claimed" || r.state === "running");
    expect(active).toHaveLength(1);
  });
});

// ===========================================================================
// M1F round 3 — the judge-triaged adversarial-review findings (C1-C4, T5).
// ===========================================================================

/** Replace the loop's cron trigger with an owner-paused one. types.ts models
 *  disabledBy:"owner" publicly even though no M1 command produces it, so the
 *  snapshot input space includes it — the finalizeTriggers guard must survive
 *  it. */
function withOwnerPausedCron(w: World): World {
  const paused: Snapshot = {
    ...w.snapshot,
    triggers: w.snapshot.triggers.map((t) =>
      t.kind === "cron" ? { ...t, enabled: false, disabledBy: "owner" as const } : t,
    ),
  };
  return { snapshot: paused, events: w.events };
}

// ---------------------------------------------------------------------------
// C1 / T1 — finalizeTriggers preserves an owner-paused cron verbatim
// ---------------------------------------------------------------------------

describe("C1: an owner-paused cron is never auto-revived by an unrelated update", () => {
  it("an unrelated `update {title}` leaves the owner-paused cron untouched (no revive, no put)", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    w = withOwnerPausedCron(w);
    const { world, d } = run(w, { op: "update", id: "loop", patch: { title: "renamed" } });
    expect(d.ok).toBe(true);
    const cron = crons(world.snapshot)[0];
    expect(cron).toMatchObject({ enabled: false, disabledBy: "owner", spec: "0 7 * * *" });
  });

  it("the paused cron emits NO trigger mutation on an unrelated update (preserved byte-for-byte)", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    w = withOwnerPausedCron(w);
    const before = crons(w.snapshot)[0];
    const d = decide({ op: "update", id: "loop", patch: { title: "renamed" } }, w.snapshot, HUMAN, T1);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // No put/delete touches the cron id.
    expect(d.changeset.triggers.some((m) => (m.op === "delete" ? m.id : m.trigger.id) === before.id)).toBe(false);
  });

  it("staying disabled survives a terminal/non-terminal cycle (done then todo again)", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    w = withOwnerPausedCron(w);
    // -> done (terminal): still owner-paused, never re-stamped to invariant.
    w = run(w, { op: "update", id: "loop", patch: { status: "done" } }, T1).world;
    expect(crons(w.snapshot)[0]).toMatchObject({ enabled: false, disabledBy: "owner" });
    // -> todo again (leaving terminal): #2' re-arm must NOT fire for an owner pause.
    w = run(w, { op: "update", id: "loop", patch: { status: "todo" } }, T1).world;
    expect(crons(w.snapshot)[0]).toMatchObject({ enabled: false, disabledBy: "owner" });
  });

  it("an EXPLICIT owner cron edit (patch.cron set) DOES re-arm the paused cron", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    w = withOwnerPausedCron(w);
    const { world, d } = run(w, { op: "update", id: "loop", patch: { cron: "0 9 * * *" } }, T1);
    expect(d.ok).toBe(true);
    expect(crons(world.snapshot)[0]).toMatchObject({ enabled: true, disabledBy: null, spec: "0 9 * * *" });
  });
});

// ---------------------------------------------------------------------------
// C2 / T2 — update patch title:null / body:null is refused, not stringified
// ---------------------------------------------------------------------------

describe("C2: null title/body is refused, never stored as the string \"null\"", () => {
  it("patch {title:null} refuses INVALID_REFERENCE and never bumps the version", () => {
    const w = seed({ op: "create", title: "x" });
    const before = w.snapshot.objects["x"];
    const { world, d } = run(w, { op: "update", id: "x", patch: { title: null as never } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
    expect(world.snapshot.objects["x"]).toBe(before); // untouched, version unchanged
  });

  it("patch {body:null} refuses INVALID_REFERENCE and never bumps the version", () => {
    const w = seed({ op: "create", title: "x" });
    const before = w.snapshot.objects["x"];
    const { world, d } = run(w, { op: "update", id: "x", patch: { body: null as never } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
    expect(world.snapshot.objects["x"]).toBe(before);
  });

  it("the genuinely-nullable fields still accept null (assignee/priority/type/parent/tracks)", () => {
    const w = seed({ op: "create", title: "x", assignee: "claude", priority: "P1", type: "goal" });
    const { world, d } = run(w, { op: "update", id: "x", patch: { assignee: null, priority: null, type: null } });
    expect(d.ok).toBe(true);
    const t = world.snapshot.objects["x"];
    expect(t.archetype === "task" && t).toMatchObject({ assignee: null, priority: null, type: null });
  });
});

// ---------------------------------------------------------------------------
// C3 / T4 — applyChangeset enforces written version === expected + 1
// ---------------------------------------------------------------------------

describe("C3: applyChangeset enforces the CAS token advances (version === expected + 1)", () => {
  it("a put whose object.version EQUALS expectedVersion conflicts (token would not move)", () => {
    const w = seed({ op: "create", title: "x" }); // version 1
    const current = w.snapshot.objects["x"];
    const cs = {
      objects: [{ object: { ...current, version: 1 }, expectedVersion: 1 }],
      events: [],
      triggers: [],
      runs: [],
    };
    const applied = applyChangeset(w.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("object");
    expect(applied.conflict.message).toContain("expected + 1");
  });

  it("a put that SKIPS ahead (version 3 over expected 1) conflicts", () => {
    const w = seed({ op: "create", title: "x" });
    const current = w.snapshot.objects["x"];
    const cs = {
      objects: [{ object: { ...current, version: 3 }, expectedVersion: 1 }],
      events: [],
      triggers: [],
      runs: [],
    };
    const applied = applyChangeset(w.snapshot, cs);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.conflict.kind).toBe("object");
  });

  it("a put BELOW (version 1 over expected 1 but object at v1) — a second stale changeset no longer re-applies", () => {
    const w = seed({ op: "create", title: "x" });
    const current = w.snapshot.objects["x"];
    // A stale changeset that would leave the object at version 1: conflicts, so a
    // subsequent identical stale changeset cannot re-apply (CAS token intact).
    const stale = {
      objects: [{ object: { ...current, title: "stale-a", version: 1 }, expectedVersion: 1 }],
      events: [],
      triggers: [],
      runs: [],
    };
    expect(applyChangeset(w.snapshot, stale).ok).toBe(false);
  });

  it("a create (expected null, version 1) and a real update (expected N, version N+1) both still apply", () => {
    const w = seed({ op: "create", title: "x" }); // create emitted 1/null already
    const d = decide({ op: "update", id: "x", patch: { title: "y" } }, w.snapshot, HUMAN, T1);
    if (!d.ok) throw new Error("unreachable");
    expect(d.changeset.objects[0]).toMatchObject({ expectedVersion: 1, object: { version: 2 } });
    const applied = applyChangeset(w.snapshot, d.changeset);
    expect(applied.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 / T3 — decide guards a malformed command, never throws / returns undefined
// ---------------------------------------------------------------------------

describe("C4: decide refuses a malformed command envelope, never throws or returns undefined", () => {
  it("decide(null) refuses UNKNOWN_COMMAND (never a TypeError reading command.op)", () => {
    let d: Decision;
    expect(() => {
      d = decide(null as never, emptyWorld().snapshot, HUMAN, T0);
    }).not.toThrow();
    d = decide(null as never, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_COMMAND");
  });

  it("decide({}) refuses UNKNOWN_COMMAND (no op verb)", () => {
    const d = decide({} as never, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_COMMAND");
  });

  it("decide({op:\"bogus\"}) refuses UNKNOWN_COMMAND (never returns undefined off the switch)", () => {
    const d = decide({ op: "bogus" } as never, emptyWorld().snapshot, HUMAN, T0);
    expect(d).toBeDefined();
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_COMMAND");
  });

  it("an array envelope refuses UNKNOWN_COMMAND", () => {
    const d = decide([] as never, emptyWorld().snapshot, HUMAN, T0);
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_COMMAND");
  });
});

// ---------------------------------------------------------------------------
// T5 — the SAME task's due once + cron in both array orders yield identical
//      snapshots, changesets, and notices (pins fireOrder determinism itself,
//      not a projection of it).
// ---------------------------------------------------------------------------

describe("T5: tick is fully order-stable for one task's due once + cron", () => {
  it("both trigger-array orders yield identical snapshots, changesets, and notices", () => {
    // A follow-up task that is ALSO a loop: cron armed + a once slot due at the
    // same instant. Constructed directly (the model keeps follow-up with a cron).
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", timezone: "UTC", status: "in-progress", assignee: "a" });
    const dueAt = "2026-08-10T06:00:00.000Z";
    const cronDue = w.snapshot.triggers.map((t) => (t.kind === "cron" ? { ...t, nextFireAt: dueAt } : t));
    const once: Trigger = {
      id: onceTriggerId("loop"),
      taskId: "loop",
      kind: "once",
      spec: dueAt,
      timezone: null,
      enabled: true,
      disabledBy: null,
      nextFireAt: dueAt,
    };
    const base: Snapshot = {
      ...w.snapshot,
      objects: {
        ...w.snapshot.objects,
        loop: { ...(w.snapshot.objects["loop"] as never as object), status: "follow-up", followUpAt: dueAt } as never,
      },
      triggers: [...cronDue, once],
    };
    const reversed: Snapshot = { ...base, triggers: [...base.triggers].reverse() };

    const at = "2026-08-10T06:05:00.000Z";
    const forward = tick(base, at);
    const backward = tick(reversed, at);

    // Full changesets are byte-identical (fireOrder canonicalizes both inputs).
    expect(forward.changesets).toEqual(backward.changesets);
    expect(forward.notices).toEqual(backward.notices);

    // And the resulting snapshots match (fold both from their OWN input, since a
    // reversed trigger array is a different snapshot object but the same set).
    const foldFrom = (s: Snapshot, r: ReturnType<typeof tick>): Snapshot =>
      r.changesets.reduce((acc, cs) => foldToWorld({ snapshot: acc, events: [] }, cs).snapshot, s);
    const foldedForward = foldFrom(base, forward);
    const foldedBackward = foldFrom(reversed, backward);
    // Compare as sets (trigger array order in the result mirrors the input order).
    const norm = (s: Snapshot) => ({
      objects: s.objects,
      triggers: [...s.triggers].sort((x, y) => (x.id < y.id ? -1 : 1)),
      runs: [...s.runs].sort((x, y) => (x.id < y.id ? -1 : 1)),
    });
    expect(norm(foldedForward)).toEqual(norm(foldedBackward));
  });
});
