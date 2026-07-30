/**
 * `pnpm graph:pr <owner/repo> <number> [--merge-intent] [--machine <name>]`
 *
 * Put a REAL pull request into the demo workspace, with a merge review waiting on
 * a human verdict - which is the shape the whole effect-delivery path starts from.
 *
 * What it does, all of it through sanctioned paths:
 *
 *   1. get-or-create the PR MIRROR (`graphStore.getOrCreateMirror`, the upsert on
 *      a deterministic id - so running this twice converges on one row);
 *   2. create the `merge-review` shepherd that TRACKS it, and run `submit`
 *      through `applyTransition` with `entrance: "agent-run"` - the run that
 *      opened the PR is who hands it to review;
 *   3. drain the outbox, so `submit`'s own consequences are settled and the
 *      terminal `approve` is not blocked by them.
 *
 * WHAT IT DOES NOT DO: read the pull request. This process holds no GitHub
 * transport, because no part of the server does (captain decision 10) - the mirror
 * lands at status `observed` ("we know it exists, we have not read its state") and
 * the MACHINE AGENT's next sweep is what observes it, because the watch list is
 * derived from the table this just wrote to. Run `pnpm agent --once` after this and
 * the facts arrive.
 *
 * `--merge-intent` sets the shepherd's `mergeIntent` field, which is what the
 * `external-merge` action's `requires` clause reads. WITHOUT it, approving
 * comments on the PR and stops - which is the default posture on purpose.
 *
 * Runs in its OWN process and exits, like `graph:seed`: the embedded pglite tier
 * is single-writer, so the dev server must not be holding the data dir.
 */
import { runMigrations } from "../../db/index.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition } from "../applyTransition.js";
import { drainOutbox } from "../outbox/executor.js";
import { PR_SOURCE, PR_TYPE, mirrorTitle, prExternalId, prUrl, parsePrExternalId } from "../sensing/pr.js";
import { DEMO_TEAM_ID } from "./specs.js";

function usage(): never {
  process.stderr.write(
    [
      "usage: pnpm graph:pr -- <owner/repo> <number> [--merge-intent] [--machine <name>]",
      "",
      "  registers a REAL pull request as a mirror and opens a merge review that is",
      "  waiting on your verdict. The machine agent observes it (`pnpm agent --once`).",
      "",
      "  --merge-intent   approving will also MERGE it (guarded again at the agent)",
      "  --machine <name> bind the resulting work orders to one effect agent",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const machineIdx = argv.indexOf("--machine");
  const machine = machineIdx >= 0 ? argv[machineIdx + 1] : undefined;
  const rest = positional.filter((a) => a !== machine);

  const repo = rest[0];
  const number = Number(rest[1]);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number <= 0) usage();

  const mergeIntent = flags.has("--merge-intent");
  const now = new Date().toISOString();
  const externalId = prExternalId({ repo, number });
  const identity = parsePrExternalId(externalId)!;

  await runMigrations();

  const { object: mirror, created } = await graph.getOrCreateMirror(undefined, {
    teamId: DEMO_TEAM_ID,
    externalSource: PR_SOURCE,
    externalId,
    type: PR_TYPE,
    // `observed` is the honest starting state: we know it exists, we have not read
    // its facts yet. The machine agent's next sweep is what reads them.
    status: "observed",
    title: mirrorTitle({ ...identity, title: `#${number}`, state: "open", merged: false, checks: "none", draft: false }),
    payload: { repo, number, sourceUrl: prUrl(identity), registeredBy: "graph:pr" },
    now,
  });
  process.stdout.write(`${created ? "created" : "found"} mirror ${mirror.id} for ${externalId}\n`);

  // NOT observed here. This process holds no GitHub transport (see the header):
  // the mirror is now on the watch list, and the machine agent's next sweep is what
  // reads its real facts.
  const fresh = (await graph.getObject(undefined, mirror.id))!;
  process.stdout.write(`mirror status: ${fresh.status}\n`);

  // The shepherd. A NEW one per review by design (obligations are keyed
  // `(objectId, key)`, so a long-lived task could not open a fresh verdict twice).
  const review = await graph.createObject(undefined, {
    teamId: DEMO_TEAM_ID,
    archetype: "task",
    type: "merge-review",
    status: "queued",
    title: fresh.title ?? `PR #${number}`,
    payload: { repo, number, ...(mergeIntent ? { mergeIntent: true } : {}), ...(machine ? { machine } : {}) },
    now,
  });
  await graph.upsertEdge(undefined, {
    teamId: DEMO_TEAM_ID,
    kind: "tracks",
    srcId: review.id,
    dstId: mirror.id,
    now,
  });

  const submitted = await applyTransition({
    objectId: review.id,
    transition: "submit",
    actor: { entrance: "agent-run", actorId: "run-graph-pr-cli" },
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
      `merge review ${review.id} is ${submitted.object.status}`,
      `  tracks          ${externalId}`,
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
