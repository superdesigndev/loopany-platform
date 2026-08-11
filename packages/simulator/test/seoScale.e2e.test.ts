/**
 * SEO-SCALE (Scenario 02) on the REPLAY tier - a deterministic e2e of the whole
 * two-loop collaboration: bet lifecycle (open -> win -> scale-handoff -> kill),
 * the pull-mode SINGLE-update claim, the offline-Wed catch-up, and tim's total
 * absence. File products (trial/scale pages) are not expressible as replay CLI
 * argv, so the file-gated world stages don't fire here - this tier proves the
 * object/handoff mechanics; the real haiku run proves the file-reactive arcs.
 *
 * The 19-day scenario spawns many CLI subprocesses; run it ONCE and share.
 */

import { loadEvents, loadSnapshot } from "@loopany/cli";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotDirFor } from "../src/index.js";
import { runCli, type RunnerDeps } from "../src/run.js";
import type { SimResult } from "../src/types.js";
import {
  BET_A_ID,
  BET_B_ID,
  BET_C_ID,
  BET_MANAGER_ID,
  ENGINE_ID,
  SCALE_A_ID,
} from "../scenarios/seo-scale.js";

describe("seo-scale e2e (replay tier)", () => {
  let dir: string;
  let res: SimResult;
  let wsDir: string;
  const runId = "test-seo-scale";

  const deps: RunnerDeps = {
    seedIdentity: () => {
      throw new Error("seedIdentity must not run on the replay tier");
    },
    smoke: () => {
      throw new Error("smoke must not run on the replay tier");
    },
    log: () => {},
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sim-seo-scale-"));
    res = runCli({ scenario: "seo-scale", tier: "replay", runId, dir }, deps);
    wsDir = join(res.workspace, ".loopany");
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  it("runs 19 days with no refusals", () => {
    expect(res.days).toHaveLength(19);
    for (const c of res.setup) expect(c.exitCode, c.label).toBe(0);
    for (const day of res.days)
      for (const c of day.commands) expect(c.exitCode, `${day.date} ${c.label}`).toBe(0);
  });

  it("(a) bet A is won (done) and scale-A is created UNASSIGNED with the right parent", () => {
    const s = loadSnapshot(wsDir);
    const betA = s.objects[BET_A_ID];
    expect(betA?.archetype === "task" && betA.status).toBe("done");
    // Lineage is visible in the tree: bets are children of the loop that minted
    // them (kernel `tracks` refuses task targets, so parent IS the lineage field).
    expect(betA?.archetype === "task" && betA.parent).toBe(BET_MANAGER_ID);

    const scaleA = s.objects[SCALE_A_ID];
    expect(scaleA?.archetype).toBe("task");
    expect(scaleA?.archetype === "task" && scaleA.parent).toBe(BET_A_ID);
    // Born unassigned: the assignee first appears via the engine's claim, not at
    // creation. The created event carries no assignee; the ONLY assignee-changed
    // is null -> claude.
    const events = loadEvents(wsDir, SCALE_A_ID);
    const assigneeChanges = events.filter((e) => e.kind === "assignee-changed");
    expect(assigneeChanges).toHaveLength(1);
    expect(assigneeChanges[0].diff?.assignee).toEqual({ old: null, new: "claude" });
  });

  it("(b) engine claims scale-A with a SINGLE update - one assignee change + status set together, no extra run", () => {
    const events = loadEvents(wsDir, SCALE_A_ID);
    // The claim landed BOTH fields in one update: the assignee-changed and the
    // todo->in-progress status-changed share the SAME instant (one command).
    const assigneeAt = events.find((e) => e.kind === "assignee-changed")?.at;
    const claimStatus = events.find(
      (e) =>
        e.kind === "status-changed" &&
        e.diff?.status &&
        (e.diff.status as { old: unknown }).old === "todo" &&
        (e.diff.status as { new: unknown }).new === "in-progress",
    );
    expect(assigneeAt).toBeTruthy();
    expect(claimStatus?.at).toBe(assigneeAt);

    // NO assignment-cause run was ever minted for scale-A: a two-step claim would
    // have flipped it todo+assigned and dispatched a spurious run. Zero runs total.
    const s = loadSnapshot(wsDir);
    expect(s.runs.filter((r) => r.taskId === SCALE_A_ID)).toHaveLength(0);
  });

  it("(c) bet B is killed (archived)", () => {
    const s = loadSnapshot(wsDir);
    const betB = s.objects[BET_B_ID];
    expect(betB?.archetype === "task" && betB.status).toBe("archived");
  });

  it("the opportunity keyword is discovered as bet C", () => {
    const s = loadSnapshot(wsDir);
    const betC = s.objects[BET_C_ID];
    expect(betC?.archetype).toBe("task");
    expect(betC?.archetype === "task" && betC.status).toBe("in-progress");
  });

  it("(d) the portfolio doc exists with content", () => {
    const s = loadSnapshot(wsDir);
    const doc = s.objects["seo-portfolio"];
    expect(doc?.archetype).toBe("doc");
    expect(doc?.archetype === "doc" && doc.body.length).toBeGreaterThan(0);
  });

  it("(d2) weekly reports are FROZEN under dated keys and the docs auto-attach to the loop", () => {
    const s = loadSnapshot(wsDir);
    // One immortal report per Monday - the window (seo-portfolio) is replaced,
    // the records accumulate.
    for (const week of ["2026-w36", "2026-w37", "2026-w38"]) {
      expect(s.objects[`seo-report-${week}`]?.archetype, week).toBe("doc");
    }
    // The in-run ambient attach (LOOPANY_TASK_ID) built the task->doc edges
    // with ZERO extra replay commands: the loop's refs are the archive index.
    const loop = s.objects[BET_MANAGER_ID];
    expect(loop?.archetype === "task" && loop.refs).toContain("seo-portfolio");
    expect(loop?.archetype === "task" && loop.refs).toContain("seo-report-2026-w37");
  });

  it("(e) the offline Wed left the engine's fire pending; it completed on Thursday (catch-up, not failed)", () => {
    const s = loadSnapshot(wsDir);
    const wedFire = s.runs.find(
      (r) => r.taskId === ENGINE_ID && r.cause === "cron" && r.scheduledAt.startsWith("2026-09-09"),
    );
    expect(wedFire, "the offline-Wed engine fire exists").toBeTruthy();
    expect(wedFire?.state).toBe("done"); // caught up, not failed/dropped

    // It was CLAIMED on Thursday 09-10 (a day late), proven by its run-started
    // instant (actorId = the run id).
    const events = loadEvents(wsDir, ENGINE_ID);
    const started = events.find(
      (e) => e.kind === "run-started" && e.provenance.actorId === wedFire!.id,
    );
    expect(started?.at.startsWith("2026-09-10"), "engine ran Thursday").toBe(true);

    // No failed run anywhere (the deferral is not a failure).
    expect(s.runs.some((r) => r.state === "failed")).toBe(false);
  });

  it("(f) tim received zero notes (the don't-escalate-when-you-shouldn't invariant)", () => {
    const s = loadSnapshot(wsDir);
    let timNotes = 0;
    for (const id of Object.keys(s.objects)) {
      for (const e of loadEvents(wsDir, id)) {
        if (e.provenance.entrance === "human" && e.provenance.actorId === "tim") timNotes++;
      }
    }
    expect(timNotes).toBe(0);
    // And no task is assigned to tim.
    const tasks = Object.values(s.objects).filter((o) => o.archetype === "task");
    expect(tasks.some((t) => t.archetype === "task" && t.assignee === "tim")).toBe(false);
  });
});
