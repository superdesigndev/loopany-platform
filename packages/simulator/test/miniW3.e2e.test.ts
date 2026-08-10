/**
 * MINI-W3 on the REPLAY tier - a deterministic e2e of the full engine wiring:
 * plant repo, setup body-file, daily cron radar fires + replay agent, mirror
 * events with {{sandbox}} substitution, and the conditional recovery event that
 * must NOT fire on replay (no fix PR lands). The real haiku run is manual - never
 * in tests (cost).
 */

import { loadSnapshot } from "@loopany/cli";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotDirFor } from "../src/index.js";
import { runCli, type RunnerDeps } from "../src/run.js";
import type { SimResult } from "../src/types.js";
import { RELEASE_RADAR_ID } from "../scenarios/mini-w3.js";

// The 7-day scenario spawns many CLI/git subprocesses; run it ONCE and share the
// result across assertions. The default 5s vitest timeout is too short for the
// single run, so beforeAll gets a generous one.
describe("mini-w3 e2e (replay tier)", () => {
  let dir: string;
  let res: SimResult;
  let sandboxRoot: string;
  const runId = "test-mini-w3";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sim-mini-w3-"));
    const deps: RunnerDeps = {
      // No identity work on the replay tier; these must never be reached.
      seedIdentity: () => {
        throw new Error("seedIdentity must not run on the replay tier");
      },
      smoke: () => {
        throw new Error("smoke must not run on the replay tier");
      },
      log: () => {},
    };
    res = runCli({ scenario: "mini-w3", tier: "replay", runId, dir }, deps);
    sandboxRoot = join(res.workspace, "..");
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  it("runs 7 days with no refusals", () => {
    expect(res.days).toHaveLength(7);
    for (const c of res.setup) expect(c.exitCode, c.label).toBe(0);
    for (const day of res.days)
      for (const c of day.commands) expect(c.exitCode, `${day.date} ${c.label}`).toBe(0);
  });

  it("arms the radar loop with its Spec body (from --body-file)", () => {
    const snapshot = loadSnapshot(join(res.workspace, ".loopany"));
    const radar = snapshot.objects[RELEASE_RADAR_ID];
    expect(radar?.archetype).toBe("task");
    expect(radar?.archetype === "task" && radar.body).toContain("You are the release radar");
  });

  it("plants the stand-in repo with a bare origin", () => {
    expect(existsSync(join(sandboxRoot, "repos", "superdesign-web", "public", "install-wrapper.js"))).toBe(true);
    expect(existsSync(join(sandboxRoot, "remotes", "superdesign-web.git"))).toBe(true);
  });

  it("substitutes {{sandbox}} in the release entry with the real repo path", () => {
    // Day 3 (Wed) snapshot has the release entry with the substituted path.
    const releases = readFileSync(join(snapshotDirFor(runId, 3), "mirrors", "releases.md"), "utf8");
    expect(releases).toContain(join(sandboxRoot, "repos", "superdesign-web"));
    expect(releases).not.toContain("{{sandbox}}");
  });

  it("the conditional recovery event does NOT fire without a fix PR (replay)", () => {
    // Day 7 (Sun) posthog-weekly must still show the regression, not recovery,
    // because the replay radar lands no fix PR - the world stayed degraded.
    const posthog = readFileSync(
      join(snapshotDirFor(runId, 7), "mirrors", "posthog-weekly.md"),
      "utf8",
    );
    expect(posthog).not.toContain("Regression resolved");
  });
});
