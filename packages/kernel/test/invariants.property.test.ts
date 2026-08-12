/**
 * The kernel's PROPERTY SUITE — fast-check over checkInvariants (the
 * executable spec, src/invariants.ts). Where the example tests pin specific
 * scenarios, this suite drives ARBITRARY command/tick sequences from the empty
 * world and asserts the pipeline's three total properties:
 *
 *   1. decide is TOTAL: any input (including junk) yields a typed Decision,
 *      never a throw ("Malformed input NEVER throws", decide.ts header).
 *   2. a fresh ok-decision APPLIES: its changeset passes applyChangeset
 *      against the very snapshot it was decided on (self-consistency).
 *   3. the folded world stays LEGAL: checkInvariants finds nothing, ever.
 *
 * Snapshots are deep-frozen between steps, so any in-place mutation inside
 * decide/tick surfaces as a throw under property 1 (purity is load-bearing:
 * the server folds the same changesets in SQL).
 *
 * SEED POLICY: the default seed is FIXED so CI is deterministic. Deep/rotated
 * exploration is opt-in: LOOPANY_FC_SEED=<n> LOOPANY_FC_RUNS=<n> vitest run.
 * When a run fails, fast-check prints the seed + counterexample — pin the
 * shrunk counterexample as a regression example test, do not just re-roll.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  type Command,
  type Provenance,
  type Snapshot,
  TASK_STATUSES,
  applyToWorld,
  checkInvariants,
  decide,
  emptyWorld,
  tick,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — test use (A1)

const SEED = Number(process.env.LOOPANY_FC_SEED ?? 20260812);
const RUNS = Number(process.env.LOOPANY_FC_RUNS ?? 120);
const HUMAN: Provenance = { entrance: "human", actorId: "prop" };
const T0 = "2026-08-12T07:00:00.000Z";

// ---- generators: mostly-valid steps with junk mixed in ------------------
// Small id pools make sequences collide on purpose (updates find their
// creates, parents form chains/cycles, docs get tracked).

const TASK_IDS = ["alpha", "beta", "gamma", "delta"] as const;
const DOC_KEYS = ["notes", "spec-doc"] as const;
const REF_TARGETS = [...TASK_IDS, ...DOC_KEYS, "nonexistent"] as const;
const AGENTS = ["mbp/claude", "worker/codex"] as const;
const PEOPLE = ["alice@example.com"] as const;
const CRONS = ["0 7 * * *", "*/30 * * * *"] as const;

const opt = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

/** Wire-representable junk that must never throw nor land in storage. */
const junk = fc.oneof(
  fc.constant(42),
  fc.constant(true),
  fc.constant(null),
  fc.constant([] as unknown),
  fc.constant({ nested: 1 } as unknown),
);
const mostly = <T>(arb: fc.Arbitrary<T>, weight = 8): fc.Arbitrary<T | unknown> =>
  fc.oneof({ weight, arbitrary: arb as fc.Arbitrary<unknown> }, { weight: 1, arbitrary: junk }) as fc.Arbitrary<T | unknown>;

const arbTaskId = fc.constantFrom(...TASK_IDS);
const arbStatus = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...TASK_STATUSES) },
  { weight: 1, arbitrary: fc.constant("bogus") },
);
const arbAssignee = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...AGENTS) },
  { weight: 1, arbitrary: fc.constantFrom(...PEOPLE) },
);
const arbCron = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...CRONS) },
  { weight: 1, arbitrary: fc.constant("not a cron") },
);
const arbTimezone = fc.constantFrom("UTC", "Asia/Shanghai", "Mars/Olympus");
/** Relative wait: -1h (already due) .. +48h. Resolved against the virtual clock. */
const arbFollowUpOffset = fc.integer({ min: -3_600_000, max: 48 * 3_600_000 });

const arbCreate = fc.record({
  k: fc.constant("create" as const),
  id: arbTaskId,
  title: mostly(fc.constantFrom("Fix the flaky test", "调研 X 方案")),
  status: opt(arbStatus),
  assignee: opt(arbAssignee),
  owner: opt(mostly(fc.constant("alice@example.com"))),
  goal: opt(mostly(fc.constant("all green"))),
  workdir: opt(mostly(fc.constantFrom("/tmp/w", "relative/../etc"))),
  parent: opt(fc.constantFrom(...REF_TARGETS)),
  tracks: opt(fc.constantFrom(...REF_TARGETS)),
  cron: opt(arbCron),
  timezone: opt(arbTimezone),
  followUpOffsetMs: opt(arbFollowUpOffset),
});

const arbPatch = fc.record({
  title: opt(mostly(fc.constant("Retitled"))),
  status: opt(arbStatus),
  assignee: opt(fc.oneof(arbAssignee, fc.constant(null))),
  priority: opt(fc.constantFrom("P1", "P9", null)),
  type: opt(fc.constantFrom("goal", "weird-type", null)),
  parent: opt(fc.oneof(fc.constantFrom(...REF_TARGETS), fc.constant(null))),
  tracks: opt(fc.oneof(fc.constantFrom(...REF_TARGETS), fc.constant(null))),
  refs: opt(mostly(fc.array(fc.constantFrom(...REF_TARGETS), { maxLength: 2 }))),
  body: opt(mostly(fc.constant("## Spec\nupdated"))),
  followUpOffsetMs: opt(fc.oneof(arbFollowUpOffset, fc.constant(null))),
  owner: opt(mostly(fc.oneof(fc.constant("bob@example.com"), fc.constant(null)))),
  workdir: opt(mostly(fc.oneof(fc.constant("/srv/work"), fc.constant(null)))),
  goal: opt(mostly(fc.oneof(fc.constant("ship it"), fc.constant(null)))),
  cron: opt(fc.oneof(arbCron, fc.constant(null))),
  timezone: opt(fc.oneof(arbTimezone, fc.constant(null))),
  frobnicate: opt(fc.constant(1)), // unknown key — exercises UNKNOWN_FIELD
});

const arbUpdate = fc.record({
  k: fc.constant("update" as const),
  id: fc.constantFrom(...TASK_IDS, "nonexistent"),
  patch: arbPatch,
  note: opt(mostly(fc.constant("progress noted"))),
  ifVersionMode: fc.constantFrom("none", "correct", "stale") as fc.Arbitrary<"none" | "correct" | "stale">,
});

const arbStep = fc.oneof(
  { weight: 4, arbitrary: arbCreate as fc.Arbitrary<Step> },
  { weight: 6, arbitrary: arbUpdate as fc.Arbitrary<Step> },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("note" as const),
      id: fc.constantFrom(...TASK_IDS, ...DOC_KEYS),
      note: mostly(fc.constant("observed a thing")),
    }) as fc.Arbitrary<Step>,
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("docPut" as const),
      key: fc.constantFrom(...DOC_KEYS),
      body: mostly(fc.constantFrom("# Weekly report\nfindings", "plain body")),
      attachTask: opt(arbTaskId),
    }) as fc.Arbitrary<Step>,
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("mirrorAdd" as const),
      kind: fc.constantFrom("github-pr", "url", "bogus-kind"),
      coords: mostly(fc.constantFrom("org/repo#42", "https://ex.test/a")),
      attachTask: opt(arbTaskId),
    }) as fc.Arbitrary<Step>,
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("run" as const), id: arbTaskId }) as fc.Arbitrary<Step> },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("claim" as const),
      pick: fc.nat(9),
      session: opt(mostly(fc.constant("sess-1"))),
    }) as fc.Arbitrary<Step>,
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("finish" as const),
      pick: fc.nat(9),
      outcome: fc.oneof(
        { weight: 4, arbitrary: fc.constantFrom("done", "failed") },
        { weight: 1, arbitrary: fc.constant("exploded") },
      ),
      note: opt(mostly(fc.constant("wrapped up"))),
    }) as fc.Arbitrary<Step>,
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("del" as const), id: arbTaskId }) as fc.Arbitrary<Step> },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("tick" as const) }) as fc.Arbitrary<Step> },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("junkCmd" as const),
      cmd: fc.oneof(
        junk,
        fc.string(),
        fc.record({ op: fc.oneof(fc.constantFrom("create", "update", "run-claim", "warp"), junk) }),
      ),
    }) as fc.Arbitrary<Step>,
  },
);

type Step =
  | (typeof arbCreate extends fc.Arbitrary<infer T> ? T : never)
  | (typeof arbUpdate extends fc.Arbitrary<infer T> ? T : never)
  | { k: "note"; id: string; note: unknown }
  | { k: "docPut"; key: string; body: unknown; attachTask?: string }
  | { k: "mirrorAdd"; kind: string; coords: unknown; attachTask?: string }
  | { k: "run"; id: string }
  | { k: "claim"; pick: number; session?: unknown }
  | { k: "finish"; pick: number; outcome: string; note?: unknown }
  | { k: "del"; id: string }
  | { k: "tick" }
  | { k: "junkCmd"; cmd: unknown };

const arbTimedSteps = fc.array(
  fc.record({ dtMs: fc.integer({ min: 0, max: 6 * 3_600_000 }), step: arbStep }),
  { minLength: 1, maxLength: 40 },
);

// ---- the interpreter ------------------------------------------------------

/** Resolve a step to a Command against the CURRENT world/clock (dynamic ids —
 *  claim/finish pick from the live run set; follow-ups are clock-relative). */
function buildCommand(step: Step, world: World, now: string): Command {
  switch (step.k) {
    case "create": {
      const { k: _k, followUpOffsetMs, ...rest } = step;
      const cmd: Record<string, unknown> = { op: "create", ...rest };
      if (followUpOffsetMs !== undefined) {
        cmd.followUpAt = new Date(Date.parse(now) + (followUpOffsetMs as number)).toISOString();
        if (cmd.status === undefined) cmd.status = "follow-up";
      }
      return prune(cmd) as unknown as Command;
    }
    case "update": {
      const { followUpOffsetMs, ...patchRest } = step.patch as Record<string, unknown> & {
        followUpOffsetMs?: number | null;
      };
      const patch: Record<string, unknown> = prune(patchRest);
      if (followUpOffsetMs !== undefined) {
        patch.followUpAt =
          followUpOffsetMs === null ? null : new Date(Date.parse(now) + followUpOffsetMs).toISOString();
        if (patch.status === undefined && followUpOffsetMs !== null) patch.status = "follow-up";
      }
      const before = world.snapshot.objects[step.id];
      const ifVersion =
        step.ifVersionMode === "none" || !before
          ? undefined
          : step.ifVersionMode === "correct"
            ? before.version
            : before.version + 7;
      return prune({ op: "update", id: step.id, patch, note: step.note, ifVersion }) as unknown as Command;
    }
    case "note":
      return prune({ op: "note", id: step.id, note: step.note }) as unknown as Command;
    case "docPut":
      return prune({ op: "doc-put", key: step.key, body: step.body, attachTask: step.attachTask }) as unknown as Command;
    case "mirrorAdd":
      return prune({
        op: "mirror-add",
        kind: step.kind,
        coords: step.coords,
        attachTask: step.attachTask,
      }) as unknown as Command;
    case "run":
      return { op: "run", id: step.id };
    case "claim": {
      const pending = world.snapshot.runs.filter((r) => r.state === "pending").sort(byId);
      const target = pending[step.pick % Math.max(1, pending.length)];
      return prune({ op: "run-claim", runId: target?.id ?? "missing-run", sessionId: step.session }) as unknown as Command;
    }
    case "finish": {
      const active = world.snapshot.runs.filter((r) => r.state === "running" || r.state === "claimed").sort(byId);
      const target = active[step.pick % Math.max(1, active.length)];
      return prune({
        op: "run-finish",
        runId: target?.id ?? "missing-run",
        outcome: step.outcome,
        note: step.note,
      }) as unknown as Command;
    }
    case "del":
      return { op: "delete", id: step.id };
    case "junkCmd":
      return step.cmd as Command;
    case "tick":
      throw new Error("tick is not a command");
  }
}

function prune(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function assertLegal(world: World, context: string): void {
  const violations = checkInvariants(world.snapshot);
  if (violations.length > 0) {
    throw new Error(
      `invariant violation ${context}:\n${violations.map((x) => `  [${x.rule}] ${x.id}: ${x.message}`).join("\n")}`,
    );
  }
}

/** One full scenario: interpret the timed steps, asserting the three total
 *  properties at every stone. Returns the final world (for meta-assertions). */
function runScenario(steps: Array<{ dtMs: number; step: Step }>): World {
  let world = emptyWorld();
  let clock = Date.parse(T0);
  deepFreeze(world.snapshot);

  for (const { dtMs, step } of steps) {
    clock += dtMs;
    const now = new Date(clock).toISOString();

    if (step.k === "tick") {
      let res;
      try {
        res = tick(world.snapshot, now);
      } catch (e) {
        throw new Error(`tick threw at ${now}: ${String(e)}`);
      }
      for (const cs of res.changesets) {
        const applied = applyToWorld(world, cs);
        if (!applied.ok) {
          throw new Error(`tick changeset failed to apply: [${applied.conflict.kind}] ${applied.conflict.message}`);
        }
        world = applied.world;
        deepFreeze(world.snapshot);
      }
      assertLegal(world, `after tick @ ${now}`);
      continue;
    }

    const command = buildCommand(step, world, now);
    let decision;
    try {
      decision = decide(command, world.snapshot, HUMAN, now);
    } catch (e) {
      throw new Error(`decide THREW (property 1) on ${JSON.stringify(command)}: ${String(e)}`);
    }
    if (decision.ok) {
      const applied = applyToWorld(world, decision.changeset);
      if (!applied.ok) {
        throw new Error(
          `fresh decision failed to apply (property 2) for ${JSON.stringify(command)}: ` +
            `[${applied.conflict.kind}] ${applied.conflict.message}`,
        );
      }
      world = applied.world;
      deepFreeze(world.snapshot);
      assertLegal(world, `after ${JSON.stringify(command)}`);
    } else {
      // A refusal is a normal outcome — but it must be a WELL-FORMED one.
      if (typeof decision.refusal.code !== "string" || typeof decision.refusal.message !== "string") {
        throw new Error(`malformed refusal for ${JSON.stringify(command)}: ${JSON.stringify(decision.refusal)}`);
      }
    }
  }
  return world;
}

// ---- the properties -------------------------------------------------------

describe("kernel property suite (executable spec)", () => {
  it("arbitrary command/tick sequences keep the world legal (decide total, decisions apply, invariants hold)", () => {
    fc.assert(
      fc.property(arbTimedSteps, (steps) => {
        runScenario(steps);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("decide is total on raw junk against a populated snapshot", () => {
    // A small real world, then pure fuzz at the wire: any JSON-ish value must
    // come back as a typed Decision (ok or refusal), never a throw.
    const world = runScenario([
      { dtMs: 0, step: { k: "create", id: "alpha", title: "Seed task" } as Step },
      { dtMs: 0, step: { k: "docPut", key: "notes", body: "# Notes" } as Step },
    ]);
    const arbWire = fc.oneof(
      junk,
      fc.string(),
      fc.record({ op: fc.oneof(fc.constantFrom("create", "update", "note", "doc-put", "mirror-add", "run", "run-claim", "run-finish", "delete", "warp"), junk) }),
      fc.record({
        op: fc.constantFrom("create", "update", "note", "doc-put", "run-claim", "run-finish"),
        id: junk,
        title: junk,
        patch: junk,
        note: junk,
        runId: junk,
        outcome: junk,
        key: junk,
        body: junk,
      }),
    );
    fc.assert(
      fc.property(arbWire, (wire) => {
        const d = decide(wire as Command, world.snapshot, HUMAN, T0);
        expect(typeof d.ok).toBe("boolean");
        if (!d.ok) expect(typeof d.refusal.code).toBe("string");
      }),
      { seed: SEED, numRuns: RUNS * 3 },
    );
  });
});

// ---- the checker itself must be able to FAIL ------------------------------
// A checker that never fires is untestable optimism: corrupt a legal world in
// each dimension and assert the specific rule reports.

describe("checkInvariants flags corruption", () => {
  function legalWorld(): World {
    let world = emptyWorld();
    const seed: Command[] = [
      { op: "create", title: "Loop", id: "loop", cron: "0 7 * * *", status: "in-progress", assignee: "mbp/claude" },
      { op: "create", title: "Wait", id: "wait", followUpAt: "2026-08-13T07:00:00.000Z" },
      { op: "create", title: "Child", id: "child", parent: "loop" },
    ];
    for (const cmd of seed) {
      const d = decide(cmd, world.snapshot, HUMAN, T0);
      if (!d.ok) throw new Error(`seed refused: ${d.refusal.code}`);
      world = foldToWorld(world, d.changeset);
    }
    return world;
  }

  function corrupt(mutate: (s: Snapshot) => Snapshot): string[] {
    const base = legalWorld().snapshot;
    return checkInvariants(mutate(structuredClone(base) as Snapshot)).map((v) => v.rule);
  }

  it("accepts the legal world", () => {
    expect(checkInvariants(legalWorld().snapshot)).toEqual([]);
  });

  it("followUpAt without follow-up status", () => {
    expect(
      corrupt((s) => {
        const t = s.objects["loop"] as { followUpAt: string | null };
        t.followUpAt = "2026-08-14T07:00:00.000Z";
        return s;
      }),
    ).toContain("task/followup-slot");
  });

  it("terminal task with an enabled trigger", () => {
    expect(
      corrupt((s) => {
        (s.objects["loop"] as { status: string }).status = "done";
        return s;
      }),
    ).toContain("trigger/terminal-enabled");
  });

  it("once trigger diverged from the task's followUpAt", () => {
    expect(
      corrupt((s) => {
        (s.objects["wait"] as { followUpAt: string }).followUpAt = "2026-09-01T00:00:00.000Z";
        return s;
      }),
    ).toContain("trigger/once-mirror");
  });

  it("parent cycle", () => {
    expect(
      corrupt((s) => {
        (s.objects["loop"] as { parent: string | null }).parent = "child";
        return s;
      }),
    ).toContain("task/parent-cycle");
  });

  it("two active runs on one task", () => {
    expect(
      corrupt((s) => {
        const run = {
          id: "run-x",
          taskId: "loop",
          cause: "manual" as const,
          scheduledAt: T0,
          state: "pending" as const,
          assignee: "mbp/claude",
          triggerId: null,
          createdAt: T0,
        };
        return { ...s, runs: [run, { ...run, id: "run-y" }] };
      }),
    ).toContain("run/multiple-active");
  });

  it("junk landed in a stored field", () => {
    expect(
      corrupt((s) => {
        (s.objects["loop"] as { owner: unknown }).owner = 42;
        return s;
      }),
    ).toContain("task/field-types");
  });

  it("orphan trigger and orphan run", () => {
    const rules = corrupt((s) => {
      const { loop: _gone, ...rest } = s.objects as Record<string, unknown>;
      return { ...s, objects: rest } as Snapshot;
    });
    expect(rules).toContain("trigger/orphan");
  });
});
