/**
 * SMOKE-SEO - the first scenario, a 3-day smoke derived from the golden SEO
 * two-loop handoff (packages/kernel/test/golden.test.ts). It is deliberately
 * minimal: the point is that EVERY engine mechanism fires at least once -
 * setup, a morning mirror event, a `tick --spawn` that dispatches a run, the
 * replay agent running CLI commands under the virtual clock, an evening
 * human-note, and per-day snapshots.
 *
 * Shape:
 *   - a `seo-bet-manager` loop (weekly Monday cron) assigned to `replay`, with
 *     NO script entry -> its Monday fire spawns the replay agent, which cleanly
 *     no-ops (the "nothing to do" path).
 *   - a `content-ai-design-agent` task assigned to `replay`, armed with a
 *     follow-up at day-1 06:00 so the day-1 07:00 tick flips it todo + dispatches
 *     a run. The replay agent then notes a progress line and marks it done.
 *   - day 2: a mirror update (search-console) + tim's evening reply on the task.
 *
 * The replay SCRIPT (keyed by task id) rides on the scenario's `replayScript`
 * field; the engine MATERIALIZES it into the sandbox and wires
 * `LOOPANY_REPLAY_SCRIPT` itself, so a caller never hand-writes the file.
 */

import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../src/types.js";

/** The content task's deterministic id (pinned via --id so the replay script and
 *  the assertions key on it without deriving a slug). */
export const CONTENT_TASK_ID = "content-ai-design-agent";
/** The bet-manager loop's deterministic id. */
export const BET_MANAGER_ID = "seo-bet-manager";

/** Absolute path to the replay-agent shim (resolved relative to this package). */
export function replayAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "shims", "replay-agent.mjs");
}

/** The replay script: for each task, the argv sequence its run replays. The
 *  content task's run notes a progress line then marks itself done; the
 *  bet-manager has NO entry (a clean no-op fire). Provenance rides via env
 *  (LOOPANY_SESSION_ID / _ACTOR set by the spawn), so no --actor here. */
export const REPLAY_SCRIPT: Record<string, string[][]> = {
  [CONTENT_TASK_ID]: [
    ["note", CONTENT_TASK_ID, "wrote the explainer; targeting keyword \"ai design agent\""],
    ["update", CONTENT_TASK_ID, "status=done", "--note", "published to content/"],
  ],
};

/** Build the smoke scenario. `replayAgent` is the shim path the profiles point
 *  at (defaults to the packaged shim). */
export function smokeSeoScenario(replayAgent: string = replayAgentPath()): Scenario {
  return {
    name: "smoke-seo",
    profiles: {
      // The `replay` assignee runs every dispatched run through the replay shim.
      // The prompt arrives on stdin (no {{prompt}} token), which the shim drains.
      replay: { cmd: process.execPath, args: [replayAgent] },
    },
    replayScript: REPLAY_SCRIPT,
    setup: {
      tasks: [
        // L2 the bet-manager loop (weekly Monday 07:00 cron), assigned to replay.
        [
          "create",
          "seo bet manager",
          "--id",
          BET_MANAGER_ID,
          "--cron",
          "0 7 * * 1",
          "--timezone",
          "UTC",
          "--status",
          "in-progress",
          "--assignee",
          "replay",
        ],
        // The content task: armed with a follow-up before day-1's 07:00 tick, so
        // the tick flips it todo and dispatches a run to `replay`.
        [
          "create",
          "content: ai design agent explainer",
          "--id",
          CONTENT_TASK_ID,
          "--assignee",
          "replay",
          "--follow-up",
          "2026-08-10T06:00:00.000Z",
        ],
      ],
    },
    days: [
      {
        date: "2026-08-10", // Monday W1
        morning: [
          {
            kind: "mirror-write",
            path: "mirrors/search-console.md",
            content: "# search console\n\nai design agent | pos 28 | imp 1200\n",
          },
        ],
        evening: [],
      },
      {
        date: "2026-08-11",
        morning: [
          {
            kind: "mirror-write",
            path: "mirrors/search-console.md",
            append: "ai design agent | pos 24 | imp 1800\n",
          },
        ],
        evening: [
          {
            kind: "human-note",
            task: CONTENT_TASK_ID,
            actor: "tim",
            text: "nice - looks good, ship it",
          },
        ],
      },
      {
        date: "2026-08-12",
        morning: [],
        evening: [],
      },
    ],
  };
}
