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
});
