import { describe, expect, it } from "vitest";

import { buildClaimBody, deliveryFromRunsV2, runsV2Enabled } from "./daemon.js";

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

/**
 * Review F1: the claim ATTESTS to what this daemon is still executing, and that
 * attestation is the only thing that renews a lease. A daemon that crashed
 * mid-run restarts with an empty set, so the run it lost stops being renewed and
 * the server can reclaim it — instead of our own polls keeping the orphan alive.
 */
describe("the v2 claim body attests to what is actually running", () => {
  const info = { host: "laptop", platform: "darwin", arch: "arm64", version: "0.13.0" };

  it("names every in-flight run and does not long-poll while busy", () => {
    const body = buildClaimBody(info, "daemon-test", new Set(["run-a", "run-b"]));
    expect(body).toMatchObject({ ...info, agent: "daemon-test", wait: false });
    expect(body.inFlight).toEqual(["run-a", "run-b"]);
  });

  it("sends an EMPTY attestation rather than omitting it — a restarted daemon runs nothing", () => {
    // Absent and empty must not be confusable: the server renews only what it is
    // told about, so "I am running nothing" has to be sayable.
    const body = buildClaimBody(info, "daemon-test", new Set());
    expect(body.inFlight).toEqual([]);
    expect("inFlight" in body).toBe(true);
    expect(body.wait).toBe(true);
  });

  it("snapshots the live set, so a run finishing mid-poll cannot mutate the body", () => {
    const inFlight = new Set(["run-a"]);
    const body = buildClaimBody(info, "daemon-test", inFlight);
    inFlight.delete("run-a");
    expect(body.inFlight).toEqual(["run-a"]);
  });
});

/**
 * A run woken by a PERSON must be told what they said, in their own words.
 *
 * The server reads the note back through `runs.trigger_event_id` and ships it as
 * `directive` (or `answer`); this is the daemon half — that it reaches the
 * agent's prompt VERBATIM, and labelled, so a run can never mistake an
 * unasked-for instruction for a reply to a question it never asked.
 */
describe("a human's own words reach the prompt verbatim", () => {
  const TOLD = "Drop this bet — close the PR, delete the branch, then close the task.";

  it("carries a directive verbatim, with the reality-first ordering beside it", () => {
    const delivery = deliveryFromRunsV2(
      {
        run: { id: "run-1", loopId: "loop-1", loopTitle: "Housekeeper", scope: "task:task-7f3a91" },
        charter: "Sweep the repo.",
        scopeNote: "A human left you a DIRECTIVE on task-7f3a91.",
        directive: TOLD,
      },
      "dk_device",
    );
    expect(delivery!.task).toContain(TOLD);
    expect(delivery!.task).toContain("DIRECTIVE, verbatim");
    expect(delivery!.task).toContain("Execute the INTENT against reality first");
  });

  it("labels an ANSWER differently, so the two conversations never blur", () => {
    const delivery = deliveryFromRunsV2(
      { run: { id: "run-2", loopId: "loop-1", scope: "task:task-7f3a91" }, answer: "Wait one more day." },
      "dk_device",
    );
    expect(delivery!.task).toContain("A human answered, verbatim:");
    expect(delivery!.task).toContain("Wait one more day.");
    expect(delivery!.task).not.toContain("DIRECTIVE");
  });

  it("says nothing at all when nobody spoke — a clock fire has no human in it", () => {
    const delivery = deliveryFromRunsV2({ run: { id: "run-3", loopId: "loop-1", scope: "routine" }, charter: "Sweep." }, "dk_device");
    expect(delivery!.task).not.toMatch(/verbatim/);
  });
});
