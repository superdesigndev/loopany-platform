/**
 * FAILED-RUN RESILIENCE (haiku-5) - a one-shot dispatch that dies must not
 * strand its task: run-finish(failed) re-arms the follow-up alarm on the
 * x4 backoff ladder (1h -> 4h -> 16h) and PARKS to `idea` one failure past it.
 * The streak derives from persisted run rows; a done run resets it; a task the
 * agent moved off in-progress before dying is respected (no kernel override).
 */

import { describe, expect, it } from "vitest";
import {
  type Command,
  type Provenance,
  type TaskObject,
  decide,
  emptyWorld,
  tick,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u" };
const HOST: Provenance = { entrance: "clock", actorId: "host" };
const T0 = "2026-08-24T07:00:00.000Z";

function cmd(world: World, c: Command, now: string, actor: Provenance = HOST): World {
  const d = decide(c, world.snapshot, actor, now);
  if (!d.ok) throw new Error(`refused: ${d.refusal.message}`);
  return foldToWorld(world, d.changeset);
}

function tickAll(world: World, now: string): World {
  return tick(world.snapshot, now).changesets.reduce(foldToWorld, world);
}

function task(world: World, id: string): TaskObject {
  return world.snapshot.objects[id] as TaskObject;
}

/** Fire the due alarm at `now`, claim the pending run, fail it. */
function failOnePass(world: World, id: string, now: string): World {
  let w = tickAll(world, now);
  const pending = w.snapshot.runs.find((r) => r.taskId === id && r.state === "pending");
  if (!pending) throw new Error(`no pending run for ${id} at ${now}`);
  w = cmd(w, { op: "run-claim", runId: pending.id, sessionId: "s" }, now);
  w = cmd(w, { op: "run-finish", runId: pending.id, outcome: "failed", note: "stalled" }, now);
  return w;
}

const plusHours = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();

describe("failed-run resilience", () => {
  it("re-arms on the 1h/4h/16h ladder, then parks to idea on the 4th failure", () => {
    let w = cmd(
      emptyWorld(),
      { op: "create", title: "watch", id: "watch", assignee: "claude", followUpAt: T0 },
      "2026-08-23T07:00:00.000Z",
      HUMAN,
    );
    // Failure 1: alarm fired, run failed -> follow-up re-armed +1h.
    w = failOnePass(w, "watch", T0);
    expect(task(w, "watch")).toMatchObject({ status: "follow-up", followUpAt: plusHours(1) });
    // Failure 2: +4h from that fire.
    w = failOnePass(w, "watch", plusHours(1));
    expect(task(w, "watch").followUpAt).toBe(new Date(Date.parse(plusHours(1)) + 4 * 3_600_000).toISOString());
    // Failure 3: +16h.
    w = failOnePass(w, "watch", plusHours(5));
    expect(task(w, "watch").followUpAt).toBe(new Date(Date.parse(plusHours(5)) + 16 * 3_600_000).toISOString());
    // Failure 4: one past the ladder - parked, alarm gone, trigger deleted.
    w = failOnePass(w, "watch", plusHours(21));
    expect(task(w, "watch")).toMatchObject({ status: "idea", followUpAt: null });
    expect(w.snapshot.triggers.filter((t) => t.taskId === "watch")).toHaveLength(0);
    const parkedNote = w.events.at(-1);
    expect(parkedNote).toMatchObject({ kind: "status-changed" });
    expect(parkedNote?.note).toContain("auto-parked after 4 consecutive failed runs");
  });

  it("a done run resets the streak", () => {
    let w = cmd(
      emptyWorld(),
      { op: "create", title: "watch", id: "watch", assignee: "claude", followUpAt: T0 },
      "2026-08-23T07:00:00.000Z",
      HUMAN,
    );
    w = failOnePass(w, "watch", T0); // streak 1
    // Success on the retry pass.
    w = tickAll(w, plusHours(1));
    const pending = w.snapshot.runs.find((r) => r.taskId === "watch" && r.state === "pending")!;
    w = cmd(w, { op: "run-claim", runId: pending.id, sessionId: "s" }, plusHours(1));
    // The agent does its pass honestly (re-arms its own alarm) then the host
    // reports done - kernel resilience must stay out of the way.
    w = cmd(
      w,
      { op: "update", id: "watch", patch: { status: "follow-up", followUpAt: plusHours(24) }, note: "ok" },
      plusHours(1),
      { entrance: "agent-run", actorId: pending.id, sessionId: "s" },
    );
    w = cmd(w, { op: "run-finish", runId: pending.id, outcome: "done" }, plusHours(1));
    expect(task(w, "watch")).toMatchObject({ status: "follow-up", followUpAt: plusHours(24) });
    // Next failure counts as streak 1 again (+1h, not +4h).
    w = failOnePass(w, "watch", plusHours(24));
    expect(task(w, "watch").followUpAt).toBe(new Date(Date.parse(plusHours(24)) + 3_600_000).toISOString());
  });

  it("respects an agent who moved the task off in-progress before dying", () => {
    let w = cmd(
      emptyWorld(),
      { op: "create", title: "watch", id: "watch", assignee: "claude", followUpAt: T0 },
      "2026-08-23T07:00:00.000Z",
      HUMAN,
    );
    w = tickAll(w, T0);
    const pending = w.snapshot.runs.find((r) => r.taskId === "watch" && r.state === "pending")!;
    w = cmd(w, { op: "run-claim", runId: pending.id, sessionId: "s" }, T0);
    // The agent finished its real work (status done) but the process then died.
    w = cmd(
      w,
      { op: "update", id: "watch", patch: { status: "done" }, note: "goal met" },
      T0,
      { entrance: "agent-run", actorId: pending.id, sessionId: "s" },
    );
    w = cmd(w, { op: "run-finish", runId: pending.id, outcome: "failed", note: "crashed after" }, T0);
    expect(task(w, "watch").status).toBe("done"); // never overridden
  });
});
