/**
 * `pnpm graph:dispatch [--brief "<what to do>"] [--workdir <dir>] [--repos a/b] [--machine <name>]`
 *
 * Put an APPROVABLE PIECE OF WORK into the demo workspace - the shape the whole
 * runs bridge starts from, exactly as `graph:pr` is the shape effect delivery
 * starts from.
 *
 * ── THROUGH THE VERB (captain decision 16) ──────────────────────────────────
 *
 * One call to `review request` with the `dispatch` preset, and that is the whole
 * command. It used to create an `agent-task` by hand and run `submit` on it;
 * since the collapse there is no `agent-task` type - "work an agent does once a
 * person says go" is a standard review Task whose verdict DISPATCHES rather than
 * approves, which is instance data (`preset: "dispatch"`), not a fifth state
 * machine.
 *
 * Then a person approves it in the workspace. THAT is the R3 approval: the
 * verdict writes a `run-task` work order, the machine agent claims it, re-checks
 * the approval, checks the scope against its own boundary, executes the
 * instruction, and reports the run's lifecycle back - which advances this task
 * and lands its report in the Timeline.
 *
 * ── the default brief is deliberately harmless ──────────────────────────────
 *
 * With no `--brief` this stages a bounded, read-only piece of work: describe the
 * working directory. That is the honest default for a demo command - it exercises
 * every hop of the bridge (approve → claim → execute → report → advance) while
 * touching nothing, and anybody wanting real work says so explicitly.
 *
 * `--role` and `--workflow` are the agentic half (captain decision 15): the role
 * decides which one to three `graph` verbs the run is handed, and the workflow is
 * the prose telling it what to do with them. Both are INSTANCE FIELDS, which is
 * the whole point - a workflow lives in the object, never in TypeScript.
 *
 * Runs in its OWN process and exits, like `graph:seed` and `graph:pr`: the
 * embedded pglite tier is single-writer, so the dev server must not be holding
 * the data dir.
 */
import { runMigrations } from "../../db/index.js";
import { reviewRequest, type VerbContext } from "../cli/verbs.js";
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
      'usage: pnpm graph:dispatch -- [--brief "<what to do>"] [--workdir <dir>] [--repos a/b,c/d]',
      '                            [--role discovery|fix|watch] [--workflow "<how this run works>"] [--machine <name>]',
      "",
      "  stages a review whose verdict DISPATCHES a run. Approving it in the workspace",
      "  sends the instruction to the machine agent, which executes it locally.",
      "",
      "  --brief     what the agent should do (default: a read-only survey of the workdir)",
      "  --workdir   where it may work, relative to the agent's own run root",
      "  --repos     repositories it may act on (the agent narrows this again)",
      "  --role      which `graph` verbs the run is handed (decision 15a)",
      "  --workflow  the standing workflow prose composed into its work order",
      "  --machine   bind the resulting work order to one machine agent",
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
  const role = flagValue(argv, "role");
  const workflow = flagValue(argv, "workflow");
  const machine = flagValue(argv, "machine");
  const now = new Date().toISOString();

  await runMigrations();

  const ctx: VerbContext = {
    teamId: DEMO_TEAM_ID,
    actor: { entrance: "human", actorId: "operator-graph-dispatch" },
    now,
  };
  const staged = await reviewRequest(ctx, {
    preset: "dispatch",
    question: brief.split("\n")[0]!.slice(0, 160),
    title: brief.split("\n")[0]!.slice(0, 120),
    fields: {
      // The instance's own fields. `brief` is what the standing intent points at
      // (`context.object.brief`); `workdir`/`repos` FILL the scope the static
      // declaration left open - they can never widen what it pinned.
      brief,
      ...(workdir ? { workdir } : {}),
      ...(repos ? { repos } : {}),
      ...(role ? { role } : {}),
      ...(workflow ? { workflow } : {}),
      ...(machine ? { machine } : {}),
    },
  });
  if (!staged.ok) {
    process.stderr.write(`review request refused: ${staged.code} - ${staged.message}\n`);
    process.exit(1);
  }
  const drained = await drainOutbox({ now, teamId: DEMO_TEAM_ID, maxPasses: 8 });

  process.stdout.write(
    [
      "",
      `dispatch review ${staged.data.objectId} is ${staged.data.status}`,
      `  brief           ${brief.split("\n")[0]}`,
      `  workdir         ${workdir ?? "(the agent's own run root)"}`,
      `  repos           ${repos ?? "(none - the instruction claims no repo scope)"}`,
      `  role            ${role ?? "(none - the run gets no graph verbs)"}`,
      `  workflow        ${workflow ? `${workflow.split("\n")[0]!.slice(0, 60)}…` : "(none)"}`,
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
