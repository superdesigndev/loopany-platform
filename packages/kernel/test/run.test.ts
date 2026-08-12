/**
 * run-claim / run-finish lifecycle — the handoff record's state machine
 * (pending -> running -> done|failed), the one-shot todo->in-progress flip on
 * claim, the run-started / run-returned events on the task's stream, and the
 * throw-free refusals on malformed run commands (§3, §5.1).
 */
import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type RunRecord,
  type World,
  decide,
  emptyWorld,
  tick,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js";

const HUMAN: Provenance = { entrance: "human", actorId: "u-tim" };
const AGENT: Provenance = { entrance: "agent-run", actorId: "run-1", sessionId: "sess-1" };
const T0 = "2026-08-09T07:00:00.000Z";
const DUE = "2026-08-10T07:00:00.000Z";
const LATE = "2026-08-10T09:30:00.000Z";

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.code} ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

function exec(world: World, cmd: Command, actor: Provenance, now: string): World {
  const d = decide(cmd, world.snapshot, actor, now);
  if (!d.ok) throw new Error(`${cmd.op} refused: ${d.refusal.code} ${d.refusal.message}`);
  return foldToWorld(world, d.changeset);
}

function tickAll(world: World, now: string): World {
  return tick(world.snapshot, now).changesets.reduce(foldToWorld, world);
}

function onlyRun(world: World): RunRecord {
  expect(world.snapshot.runs).toHaveLength(1);
  return world.snapshot.runs[0];
}

describe("run-claim (one-shot dispatch)", () => {
  // An assignment run is created when a todo task gets a dispatchable assignee.
  const seedAssignment = (): World =>
    seed({ op: "create", title: "wire header", id: "wire", assignee: "claude", status: "todo" });

  it("claims a pending run -> running, flips todo -> in-progress, emits run-started", () => {
    const w0 = seedAssignment();
    const run = onlyRun(w0);
    expect(run.state).toBe("pending");

    const w1 = exec(w0, { op: "run-claim", runId: run.id, sessionId: "sess-1" }, AGENT, LATE);
    const claimed = onlyRun(w1);
    expect(claimed.state).toBe("running");
    expect(claimed.sessionId).toBe("sess-1");

    const task = w1.snapshot.objects["wire"];
    expect(task.archetype === "task" && task.status).toBe("in-progress");

    // both the flip and the run-started ride the task's stream.
    const kinds = w1.events.filter((e) => e.objectId === "wire").map((e) => e.kind);
    expect(kinds).toContain("status-changed");
    expect(kinds).toContain("run-started");
    const started = w1.events.find((e) => e.kind === "run-started");
    expect(started?.provenance).toEqual(AGENT);
  });

  it("a cron run leaves the resident status untouched on claim (recurring)", () => {
    const w0 = seed({
      op: "create",
      title: "nightly",
      id: "nightly",
      cron: "0 7 * * *",
      timezone: "UTC",
      status: "in-progress",
      assignee: "claude",
    });
    const fired = tickAll(w0, LATE);
    const cronRun = fired.snapshot.runs.find((r) => r.cause === "cron");
    expect(cronRun?.state).toBe("pending");

    const w1 = exec(fired, { op: "run-claim", runId: cronRun!.id }, AGENT, LATE);
    const task = w1.snapshot.objects["nightly"];
    // status stays in-progress; only the run moved and a run-started was recorded.
    expect(task.archetype === "task" && task.status).toBe("in-progress");
    expect(w1.snapshot.runs.find((r) => r.id === cronRun!.id)?.state).toBe("running");
    expect(w1.events.some((e) => e.kind === "run-started")).toBe(true);
    // no status-changed from the claim (the cron task never flips).
    expect(w1.events.some((e) => e.kind === "status-changed")).toBe(false);
  });

  it("sessionId is optional and defaults to null", () => {
    const w0 = seedAssignment();
    const run = onlyRun(w0);
    const w1 = exec(w0, { op: "run-claim", runId: run.id }, AGENT, LATE);
    expect(onlyRun(w1).sessionId).toBeNull();
  });

  it("refuses claiming a non-pending run", () => {
    const w0 = seedAssignment();
    const run = onlyRun(w0);
    const w1 = exec(w0, { op: "run-claim", runId: run.id }, AGENT, LATE);
    const d = decide({ op: "run-claim", runId: run.id }, w1.snapshot, AGENT, LATE);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("RUN_NOT_CLAIMABLE");
  });

  it("refuses an unknown run id", () => {
    const w0 = seedAssignment();
    const d = decide({ op: "run-claim", runId: "run-nope" }, w0.snapshot, AGENT, LATE);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("UNKNOWN_RUN");
  });
});

describe("run-finish", () => {
  const claimed = (): World => {
    const w0 = seed({ op: "create", title: "wire", id: "wire", assignee: "claude", status: "todo" });
    const run = onlyRun(w0);
    return exec(w0, { op: "run-claim", runId: run.id, sessionId: "sess-1" }, AGENT, LATE);
  };

  it("finishes a running run -> done, records the note, emits run-returned", () => {
    const w = claimed();
    const run = onlyRun(w);
    const w1 = exec(w, { op: "run-finish", runId: run.id, outcome: "done", note: "shipped" }, AGENT, LATE);
    const finished = onlyRun(w1);
    expect(finished.state).toBe("done");
    expect(finished.note).toBe("shipped");
    const returned = w1.events.find((e) => e.kind === "run-returned");
    expect(returned?.objectId).toBe("wire");
    expect(returned?.note).toContain("shipped");
  });

  it("records the host agent's OWN session id (the transcript key) when reported", () => {
    const w = claimed();
    const run = onlyRun(w);
    const uuid = "60d3f5a2-1111-4222-8333-444455556666";
    const w1 = exec(
      w,
      { op: "run-finish", runId: run.id, outcome: "done", note: "ok", agentSessionId: uuid },
      AGENT,
      LATE,
    );
    const finished = onlyRun(w1);
    expect(finished.agentSessionId).toBe(uuid);
    // Distinct from the kernel's claim-time correlation session.
    expect(finished.sessionId).toBe("sess-1");
    // Absent stays absent (a replay shim / non-claude host reports none).
    const w2 = claimed();
    const r2 = onlyRun(w2);
    const w3 = exec(w2, { op: "run-finish", runId: r2.id, outcome: "done" }, AGENT, LATE);
    expect(onlyRun(w3).agentSessionId).toBeUndefined();
    // Malformed: non-string / oversized are throw-free refusals.
    for (const bad of [9 as unknown as string, "x".repeat(300)]) {
      const d = decide(
        { op: "run-finish", runId: r2.id, outcome: "done", agentSessionId: bad },
        w2.snapshot,
        AGENT,
        LATE,
      );
      expect(d.ok).toBe(false);
    }
  });

  it("a failed one-shot run re-arms the follow-up alarm instead of stranding (haiku-5)", () => {
    const w = claimed();
    const run = onlyRun(w);
    const w1 = exec(w, { op: "run-finish", runId: run.id, outcome: "failed", note: "oom" }, AGENT, LATE);
    expect(onlyRun(w1).state).toBe("failed");
    // The stranded in-progress task is NOT left dead: first failure re-arms
    // follow-up +1h (the backoff ladder's first rung). The full ladder/park
    // semantics live in failedRunResilience.test.ts.
    const after = w1.snapshot.objects["wire"];
    expect(after.archetype === "task" && after.status).toBe("follow-up");
    expect(after.archetype === "task" && after.followUpAt).toBe(
      new Date(Date.parse(LATE) + 3_600_000).toISOString(),
    );
  });

  it("refuses finishing a PENDING run directly (the claim cannot be skipped — §3)", () => {
    const w0 = seed({ op: "create", title: "wire", id: "wire", assignee: "claude", status: "todo" });
    const run = onlyRun(w0);
    expect(run.state).toBe("pending");
    const d = decide({ op: "run-finish", runId: run.id, outcome: "done" }, w0.snapshot, AGENT, LATE);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refusal.code).toBe("RUN_NOT_ACTIVE");
      expect(d.refusal.hint).toContain("claim it first");
    }
  });

  it("refuses re-finishing a terminal run", () => {
    const w = claimed();
    const run = onlyRun(w);
    const w1 = exec(w, { op: "run-finish", runId: run.id, outcome: "done" }, AGENT, LATE);
    const d = decide({ op: "run-finish", runId: run.id, outcome: "done" }, w1.snapshot, AGENT, LATE);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("RUN_NOT_ACTIVE");
  });

  it("refuses an invalid outcome", () => {
    const w = claimed();
    const run = onlyRun(w);
    const d = decide(
      { op: "run-finish", runId: run.id, outcome: "maybe" } as unknown as Command,
      w.snapshot,
      AGENT,
      LATE,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("INVALID_OUTCOME");
  });
});

describe("run commands never throw on malformed input", () => {
  it("null / missing fields refuse, never throw", () => {
    const snap = emptyWorld().snapshot;
    for (const cmd of [
      { op: "run-claim" },
      { op: "run-claim", runId: 42 },
      { op: "run-claim", runId: "r", sessionId: 7 },
      { op: "run-finish" },
      { op: "run-finish", runId: "r" },
      { op: "run-finish", runId: "r", outcome: "done", note: 9 },
    ] as unknown as Command[]) {
      const d = decide(cmd, snap, HUMAN, T0);
      expect(d.ok).toBe(false);
    }
  });

  it("a once follow-up dispatch can be claimed and finished (full lifecycle)", () => {
    const w0 = seed({ op: "create", title: "bet", id: "bet", followUpAt: DUE, assignee: "claude" });
    const fired = tickAll(w0, LATE); // once fires: follow-up -> todo + run(pending)
    const run = fired.snapshot.runs.find((r) => r.cause === "once");
    expect(run?.state).toBe("pending");
    const w1 = exec(fired, { op: "run-claim", runId: run!.id, sessionId: "s" }, AGENT, LATE);
    // the once dispatch is one-shot: todo -> in-progress on claim.
    const task = w1.snapshot.objects["bet"];
    expect(task.archetype === "task" && task.status).toBe("in-progress");
    const w2 = exec(w1, { op: "run-finish", runId: run!.id, outcome: "done", note: "done" }, AGENT, LATE);
    expect(w2.snapshot.runs.find((r) => r.id === run!.id)?.state).toBe("done");
  });
});
