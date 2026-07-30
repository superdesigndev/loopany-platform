/**
 * `pnpm graph:pr <owner/repo> <number> [--no-merge-intent] [--machine <name>]`
 *
 * Put a REAL pull request into the demo workspace with a merge review waiting on
 * a human verdict - the shape the whole effect-delivery path starts from.
 *
 * ── THROUGH THE VERBS, and nothing else (captain decision 16) ───────────────
 *
 * This used to be a hand-written sequence: get-or-create the mirror, create a
 * `merge-review` shepherd, wire two edges, run `submit`. Every one of those steps
 * now exists as a VERB (`mirror track`, `review request`), and decision 16 is
 * explicit that a bespoke parallel path duplicating a verb's semantics gets
 * collapsed into the verb. So this file is argv parsing plus two calls - which
 * also means an operator staging a PR and an agent run tracking one produce
 * byte-identical rows.
 *
 * WHAT IT DOES NOT DO: read the pull request. This process holds no GitHub
 * transport, because no part of the server does (captain decision 10) - the
 * mirror lands at status `observed` ("we know it exists, we have not read its
 * state") and the MACHINE AGENT's next sweep is what observes it. Run
 * `pnpm agent --once` after this and the facts arrive.
 *
 * Merge intent is ON by default here, because "stage a PR for a merge verdict" is
 * what this command is for; `--no-merge-intent` gets the comment-only posture.
 * Either way the agent guards it again against its own allowlist.
 *
 * Runs in its OWN process and exits, like `graph:seed`: the embedded pglite tier
 * is single-writer, so the dev server must not be holding the data dir.
 */
import { runMigrations } from "../../db/index.js";
import { mirrorTrack, reviewRequest, type VerbContext } from "../cli/verbs.js";
import { drainOutbox } from "../outbox/executor.js";
import { prUrl } from "../sensing/pr.js";
import { DEMO_TEAM_ID } from "./specs.js";

function usage(): never {
  process.stderr.write(
    [
      "usage: pnpm graph:pr -- <owner/repo> <number> [--no-merge-intent] [--machine <name>]",
      "",
      "  registers a REAL pull request as a mirror and opens a merge review that is",
      "  waiting on your verdict. The machine agent observes it (`pnpm agent --once`).",
      "",
      "  --no-merge-intent  approving will only COMMENT, not merge",
      "  --machine <name>   bind the resulting work orders to one effect agent",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const machineIdx = argv.indexOf("--machine");
  const machine = machineIdx >= 0 ? argv[machineIdx + 1] : undefined;
  const rest = argv.filter((a) => !a.startsWith("--") && a !== machine);

  const repo = rest[0];
  const number = Number(rest[1]);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) usage();

  const mergeIntent = !flags.has("--no-merge-intent");
  const now = new Date().toISOString();
  await runMigrations();

  // An OPERATOR is a person acting in their own workspace, so the provenance is
  // `human` - the same entrance the UI's own verb calls carry.
  const ctx: VerbContext = {
    teamId: DEMO_TEAM_ID,
    actor: { entrance: "human", actorId: "operator-graph-pr" },
    now,
  };

  const tracked = await mirrorTrack(ctx, { ref: prUrl({ repo, number }) });
  if (!tracked.ok) {
    process.stderr.write(`mirror track refused: ${tracked.code} - ${tracked.message}\n`);
    process.exit(1);
  }
  const mirrorId = String(tracked.data.objectId);
  process.stdout.write(`${tracked.summary}\n`);

  const review = await reviewRequest(ctx, {
    aboutId: mirrorId,
    preset: "merge",
    question: `Merge ${repo}#${number}?`,
    fields: {
      repo,
      number,
      // The `external-merge` action's `requires` clause reads this. Without it,
      // approving comments and stops there.
      mergeIntent,
      ...(machine ? { machine } : {}),
    },
  });
  if (!review.ok) {
    process.stderr.write(`review request refused: ${review.code} - ${review.message}\n`);
    process.exit(1);
  }
  const drained = await drainOutbox({ now, teamId: DEMO_TEAM_ID, maxPasses: 8 });

  process.stdout.write(
    [
      "",
      `merge review ${review.data.objectId} is ${review.data.status}`,
      `  tracks          ${tracked.data.externalId}`,
      `  merge intent    ${mergeIntent ? "YES - approving will merge it" : "no - approving will comment only"}`,
      machine ? `  bound machine   ${machine}` : "  bound machine   (any effect agent)",
      `  outbox          ${drained.done} action(s) settled, ${drained.deadLettered} dead-lettered`,
      "",
      "Run `pnpm agent --once` to sense the PR's real facts, then open /dev/workspace",
      "and approve it. The verdict queues an outward work order the same agent executes.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph:pr failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
