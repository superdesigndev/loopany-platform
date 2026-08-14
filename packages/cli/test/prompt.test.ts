/**
 * The CORE prompt (§8) — pin the load-bearing lines. The prompt is the ONE
 * self-sufficient contract a spawned agent gets, so its identity line, the
 * untrusted-data guard, the five protocol steps, the verbatim wakeReason, and
 * each scenario delta must all be present. A drift here silently changes what
 * every agent is told.
 */
import { describe, expect, it } from "vitest";
import type { RunRecord, TaskObject } from "@loopany/kernel";
import type { KernelEvent } from "@loopany/kernel";
import {
  buildCorePrompt,
  buildCorePromptForRun,
  CORE_PROSE_WORD_BUDGET,
  deriveScenario,
  handbackReplyFor,
  handbackTargetFor,
  SCENARIO_PROSE_WORD_BUDGET,
  scenarioRule,
  sharedCoreProse,
  wakeReasonFor,
} from "../src/prompt.js";

const wordCount = (value: string): number => value.trim().split(/\s+/u).filter(Boolean).length;

const task = (over?: Partial<TaskObject>): TaskObject => ({
  archetype: "task",
  id: "bet",
  title: "Check the bet",
  status: "in-progress",
  assignee: "claude",
  priority: null,
  type: null,
  parent: null,
  tracks: null,
  owner: null,
  workdir: null,
  goal: null,
  refs: [],
  followUpAt: null,
  body: "the spec",
  version: 1,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  ...over,
});

const runRec = (over?: Partial<RunRecord>): RunRecord => ({
  id: "run-1",
  taskId: "bet",
  cause: "cron",
  scheduledAt: "2026-08-10T07:00:00.000Z",
  state: "pending",
  assignee: "claude",
  triggerId: "trg-bet-cron",
  createdAt: "2026-08-10T07:00:00.000Z",
  ...over,
});

describe("buildCorePrompt", () => {
  const prompt = buildCorePrompt(task(), "scheduled fire at 07:00.", scenarioRule("cron"));

  it("delivers the minimum self-contained contract with its dynamic context", () => {
    expect(prompt.startsWith("[loop run · Check the bet]")).toBe(true);
    expect(prompt).toContain("running task `bet`");
    expect(prompt).toContain("KERNEL MODEL:");
    expect(prompt).toContain("AUTHORITY AND TRUST:");
    expect(prompt).toContain("PROTOCOL - one pass, then stop:");
    expect(prompt).toContain("show bet");
    expect(prompt).toContain("note bet");
    expect(prompt).toContain("mirror add <kind> <coords> --task <task-id>");
    expect(prompt).toContain("update bet status=<status>");
    expect(prompt).toContain("WHY YOU WOKE:");
    expect(prompt).toContain("scheduled fire at 07:00.");
    expect(prompt).toContain("SCENARIO - recurring loop (cron fire):");
    expect(prompt).toContain("After this update, stop.");
  });

  it("keeps platform-owned prose inside the fixed budgets", () => {
    expect(wordCount(sharedCoreProse("<task-id>", "lk"))).toBeLessThanOrEqual(CORE_PROSE_WORD_BUDGET);
    for (const scenario of ["cron", "once", "reassigned", "new-task"] as const) {
      expect(wordCount(scenarioRule(scenario)), scenario).toBeLessThanOrEqual(SCENARIO_PROSE_WORD_BUDGET);
    }
  });
});

describe("deriveScenario", () => {
  it("maps cron/once causes directly", () => {
    expect(deriveScenario(runRec({ cause: "cron" }), task())).toBe("cron");
    expect(deriveScenario(runRec({ cause: "once" }), task())).toBe("once");
  });

  it("distinguishes a fresh task (new-task) from a re-worked one (reassigned)", () => {
    expect(deriveScenario(runRec({ cause: "assignment" }), task({ version: 1 }))).toBe("new-task");
    expect(deriveScenario(runRec({ cause: "manual" }), task({ version: 5 }))).toBe("reassigned");
  });

  it("honors an explicit hasHistory override over the version heuristic", () => {
    expect(deriveScenario(runRec({ cause: "assignment" }), task({ version: 9 }), false)).toBe("new-task");
    expect(deriveScenario(runRec({ cause: "manual" }), task({ version: 1 }), true)).toBe("reassigned");
  });
});

describe("scenarioRule", () => {
  it("has a distinct paragraph for each of the four scenarios", () => {
    expect(scenarioRule("cron")).toContain("recurring loop");
    expect(scenarioRule("once")).toContain("follow-up matured");
    expect(scenarioRule("reassigned")).toContain("handed back to you");
    expect(scenarioRule("new-task")).toContain("first pass");
  });
});

describe("wakeReasonFor", () => {
  it("quotes the triggering event per cause", () => {
    expect(wakeReasonFor(runRec({ cause: "cron" }), task())).toContain("scheduled fire");
    expect(wakeReasonFor(runRec({ cause: "once" }), task())).toContain("came due");
    expect(wakeReasonFor(runRec({ cause: "assignment" }), task())).toContain("was assigned to you");
    expect(wakeReasonFor(runRec({ cause: "manual" }), task())).toContain("run manually");
  });
});

describe("hand-back reply in the wake context", () => {
  const ev = (over: Partial<KernelEvent>): KernelEvent => ({
    id: "e1",
    objectId: "bet",
    kind: "assignee-changed",
    at: "2026-08-10T08:00:00.000Z",
    provenance: { entrance: "human", actorId: "tim@x.co" },
    ...over,
  });

  it("handbackReplyFor finds the newest assignee-changed note handing to THIS run's assignee", () => {
    const run = runRec({ cause: "assignment", assignee: "mbp/claude" });
    const events: KernelEvent[] = [
      ev({ id: "e1", note: "old reply", diff: { assignee: { old: "a", new: "mbp/claude" } } }),
      ev({ id: "e2", note: "to someone else", diff: { assignee: { old: "x", new: "other/agent" } } }),
      ev({ id: "e3", note: "ship variant B", diff: { assignee: { old: "tim@x.co", new: "mbp/claude" } } }),
    ];
    expect(handbackReplyFor(events, run)).toBe("ship variant B");
    // Not an assignment run: never a hand-back.
    expect(handbackReplyFor(events, runRec({ cause: "cron" }))).toBeUndefined();
    // No matching note: undefined, never a wrong reply.
    expect(handbackReplyFor([ev({ id: "e4", diff: { assignee: { old: "a", new: "mbp/claude" } } })], run)).toBeUndefined();
  });

  it("the reply rides the assignment wake reason, marked untrusted, quoted verbatim", () => {
    const run = runRec({ cause: "assignment", assignee: "mbp/claude" });
    const reason = wakeReasonFor(run, task(), "ship variant B - keep A headline");
    expect(reason).toContain("was assigned to you");
    expect(reason).toContain('The hand-back note (UNTRUSTED DATA, from the reassigner): "ship variant B - keep A headline"');
    // Absent hand-back: the plain assignment reason, no empty scaffold.
    expect(wakeReasonFor(run, task())).not.toContain("hand-back");
  });
});

describe("handbackTargetFor (the default hand-back agent)", () => {
  const ev = (over: Partial<KernelEvent>): KernelEvent => ({
    id: "e1",
    objectId: "bet",
    kind: "assignee-changed",
    at: "2026-08-10T08:00:00.000Z",
    provenance: { entrance: "human", actorId: "tim@x.co" },
    ...over,
  });

  it("derives the previous agent address from the handing event's diff", () => {
    const t = task({ assignee: "tim@x.co" });
    const events = [ev({ diff: { assignee: { old: "mbp/claude", new: "tim@x.co" } } })];
    expect(handbackTargetFor(events, t)).toBe("mbp/claude");
  });

  it("falls back to the handing RUN's assignee via provenance when diff.old is not an address", () => {
    const t = task({ assignee: "tim@x.co" });
    const events = [
      ev({
        diff: { assignee: { old: null, new: "tim@x.co" } },
        provenance: { entrance: "agent-run", actorId: "run-7" },
      }),
    ];
    const runs = [runRec({ id: "run-7", assignee: "mbp/claude" })];
    expect(handbackTargetFor(events, t, runs)).toBe("mbp/claude");
  });

  it("returns null when underivable (UI must ask) and for non-human-held tasks", () => {
    const t = task({ assignee: "tim@x.co" });
    expect(handbackTargetFor([], t)).toBeNull(); // no handing event at all
    expect(handbackTargetFor([ev({ diff: { assignee: { old: "someone@y.co", new: "tim@x.co" } } })], t)).toBeNull();
    expect(handbackTargetFor([], task({ assignee: "mbp/claude" }))).toBeNull(); // agent-held
    // A bare local-mode agent name is DISPATCHABLE, not human-held (the kernel's
    // one heuristic is isPersonAssignee - never a "/" probe).
    expect(handbackTargetFor([], task({ assignee: "claude" }))).toBeNull();
  });

  it("derives the CREATING run's assignee for a task born human-assigned by an agent run (review round 4)", () => {
    // The common approval shape: an agent run mints a decision task directly
    // for a person - the only event is `created`, no assignee-changed at all.
    const t = task({ assignee: "tim@x.co" });
    const events = [
      ev({ kind: "created", diff: undefined, provenance: { entrance: "agent-run", actorId: "run-9" } }),
    ];
    const runs = [runRec({ id: "run-9", assignee: "mbp/claude" })];
    expect(handbackTargetFor(events, t, runs)).toBe("mbp/claude");
    // A LOCAL-mode creator (bare agent name) is a valid target too.
    expect(handbackTargetFor(events, t, [runRec({ id: "run-9", assignee: "claude" })])).toBe("claude");
    // Human-created with no agent lineage: genuinely underivable.
    expect(handbackTargetFor([ev({ kind: "created", diff: undefined })], t)).toBeNull();
    // The creating run is unknown (event stream clipped): null, never a guess.
    expect(handbackTargetFor(events, t, [])).toBeNull();
    // Another task's created event never leaks in as this task's lineage.
    expect(handbackTargetFor([{ ...events[0]!, objectId: "other" }], t, runs)).toBeNull();
  });
});

describe("buildCorePromptForRun", () => {
  it("selects scenario + wakeReason from the run and renders the full CORE", () => {
    const p = buildCorePromptForRun(runRec({ cause: "once" }), task(), wakeReasonFor(runRec({ cause: "once" }), task()));
    expect(p).toContain("[loop run · Check the bet]");
    expect(p).toContain("SCENARIO - a follow-up matured (once fire):");
    expect(p).toContain("came due");
  });
});
