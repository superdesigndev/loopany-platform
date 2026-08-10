/**
 * CONDITIONAL world events (§3.4): a `when` that returns false DEFERS the event
 * to the next day (re-checked, never dropped); once it returns true the event
 * fires. Driven through the real engine on the replay tier.
 *
 * The gate here is a closure that returns false on its first check and true on
 * the re-check - the deterministic stand-in for "a fix PR landed". (probe-driven
 * `when` is covered by the mini-w3 arc; this pins defer/fire + carry-forward.)
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario, snapshotDirFor } from "../src/index.js";
import type { Scenario } from "../src/types.js";
import { replayAgentPath } from "../scenarios/smoke-seo.js";

describe("conditional world event defer/fire", () => {
  let root: string;
  const runId = "test-conditional";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-cond-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  it("defers while `when` is false, fires (once) when it turns true, and carries forward", () => {
    // false on the first check (day 1 -> deferred), true on the re-check
    // (day 2 -> fires). A third day would not re-run it (already fired).
    let checks = 0;
    const scenario: Scenario = {
      name: "cond",
      profiles: { replay: { cmd: process.execPath, args: [replayAgentPath()] } },
      setup: { tasks: [] },
      days: [
        {
          date: "2026-08-24",
          morning: [
            {
              kind: "mirror-write",
              path: "mirrors/gate.md",
              content: "OPENED\n",
              when: () => {
                checks++;
                return checks >= 2;
              },
            },
          ],
          evening: [],
        },
        { date: "2026-08-25", morning: [], evening: [] },
        { date: "2026-08-26", morning: [], evening: [] },
      ],
    };

    runScenario(scenario, { runId, dir: root });

    // Day 1: deferred -> the gate file is absent from the day-1 snapshot.
    expect(existsSync(join(snapshotDirFor(runId, 1), "mirrors", "gate.md"))).toBe(false);
    // Day 2: the deferred event re-checked true and fired -> file present.
    expect(existsSync(join(snapshotDirFor(runId, 2), "mirrors", "gate.md"))).toBe(true);
    // Exactly two checks: day-1 false, day-2 true. Day 3 never re-checks it.
    expect(checks).toBe(2);
  });
});
