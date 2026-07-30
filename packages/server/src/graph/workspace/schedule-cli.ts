/**
 * `pnpm graph:schedule -- --every 2m [--loop <title|id>] [--brief "…"] [--workdir <dir>]`
 *
 * ARM a cadence in the demo workspace - the deliberate act that turns a configured
 * schedule into a live one, and the shape the whole clock shadow starts from
 * (exactly as `graph:pr` is the shape effect delivery starts from and
 * `graph:dispatch` is the shape the runs bridge starts from).
 *
 * Everything goes through sanctioned paths:
 *
 *   1. resolve (or create) the loop this cadence belongs to - a Task with a
 *      schedule, which is all a Loop is (design §4);
 *   2. `armSchedule`, which writes the HUMAN `schedule-armed` event, stamps its id
 *      on the object as the standing approval, and computes the first jittered
 *      cursor;
 *   3. print what will happen next. Nothing else: the scheduler in the running
 *      server is what fires it, and that is the point of the demo.
 *
 * ── why arming is a separate command and not part of the seed ────────────────
 *
 * The seeded workspace replays REAL PRODUCTION LOOPS, cadences included. Importing
 * a cadence must never be the same act as agreeing to run it here - so the seed
 * writes `cron` as configuration and leaves `next_fire` null, and this command is
 * how a person says "yes, fire this one, on this server". That separation is why
 * `pnpm graph:seed` cannot accidentally start dispatching thirty production loops
 * at a local machine agent.
 *
 * ── the default brief is deliberately harmless ──────────────────────────────
 *
 * With no `--brief` this arms a bounded, read-only piece of work: survey the working
 * directory and write a short report. That exercises every hop the clock shadow adds
 * (fire → directive → run → report → advance) while touching nothing.
 *
 * Runs in its OWN process and exits, like `graph:seed` and `graph:dispatch`: the
 * embedded pglite tier is single-writer, so the dev server must not be holding the
 * data dir. Arm first, then start the server.
 */
import { runMigrations } from "../../db/index.js";
import * as graph from "../../db/graphStore.js";
import { applyTransition } from "../applyTransition.js";
import { armSchedule, disarmSchedule } from "../schedule/arm.js";
import { describeCadence, parseCadence } from "../schedule/cadence.js";
import { DEMO_TEAM_ID, DEMO_USER_ID } from "./specs.js";

const DEFAULT_TITLE = "Scratch survey (scheduled)";

const DEFAULT_BRIEF = [
  "Survey the working directory you were given and write a short markdown report of what is in it.",
  "",
  "Read-only: list the files, read anything small enough to be worth reading, and say what this",
  "directory appears to be for. Change nothing outside the report you print.",
].join("\n");

function usage(): never {
  process.stderr.write(
    [
      'usage: pnpm graph:schedule -- (--every <2m|90s|1h> | --cron "<expr>") [options]',
      "",
      "  arms a cadence: writes the human `schedule-armed` approval, sets the first",
      "  cursor, and lets the server's scheduler fire it from then on.",
      "",
      "  --every      interval cadence (90s, 2m, 1h, 1d)",
      '  --cron       cron cadence ("*/5 * * * *"); --tz sets the zone it is read in',
      "  --loop       an existing object id, or a loop TITLE to match (default: a",
      "               scratch loop this command creates and activates)",
      "  --brief      what each run should do (default: a read-only survey of the workdir)",
      "  --workdir    where it may work, relative to the agent's own run root",
      "  --repos      repositories it may act on (the agent narrows this again)",
      "  --transition the transition the clock enters (default: resolved from the type)",
      "  --disarm     drop the cursor instead of arming one (the cadence stays)",
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

/** An explicit id, a title match, or nothing. A TITLE is accepted because that is
 *  what a person reading the workspace has in front of them; an ambiguous match is
 *  refused rather than resolved by ordering. */
async function resolveTarget(ref: string | undefined) {
  if (!ref) return undefined;
  const byId = await graph.getObject(undefined, ref);
  if (byId) return byId;
  const all = await graph.listObjects(undefined, DEMO_TEAM_ID);
  const needle = ref.toLowerCase();
  const matches = all.filter((o) => (o.title ?? "").toLowerCase().includes(needle));
  if (!matches.length) {
    process.stderr.write(`no object matches "${ref}"\n`);
    process.exit(1);
  }
  if (matches.length > 1) {
    process.stderr.write(
      [`"${ref}" matches ${matches.length} objects:`, ...matches.map((m) => `  ${m.id}  ${m.title}`), ""].join("\n"),
    );
    process.exit(1);
  }
  return matches[0]!;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) usage();

  const now = new Date().toISOString();
  await runMigrations();

  const target = await resolveTarget(flagValue(argv, "loop"));

  if (argv.includes("--disarm")) {
    if (!target) usage();
    const out = await disarmSchedule({ objectId: target.id, userId: DEMO_USER_ID, now });
    if (!out.ok) {
      process.stderr.write(`disarm refused: ${out.code} - ${out.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`\n${target.title ?? target.id} disarmed - the cadence stays, the clock stops.\n\n`);
    process.exit(0);
  }

  const cadence = parseCadence({
    cron: flagValue(argv, "cron") ?? null,
    interval: flagValue(argv, "every") ?? null,
    timezone: flagValue(argv, "tz") ?? null,
  });
  if (!cadence.ok) {
    process.stderr.write(`${cadence.why}\n`);
    process.exit(1);
  }

  const brief = flagValue(argv, "brief") ?? DEFAULT_BRIEF;
  const workdir = flagValue(argv, "workdir");
  const repos = flagValue(argv, "repos");
  const transition = flagValue(argv, "transition");

  // No target ⇒ create a scratch LOOP and activate it. `activate` is entered by a
  // human, which is the same act that will authorize its fires - so the demo's
  // provenance is honest end to end rather than a seeded fiction.
  let object = target;
  if (!object) {
    object = await graph.createObject(undefined, {
      teamId: DEMO_TEAM_ID,
      archetype: "task",
      type: "loop",
      status: "planned",
      title: DEFAULT_TITLE,
      payload: { band: "platform", kind: "loop", cadence: describeCadence(cadence.spec), rank: 0, runs: 0 },
      now,
    });
    const activated = await applyTransition({
      objectId: object.id,
      transition: "activate",
      actor: { entrance: "human", actorId: DEMO_USER_ID },
      now,
      eventPayload: { note: `created ${DEFAULT_TITLE} to carry a scheduled run` },
    });
    if (!activated.ok) {
      process.stderr.write(`activate refused: ${activated.code} - ${activated.message}\n`);
      process.exit(1);
    }
    object = activated.object;
  }

  const armed = await armSchedule({
    objectId: object.id,
    cadence: cadence.spec,
    ...(transition ? { fireTransition: transition } : {}),
    userId: DEMO_USER_ID,
    now,
    // The INSTANCE half of the fire's work order: what this loop's run should do,
    // and where. The static declaration cannot know either.
    fields: {
      brief,
      ...(workdir ? { workdir } : {}),
      ...(repos ? { repos } : {}),
    },
  });
  if (!armed.ok) {
    process.stderr.write(`arm refused: ${armed.code} - ${armed.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    [
      "",
      `armed ${armed.object.title ?? armed.object.id}`,
      `  object          ${armed.object.id}`,
      `  cadence         ${armed.cadence}`,
      `  fires           ${armed.fireTransition}`,
      `  next fire       ${armed.nextFire}`,
      `  approved by     ${armed.eventId} (human · ${DEMO_USER_ID})`,
      `  brief           ${brief.split("\n")[0]}`,
      `  workdir         ${workdir ?? "(the agent's own run root)"}`,
      `  repos           ${repos ?? "(none - the instruction claims no repo scope)"}`,
      "",
      "Start the server (`pnpm dev`) and the machine agent (`pnpm agent`). Nobody has to",
      "click anything: the clock fires, the outbox writes a run work order, the agent",
      "executes it, and its report lands in the Timeline.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`graph:schedule failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
