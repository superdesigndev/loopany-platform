/**
 * `pnpm graph:agentic [--repo owner/name] [--workdir <dir>] [--every 2m]`
 *
 * Stand up the AGENTIC-CLI demo workspace: two live loops whose runs drive the
 * seven verbs, and nothing else.
 *
 * ── what it creates, and why exactly this ───────────────────────────────────
 *
 *   a DISCOVERY loop  armed on a cadence, so the clock fires it with nobody
 *                     watching. Its runs get {task create, artifact push,
 *                     review request} and its WORKFLOW - the prose telling them
 *                     what to do with those three - is a field on the object.
 *   a WATCH loop      armed on a cadence. Its runs get {wait answer, artifact
 *                     push} and their work orders carry the open waits that name
 *                     this loop as their watcher (captain decision 13).
 *
 * There is deliberately no third loop for the FIX run: fixing is work a person
 * approved, so it is a `dispatch`-preset review the discovery run asks for, with
 * the fix run's own role, workflow and scope written onto it as instance fields.
 * That is the whole shape captain decisions 15 + 16 are after - the platform
 * declares no chain, and one run composes the next one's work order as DATA.
 *
 * ── every word of workflow here is DATA ─────────────────────────────────────
 *
 * The prose below lives on the loop objects, exactly as a user's would. It is in
 * this file only because a demo needs a starting fixture; nothing reads it from
 * here at runtime, and editing a loop's workflow in the workspace changes what
 * its next run does without touching a line of TypeScript. That is captain
 * decision 15(5), and this command exists partly to make it visible.
 *
 * Runs in its OWN process and exits, like `graph:seed`: the embedded pglite tier
 * is single-writer, so the dev server must not be holding the data dir.
 */
import { runMigrations } from "../../db/index.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition } from "../applyTransition.js";
import { armSchedule } from "../schedule/arm.js";
import { parseCadence } from "../schedule/cadence.js";
import { resetGraphDemo } from "./seed.js";
import { DEMO_TEAM_ID, DEMO_TYPES, DEMO_USER_ID } from "./specs.js";

/** The DISCOVERY loop's standing workflow. Prose, on the object, for its runs. */
const DISCOVERY_WORKFLOW = [
  "You are the sandbox's daily sweep. Your job is to find ONE real, small problem in the repository you were",
  "given, write it up, and ask a person whether to fix it. You do not fix anything yourself.",
  "",
  "Each run, in order:",
  "",
  "1. LOOK. Clone or update the repo inside your workdir (`gh repo clone <repo> repo` the first time, then",
  "   `git -C repo pull`). Read the code. Find one concrete, small, verifiable problem - a bug, a dead branch,",
  "   a missing guard. Prefer something a ten-line change would fix.",
  "2. CHECK REALITY. Before writing anything down, read `context.alreadyRecorded` - the tasks and reviews this",
  "   loop has ALREADY produced, newest first. If your problem is one of them, or is the same problem wearing",
  "   different words, STOP. Say which entry it matches and end the run. A clean stop is a real outcome; a",
  "   second task for a problem already tracked is worse than doing nothing, because somebody has to un-file it.",
  "3. RECORD IT. `graph task create --type task --title \"<the problem>\"` - one task, named for the problem.",
  "4. WRITE IT UP. Put a short markdown findings file in your workdir (what you found, where, why it matters,",
  "   what a fix would look like) and `graph artifact push <file> --for <the task id>`.",
  "5. ASK. `graph review request --about <the task id> --preset dispatch --question \"Fix this?\"` and pass the",
  "   FIX RUN's own work order as fields:",
  "     --field role=fix",
  "     --field brief=\"<what the fix run should do, in one paragraph>\"",
  "     --field workdir=<your workdir>",
  "     --field repos=<the repo>",
  "     --field workflow=\"<how the fix run should work: branch, one PR, track the mirror, ask for the merge>\"",
  "   The person approving that review is what dispatches the fix run, so those fields ARE its instructions.",
  "",
  "Then stop. Print a short report of what you found. End with exactly one FINDING line as instructed above.",
].join("\n");

/** The WATCH loop's standing workflow. */
const WATCH_WORKFLOW = [
  "You are the verification watch. Your job is to answer the open questions somebody has named you as the",
  "watcher for, and nothing else.",
  "",
  "Your work order's `context.waits` lists them: each has an `objectId`, a `key` and a `question`. For EACH one:",
  "",
  "1. LOOK for the answer the question actually asks for. Read the repository, run the check, count the thing.",
  "   Use your workdir; do not change anything.",
  "2. ANSWER IT, either way:",
  "     graph wait answer <objectId> <key> --met     --evidence \"<what you saw>\"",
  "     graph wait answer <objectId> <key> --not-met --evidence \"<what you saw>\"",
  "   `--met` closes it. `--not-met` is an ordinary answer, not a failure - it renews the wait and you will be",
  "   asked again next run. Answer `--met` only when the evidence genuinely supports it; a windowed judgment",
  "   (\"three quiet sweeps in a row\") is yours to make and yours to state in the evidence.",
  "3. If a wait you had already answered `--met` has come BACK, answer it `--not-met` with what you saw. That",
  "   reopens it and tells a person the fix stopped holding.",
  "",
  "If `context.waits` is empty there is nothing to do. Say so plainly and stop - that is a clean outcome.",
].join("\n");

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const v = argv[at + 1];
  return v && !v.startsWith("--") ? v.trim() : undefined;
}

async function liveLoop(input: {
  title: string;
  role: string;
  workflow: string;
  brief: string;
  workdir: string;
  repos: string;
  band: string;
  rank: number;
  cadence: string;
  now: string;
}): Promise<string> {
  const object = await graph.createObject(undefined, {
    teamId: DEMO_TEAM_ID,
    archetype: "task",
    type: "loop",
    status: "planned",
    title: input.title,
    payload: {
      band: input.band,
      cadence: `agentic · ${input.cadence}`,
      stat: `${input.role} run · drives the graph CLI`,
      rank: input.rank,
      // THE INSTANCE HALF of every work order this loop will ever dispatch.
      role: input.role,
      workflow: input.workflow,
      brief: input.brief,
      workdir: input.workdir,
      repos: input.repos,
    },
    now: input.now,
  });

  // Arming is a HUMAN act, and the event it writes is the standing approval every
  // R3 fire this loop ever makes will rest on.
  const activated = await applyTransition({
    objectId: object.id,
    transition: "activate",
    actor: { entrance: "human", actorId: DEMO_USER_ID },
    now: input.now,
  });
  if (!activated.ok) throw new Error(`activate refused: ${activated.code} - ${activated.message}`);

  const parsed = parseCadence({ interval: input.cadence });
  if (!parsed.ok) throw new Error(parsed.why);
  const armed = await armSchedule({ objectId: object.id, cadence: parsed.spec, userId: DEMO_USER_ID, now: input.now });
  if (!armed.ok) throw new Error(`arm refused: ${armed.code} - ${armed.message}`);
  return object.id;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repo = flag(argv, "repo") ?? "superdesigndev/loopany-e2e-sandbox";
  const workdir = flag(argv, "workdir") ?? "sandbox";
  const every = flag(argv, "every") ?? "5m";
  const now = new Date().toISOString();

  await runMigrations();
  await resetGraphDemo(DEMO_TEAM_ID);

  for (const t of DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId: DEMO_TEAM_ID,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      rationale: t.rationale,
      now,
    });
    await graph.armTypeVersion(undefined, { teamId: DEMO_TEAM_ID, name: t.name, version: 1, now });
  }
  await graph.seedBuiltinTypes(undefined, DEMO_TEAM_ID, now);

  const discovery = await liveLoop({
    title: "Sandbox Sweep",
    role: "discovery",
    workflow: DISCOVERY_WORKFLOW,
    brief: `Find one small, real problem in ${repo} and ask whether to fix it.`,
    workdir,
    repos: repo,
    band: "engineering",
    rank: 0,
    cadence: every,
    now,
  });

  const watch = await liveLoop({
    title: "Sandbox Verification Watch",
    role: "watch",
    workflow: WATCH_WORKFLOW,
    brief: "Answer the open verification questions you are the named watcher for.",
    workdir,
    repos: repo,
    band: "monitors",
    rank: 0,
    cadence: every,
    now,
  });

  process.stdout.write(
    [
      "",
      "the agentic-CLI demo workspace is up",
      `  discovery loop  ${discovery}  (role: discovery · every ${every})`,
      `  watch loop      ${watch}  (role: watch · every ${every})`,
      `  repo            ${repo}`,
      `  workdir         ${workdir} (inside the machine agent's run root)`,
      "",
      "Start the server and the machine agent, then let the clock fire. Approve what",
      "the runs ask for in /dev/workspace - that is the only place a person acts.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph:agentic failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
