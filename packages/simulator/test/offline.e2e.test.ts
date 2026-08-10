/**
 * OFFLINE DAY + catch-up (§4): a day flagged `offline` ticks WITHOUT `--spawn`,
 * so a due trigger's pending run is LEFT pending (no agent launched); the next
 * online day's normal `tick --spawn` claims it - the durable-inbox catch-up.
 *
 * Driven through the real engine on the replay tier with a WEEKLY-Wednesday cron
 * (the seo-engine cadence): the offline Wednesday's fire mints a pending run that
 * never runs, and - because no NEW same-cron fire arrives before the next day (a
 * daily cron would SUPERSEDE the waiting run; a weekly one has no successor that
 * week) - Thursday's `tick --spawn` claims the carried-over Wednesday run. The
 * run's scheduledAt is Wednesday, its completion Thursday: late a day, not failed.
 */

import { loadEvents, loadSnapshot } from "@loopany/cli";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario, snapshotDirFor } from "../src/index.js";
import type { Scenario } from "../src/types.js";
import { replayAgentPath } from "../scenarios/smoke-seo.js";

const WEEKLY_ID = "weekly-loop";

/** A weekly Wednesday-07:00 cron task (assigned to replay). Its replay entry just
 *  notes. Wed 09-09 is offline; Thu 09-10 catches it up. */
function offlineScenario(): Scenario {
  return {
    name: "offline",
    profiles: { replay: { cmd: process.execPath, args: [replayAgentPath()] } },
    replayScript: {
      [WEEKLY_ID]: [["note", WEEKLY_ID, "ran"]],
    },
    setup: {
      tasks: [
        [
          "create",
          "weekly loop",
          "--id",
          WEEKLY_ID,
          "--cron",
          "0 7 * * 3", // Wednesdays
          "--timezone",
          "UTC",
          "--status",
          "in-progress",
          "--assignee",
          "replay",
        ],
      ],
    },
    days: [
      { date: "2026-09-09", morning: [], evening: [], offline: true }, // Wed: offline fire
      { date: "2026-09-10", morning: [], evening: [] }, // Thu: online, catches up
    ],
  };
}

describe("offline day + next-day catch-up", () => {
  let root: string;
  const runId = "test-offline";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-offline-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  it("the offline Wed leaves its fire pending; Thu claims it (catch-up, late not failed)", () => {
    const res = runScenario(offlineScenario(), { runId, dir: root });
    for (const c of res.setup) expect(c.exitCode, c.label).toBe(0);

    // Wed snapshot: the 07:00 fire minted a run that NEVER ran (no --spawn), so a
    // pending cron run scheduled Wed sits in the snapshot, nothing done.
    const wed = loadSnapshot(join(snapshotDirFor(runId, 1), ".loopany"));
    const wedRuns = wed.runs.filter((r) => r.taskId === WEEKLY_ID && r.cause === "cron");
    expect(wedRuns.length).toBe(1);
    expect(wedRuns[0].state).toBe("pending");
    expect(wedRuns[0].scheduledAt.startsWith("2026-09-09")).toBe(true);

    // Thu snapshot: the SAME Wednesday-scheduled run is now done (claimed on Thu's
    // catch-up tick) - no failure, no second run minted.
    const thu = loadSnapshot(join(snapshotDirFor(runId, 2), ".loopany"));
    const thuRuns = thu.runs.filter((r) => r.taskId === WEEKLY_ID && r.cause === "cron");
    expect(thuRuns.length).toBe(1);
    expect(thuRuns[0].state).toBe("done");
    expect(thuRuns[0].scheduledAt.startsWith("2026-09-09"), "scheduled Wed").toBe(true);

    // The run STARTED on Thursday (the catch-up), proving it ran a day late, not
    // that the fire failed or was dropped. The single cron run's claim (run-started,
    // actorId = the run id) carries the Thursday instant.
    const events = loadEvents(join(res.workspace, ".loopany"), WEEKLY_ID);
    const started = events.find(
      (e) => e.kind === "run-started" && e.provenance.actorId === thuRuns[0].id,
    );
    expect(started?.at.startsWith("2026-09-10"), "claimed Thu").toBe(true);
  });
});
