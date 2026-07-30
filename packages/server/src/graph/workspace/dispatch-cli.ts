/**
 * `pnpm graph:dispatch [--brief "<what to do>"] [--workdir <dir>] [--repos a/b] [--machine <name>]`
 *
 * Put an APPROVABLE PIECE OF WORK into the demo workspace - the shape the whole
 * runs bridge starts from, exactly as `graph:pr` is the shape effect delivery starts
 * from.
 *
 * What it does, all of it through sanctioned paths:
 *
 *   1. create an `agent-task` - the generic "an agent does X from an instruction"
 *      type (captain decision 12), carrying THIS instance's brief and scope in its
 *      own fields;
 *   2. run `submit` through `applyTransition` with `entrance: "agent-run"`, which
 *      opens the human-verdict gate;
 *   3. drain the outbox, so `submit`'s own consequences are settled and the
 *      terminal outcome transitions are not blocked by them.
 *
 * Then a person approves it in the workspace. THAT is the R3 approval: the verdict
 * writes a `run-task` work order, the machine agent claims it, re-checks the
 * approval, checks the scope against its own boundary, executes the instruction,
 * and reports the run's lifecycle back - which advances this task and lands its
 * report in the Timeline.
 *
 * ── the default brief is deliberately harmless ──────────────────────────────
 *
 * With no `--brief` this stages a bounded, read-only piece of work: describe the
 * working directory. That is the honest default for a demo command - it exercises
 * every hop of the bridge (approve → claim → execute → report → advance) while
 * touching nothing, and anybody wanting real work says so explicitly.
 *
 * Runs in its OWN process and exits, like `graph:seed` and `graph:pr`: the embedded
 * pglite tier is single-writer, so the dev server must not be holding the data dir.
 */
import { runMigrations } from "../../db/index.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition } from "../applyTransition.js";
import { drainOutbox } from "../outbox/executor.js";
import { DEMO_TEAM_ID } from "./specs.js";

const DEFAULT_BRIEF = [
  "Take stock of the working directory you were given and report what is in it.",
  "",
  "Read-only: list the files, read anything small enough to be worth reading, and summarise what this",
  "directory appears to be for. Change nothing.",
].join("\n");

function usage(): never {
  process.stderr.write(
    [
      'usage: pnpm graph:dispatch -- [--brief "<what to do>"] [--workdir <dir>] [--repos a/b,c/d] [--machine <name>]',
      "",
      "  stages an `agent-task` waiting on your verdict. Approving it in the workspace",
      "  dispatches the instruction to the machine agent, which executes it locally.",
      "",
      "  --brief    what the agent should do (default: a read-only survey of the workdir)",
      "  --workdir  where it may work, relative to the agent's own run root",
      "  --repos    repositories it may act on (the agent narrows this again)",
      "  --machine  bind the resulting work order to one machine agent",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) usage();
  return value.trim() || undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) usage();

  const brief = flagValue(argv, "brief") ?? DEFAULT_BRIEF;
  const workdir = flagValue(argv, "workdir");
  const repos = flagValue(argv, "repos");
  const machine = flagValue(argv, "machine");
  const now = new Date().toISOString();

  await runMigrations();

  const task = await graph.createObject(undefined, {
    teamId: DEMO_TEAM_ID,
    archetype: "task",
    type: "agent-task",
    status: "queued",
    title: brief.split("\n")[0]!.slice(0, 120),
    // The instance's own fields. `brief` is what the standing intent points at
    // (`context.object.brief`); `workdir`/`repos` FILL the scope the static
    // declaration left open - they can never widen what it pinned.
    payload: {
      brief,
      ...(workdir ? { workdir } : {}),
      ...(repos ? { repos } : {}),
      ...(machine ? { machine } : {}),
    },
    now,
  });

  const submitted = await applyTransition({
    objectId: task.id,
    transition: "submit",
    actor: { entrance: "agent-run", actorId: "run-graph-dispatch-cli" },
    now,
  });
  if (!submitted.ok) {
    process.stderr.write(`submit refused: ${submitted.code} - ${submitted.message}\n`);
    process.exit(1);
  }
  const drained = await drainOutbox({ now, teamId: DEMO_TEAM_ID, maxPasses: 8 });

  process.stdout.write(
    [
      "",
      `agent task ${task.id} is ${submitted.object.status}`,
      `  brief           ${brief.split("\n")[0]}`,
      `  workdir         ${workdir ?? "(the agent's own run root)"}`,
      `  repos           ${repos ?? "(none - the instruction claims no repo scope)"}`,
      machine ? `  bound machine   ${machine}` : "  bound machine   (any machine agent)",
      `  outbox          ${drained.done} action(s) settled, ${drained.deadLettered} dead-lettered`,
      "",
      "Open /dev/workspace and approve it. The verdict writes a run work order; the",
      "machine agent (`pnpm agent`) executes it and reports the run back.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph:dispatch failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
