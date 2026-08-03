/**
 * The production-loop migration's PURE half — the column mapping, the charter
 * extraction, the status mapping — asserted without a database.
 *
 * The mapping is spec §5.5's table, and the one judgment call in it
 * (`charterFromTaskFile`) is exactly the kind of thing that is cheap to get
 * subtly wrong and expensive to notice later, so it is pinned directly.
 */
import { describe, expect, it } from "vitest";

import type { Loop } from "../db/schema.js";
import { charterFromTaskFile, payloadForLoop, plan, statusForLoop, teamForLoop } from "./loopMigration.js";

/** A shipping loop row, all columns present so the payload mapping is exercised. */
function loopRow(over: Partial<Loop> = {}): Loop {
  return {
    id: "loop-abc",
    userId: "u_alice",
    teamId: "team-alpha",
    channelId: null,
    machineId: "m_1",
    name: "Housekeeper",
    cron: "0 7 * * *",
    timezone: "Asia/Shanghai",
    workdir: "/repo",
    taskFile: "/repo/loops/housekeeper/README.md",
    taskFileContent: null,
    taskFileSyncedAt: null,
    workflow: null,
    ui: null,
    stateSchema: null,
    notify: "auto",
    allowControl: true,
    goal: null,
    completedAt: null,
    completionReason: null,
    model: null,
    agent: "claude-code",
    enabled: true,
    nextRunAt: null,
    state: null,
    evolvedRunCount: null,
    evolveDue: null,
    editRequest: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as Loop;
}

describe("charterFromTaskFile", () => {
  it("takes the `## Spec` section when the task file has one", () => {
    const md = ["# Housekeeper", "", "## Spec", "", "Sweep the repo daily.", "", "## Log", "", "2026-01-01 ok"].join("\n");
    expect(charterFromTaskFile(md)).toBe("Sweep the repo daily.");
  });

  it("stops at the next heading of the same or higher level, not the first one it sees", () => {
    const md = ["## Spec", "line one", "### Detail", "still spec", "## Log", "not spec"].join("\n");
    expect(charterFromTaskFile(md)).toBe("line one\n### Detail\nstill spec");
  });

  it("runs to the end of the file when nothing follows the section", () => {
    expect(charterFromTaskFile("## Spec\nonly this")).toBe("only this");
  });

  it("matches the heading case-insensitively, and only at `##`", () => {
    expect(charterFromTaskFile("## SPEC\nx")).toBe("x");
    expect(charterFromTaskFile("### Spec\nx")).toBe("### Spec\nx"); // not a section header
  });

  it("falls back to the WHOLE file when there is no Spec section (spec §5.5's `/ prompt`)", () => {
    expect(charterFromTaskFile("just some instructions")).toBe("just some instructions");
  });

  it("returns null for an unsynced or empty file rather than an empty charter", () => {
    expect(charterFromTaskFile(null)).toBeNull();
    expect(charterFromTaskFile("")).toBeNull();
    expect(charterFromTaskFile("   \n\n ")).toBeNull();
    expect(charterFromTaskFile("## Spec\n\n")).toBeNull();
  });
});

describe("statusForLoop", () => {
  it("maps enabled → active, disabled → paused", () => {
    expect(statusForLoop({ enabled: true, completedAt: null })).toBe("active");
    expect(statusForLoop({ enabled: false, completedAt: null })).toBe("paused");
  });

  it("maps a COMPLETED (closed) loop to retired — the rewrite has no closed-loop preset", () => {
    expect(statusForLoop({ enabled: true, completedAt: "2026-05-01T00:00:00.000Z" })).toBe("retired");
    expect(statusForLoop({ enabled: false, completedAt: "2026-05-01T00:00:00.000Z" })).toBe("retired");
  });
});

describe("teamForLoop", () => {
  it("uses the loop's team", () => {
    expect(teamForLoop({ teamId: "team-x", userId: "u_1" })).toBe("team-x");
  });

  it("falls back to the personal team for a pre-team row (objects.team_id is NOT NULL)", () => {
    expect(teamForLoop({ teamId: null, userId: "u_1" })).toBe("team-u_1");
  });
});

describe("payloadForLoop", () => {
  it("carries `goal` so nothing is lost when a closed loop retires (spec §5.5)", () => {
    const p = payloadForLoop(loopRow({ goal: "reach 100 PRs", completedAt: "2026-05-01T00:00:00.000Z" }))!;
    expect(p.goal).toBe("reach 100 PRs");
    expect(p.completedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("omits every column that got its own objects column", () => {
    const p = payloadForLoop(loopRow())!;
    for (const mapped of ["id", "teamId", "name", "cron", "timezone", "nextRunAt", "enabled", "createdAt", "updatedAt"]) {
      expect(p, mapped).not.toHaveProperty(mapped);
    }
  });

  it("carries the execution config that has no column", () => {
    const p = payloadForLoop(loopRow())!;
    expect(p).toMatchObject({ machineId: "m_1", userId: "u_alice", agent: "claude-code", notify: "auto", workdir: "/repo" });
  });

  it("excludes taskFileContent — the charter is derived from it and `loops` stays its source", () => {
    const p = payloadForLoop(loopRow({ taskFileContent: "## Spec\nbig" }))!;
    expect(p).not.toHaveProperty("taskFileContent");
  });

  it("drops nulls so two runs over the same row build the identical payload", () => {
    const p = payloadForLoop(loopRow())!;
    expect(p).not.toHaveProperty("goal");
    expect(payloadForLoop(loopRow())).toEqual(payloadForLoop(loopRow()));
  });
});

describe("plan", () => {
  it("keeps the loop id VERBATIM so run history and artifact paths keep resolving", () => {
    expect(plan(loopRow({ id: "loop-1s2d3f-abcd1234" })).input.id).toBe("loop-1s2d3f-abcd1234");
  });

  it("keeps the loop's OWN timestamps — a migration must not restamp history as today", () => {
    expect(plan(loopRow()).input.now).toBe("2026-01-01T00:00:00.000Z");
  });

  it("carries the cadence onto the loop object", () => {
    const { input } = plan(loopRow({ nextRunAt: "2026-08-04T07:00:00.000Z" }));
    expect(input.cron).toBe("0 7 * * *");
    expect(input.timezone).toBe("Asia/Shanghai");
    expect(input.nextFire).toBe("2026-08-04T07:00:00.000Z");
  });

  it("does NOT arm a paused or retired loop — importing a cursor would start it", () => {
    expect(plan(loopRow({ enabled: false, nextRunAt: "2026-08-04T07:00:00.000Z" })).input.nextFire).toBeNull();
    expect(plan(loopRow({ completedAt: "2026-05-01T00:00:00.000Z", nextRunAt: "2026-08-04T07:00:00.000Z" })).input.nextFire).toBeNull();
  });

  it("maps name → title and the task file's Spec → body (the charter)", () => {
    const { input } = plan(loopRow({ taskFileContent: "# H\n## Spec\nsweep the repo\n## Log\nx" }));
    expect(input.title).toBe("Housekeeper");
    expect(input.body).toBe("sweep the repo");
  });

  it("is a pure function — same row in, same plan out", () => {
    expect(plan(loopRow()).planned).toEqual(plan(loopRow()).planned);
  });
});
