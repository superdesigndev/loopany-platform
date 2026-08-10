/**
 * ENGINE end-to-end - the smoke-seo scenario driven through the REAL CLI bin on
 * the virtual clock, into a temp dir. Proves every P0 mechanism at once:
 * setup, a morning mirror event, a `tick --spawn` that dispatches a run, the
 * replay agent running CLI commands under LOOPANY_NOW, an evening human-note,
 * and per-day snapshots - PLUS the load-bearing invariant that the sandbox is
 * NOT registered in the daemon registry.
 */

import { loadEvents, loadSnapshot, readRegistry } from "@loopany/cli";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario, snapshotDirFor } from "../src/index.js";
import { CONTENT_TASK_ID, smokeSeoScenario } from "../scenarios/smoke-seo.js";

/** The three scripted virtual instants every event MUST fall on. */
const VIRTUAL_INSTANTS = new Set([
  "2026-08-10T00:00:00.000Z", // setup
  "2026-08-10T07:00:00.000Z",
  "2026-08-10T19:00:00.000Z",
  "2026-08-11T07:00:00.000Z",
  "2026-08-11T19:00:00.000Z",
  "2026-08-12T07:00:00.000Z",
  "2026-08-12T19:00:00.000Z",
]);

describe("engine e2e: smoke-seo", () => {
  let root: string;
  let regHome: string;
  const runId = "test-smoke-seo";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-e2e-"));
    // The registry home the sandbox would write to IF it registered. We point
    // LOOPANY_HOME at it via extraEnv so any accidental registration lands here
    // (never the real ~/.loopany), and assert it stays empty.
    regHome = mkdtempSync(join(tmpdir(), "sim-e2e-reg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(regHome, { recursive: true, force: true });
    rmSync(snapshotDirFor(runId, 1), { recursive: true, force: true });
    // Clean the whole out/<runId> tree.
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  function run() {
    // The engine materializes scenario.replayScript into the sandbox and wires
    // LOOPANY_REPLAY_SCRIPT itself; we only redirect the registry home so a stray
    // registration never touches the real ~/.loopany.
    return runScenario(smokeSeoScenario(), {
      runId,
      dir: root,
      extraEnv: { LOOPANY_HOME: join(regHome, ".loopany") },
    });
  }

  it("the content task ends done with the replay agent's note on its stream", () => {
    const res = run();
    // Every setup + tick command exited 0.
    for (const c of res.setup) expect(c.exitCode, `setup ${c.argv.join(" ")}`).toBe(0);
    for (const day of res.days) {
      for (const c of day.commands) expect(c.exitCode, `${day.date} ${c.argv.join(" ")}`).toBe(0);
    }

    const snapshot = loadSnapshot(join(res.workspace, ".loopany"));
    const task = snapshot.objects[CONTENT_TASK_ID];
    expect(task?.archetype).toBe("task");
    expect(task?.archetype === "task" && task.status).toBe("done");

    // The replay agent's progress note is on the task's event stream, attributed
    // to the run's session (not a human).
    const events = loadEvents(join(res.workspace, ".loopany"), CONTENT_TASK_ID);
    const agentNote = events.find(
      (e) => e.kind === "note" && e.note?.includes("wrote the explainer"),
    );
    expect(agentNote, "replay agent progress note").toBeTruthy();
    expect(agentNote?.provenance.entrance).toBe("agent-run");
    expect(agentNote?.provenance.sessionId).toBeTruthy();
  });

  it("every event timestamp is a scripted virtual instant (clock propagation)", () => {
    const res = run();
    const wsDir = join(res.workspace, ".loopany");
    const snapshot = loadSnapshot(wsDir);
    let checked = 0;
    for (const id of Object.keys(snapshot.objects)) {
      for (const e of loadEvents(wsDir, id)) {
        expect(VIRTUAL_INSTANTS.has(e.at), `event ${e.id} at ${e.at}`).toBe(true);
        checked++;
      }
    }
    // The agent's IN-RUN callbacks (note/update) are the real proof: they only
    // land on a virtual instant if LOOPANY_NOW propagated into the spawned agent.
    expect(checked).toBeGreaterThan(5);
  });

  it("the human-note lands as HUMAN provenance with the named actor", () => {
    const res = run();
    const events = loadEvents(join(res.workspace, ".loopany"), CONTENT_TASK_ID);
    const reply = events.find((e) => e.kind === "note" && e.note?.includes("ship it"));
    expect(reply?.provenance.entrance).toBe("human");
    expect(reply?.provenance.actorId).toBe("tim");
  });

  it("a snapshot dir exists per day with the kernel state + mirrors", () => {
    const res = run();
    expect(res.days).toHaveLength(3);
    res.days.forEach((day, i) => {
      const dir = snapshotDirFor(runId, i + 1);
      expect(day.snapshotDir).toBe(dir);
      expect(existsSync(join(dir, ".loopany", "objects")), `day-${i + 1} objects`).toBe(true);
      expect(existsSync(join(dir, "mirrors")), `day-${i + 1} mirrors`).toBe(true);
    });
    // The mirror content captured on day 2 carries the appended second line.
    const day2Mirror = readFileSync(
      join(snapshotDirFor(runId, 2), "mirrors", "search-console.md"),
      "utf8",
    );
    expect(day2Mirror).toContain("pos 24 | imp 1800");
  });

  it("the sandbox is NOT registered in the daemon registry", () => {
    run();
    // The redirected registry home stays empty - `init --no-register` never wrote.
    expect(readRegistry({ home: regHome })).toEqual([]);
  });
});
