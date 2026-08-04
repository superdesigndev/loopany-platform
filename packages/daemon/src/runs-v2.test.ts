import { describe, expect, it } from "vitest";

import { deliveryFromRunsV2, runsV2Enabled } from "./daemon.js";

describe("LOOPANY_RUNS_V2", () => {
  it("defaults off so the shipping poll/report behavior remains selected", () => {
    expect(runsV2Enabled({})).toBe(false);
    expect(runsV2Enabled({ LOOPANY_RUNS_V2: "0" })).toBe(false);
  });

  it("adapts a v2 claim into the existing runner with charter + loop identity", () => {
    const delivery = deliveryFromRunsV2(
      {
        run: { id: "run-1", loopId: "loop-1", loopTitle: "Housekeeper", scope: "routine" },
        charter: "Pull the worklist.",
        identityLine: "You are running for loop-1 (\"Housekeeper\").",
        scopeNote: null,
      },
      "dk_device",
    );
    expect(delivery).toMatchObject({ runId: "run-1", runToken: "dk_device", runsV2: { deviceToken: "dk_device" } });
    expect(delivery!.task).toContain("Pull the worklist.");
    expect(delivery!.task).toContain("loop-1");
  });

  it("carries the loop's BOUND workdir and marks it required", () => {
    // Captain ruling 2026-08-04: a loop binds a directory. The claiming machine
    // must run there and must not invent it — `requireWorkdir` is what stops the
    // runner mkdir-ing an empty lookalike of the repo the charter names.
    const delivery = deliveryFromRunsV2(
      {
        run: { id: "run-2", loopId: "loop-2", loopTitle: "Housekeeper (local)", scope: "routine" },
        charter: "Sweep the repo.",
        execution: { workdir: "/Users/me/Workspace/repo", requireWorkdir: true },
      },
      "dk_device",
    );
    expect(delivery!.loop.workdir).toBe("/Users/me/Workspace/repo");
    expect(delivery!.requireWorkdir).toBe(true);
  });

  it("requires the workdir from its presence alone, so an older server still binds", () => {
    const delivery = deliveryFromRunsV2(
      { run: { id: "run-3", loopId: "loop-3", scope: "routine" }, execution: { workdir: "/Users/me/Workspace/repo" } },
      "dk_device",
    );
    expect(delivery!.requireWorkdir).toBe(true);
  });

  it("leaves an unbound loop free to use the daemon's own scratch dir", () => {
    const delivery = deliveryFromRunsV2({ run: { id: "run-4", loopId: "loop-4", scope: "routine" } }, "dk_device");
    expect(delivery!.loop.workdir).toBeNull();
    expect(delivery!.requireWorkdir).toBe(false);
  });
});
