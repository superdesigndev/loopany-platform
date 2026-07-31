/**
 * ARMING A SEEDED LOOP - the deliberate "yes, run this here" half of a deploy.
 *
 * `seed-real.ts` imports a production loop's cadence as CONFIGURATION and stops
 * there, on purpose: importing a cadence must never be the same act as agreeing to
 * run it. On a developer's machine the second act is `pnpm graph:schedule`. A
 * DEPLOYED workspace has no such door - the embedded database is single-writer and
 * held by the running app - so without this module a deployed demo can only ever be
 * a museum of past runs, and the one thing worth proving (the clock fires, a work
 * order reaches a machine, a real run writes back) is the thing it cannot show.
 *
 * So arming rides the seed, and it is CONFIGURATION:
 *
 *   LOOPANY_GRAPH_SEED_ARM="Daily react-doctor triage"   arm these loops
 *   LOOPANY_GRAPH_SEED_ARM_IN=3                          first fire in N minutes
 *
 * UNSET arms nothing, which keeps the import-is-not-consent rule intact for every
 * deploy that does not opt in.
 *
 * ── this does not invent an authority ───────────────────────────────────────
 *
 * Arming writes a `schedule-armed` event with `entrance: "human"`, and that event is
 * the standing approval every R3 fire rests on. That is a real power, so note what
 * it is NOT: the seeder already writes human-entrance events for the whole replayed
 * history (every loop's `activate` is one), so an operator who can seed can already
 * mint them. This adds no door - it names one that was already open, gates it behind
 * an explicit variable, and records the same `u-demo-captain` actor as the rest of
 * the seeded past.
 *
 * ── an armed loop must have instructions ────────────────────────────────────
 *
 * A fire dispatches a work order, and a work order with no workflow is a run with
 * nothing to do that still costs somebody an agent invocation. So arming REQUIRES an
 * authored workflow for that loop (below) and throws without one. Fail loud beats a
 * loop that fires into silence every morning.
 */
import type { ProdLoop } from "./pull-prod.js";

export const SEED_ARM_ENV = "LOOPANY_GRAPH_SEED_ARM";
export const SEED_ARM_IN_ENV = "LOOPANY_GRAPH_SEED_ARM_IN";

/**
 * The STANDING WORKFLOW a seeded loop's runs read, keyed by the production loop's
 * name.
 *
 * Every word here is DATA. It lives in this file only because a deployed seed needs
 * a starting fixture and there is no authoring surface on a deployed app yet;
 * nothing reads it at runtime, and editing a loop's workflow in the workspace
 * changes what its next run does without touching a line of TypeScript. Same
 * rationale, and the same disclaimer, as `agentic-cli.ts`.
 *
 * This one is ADAPTED from the production loop's own brief, with two deliberate
 * differences: the run does TRIAGE ONLY (the production loop ships fixes; a
 * demonstration workspace has no business opening pull requests on a private
 * monorepo), and its OUTPUTS are the graph verbs rather than a PR - which is the
 * whole point, because a finding that lands as a task somebody can see is what the
 * workspace exists to show.
 */
export const SEEDED_WORKFLOWS: Record<string, string> = {
  "Daily react-doctor triage": [
    "You are the daily React health triage for superdesigndev/superdesign-platform. Your job is to find the",
    "worst REAL frontend health problem, write it up, and hand a person the decision about fixing it.",
    "",
    "YOU DO TRIAGE ONLY. You do not fix anything, you do not commit, you do not push, you do not open a pull",
    "request, and you never write to the repository. A fix happens later, if a person approves one, as its own",
    "dispatched run. If you find yourself editing a source file, you have misread this instruction.",
    "",
    "Each run, in order:",
    "",
    "1. GET A CLEAN COPY. Work only inside your workdir. Clone the repository shallowly if it is not there yet",
    "   (`gh repo clone superdesigndev/superdesign-platform repo -- --depth 50`), otherwise `git -C repo fetch",
    "   origin main` and check out `origin/main` detached. Never touch anything outside your workdir.",
    "",
    "2. SCAN, PINNED. Run the analyzer at the version the fleet has a baseline for - never `@latest`, because two",
    "   analyzer upgrades have already reclassified whole rule families and destroyed score comparability:",
    "     npx react-doctor@0.7.4 --project design-platform-frontend --json --json-out scan.json --no-dead-code -y",
    "   The JSON is `{summary, diagnostics}`: `summary.score` is the 0-100 score, `summary.totalDiagnosticCount`",
    "   the issue total, and each diagnostic carries `filePath`, `plugin`, `rule`, `severity`, `message` and a",
    "   position. Rank the error-severity diagnostics by `plugin/rule` family, biggest family first.",
    "",
    "   SCOPE: active code only - `apps/design-platform-frontend` and `packages/*`. Legacy `apps/frontend`,",
    "   `apps/backend`, `superdesign-extension`, `my-v0-project`, build output and devDependency advisory noise",
    "   are out of scope and a finding drawn from them is a false finding.",
    "",
    "3. CHECK REALITY BEFORE YOU WRITE ANYTHING DOWN. Read `context.alreadyRecorded` - the tasks and reviews this",
    "   loop has ALREADY produced, newest first. If the family you picked is one of them, or is the same problem",
    "   wearing different words, STOP: say which entry it matches, report the score, and end the run. A clean stop",
    "   is a real outcome. A second task for a problem already tracked is worse than doing nothing, because",
    "   somebody has to un-file it.",
    "",
    "4. RECORD ONE PROBLEM. `graph task create --type task --title \"<the problem, named concretely>\"` - one task,",
    "   for the single top in-scope error family, not a list of everything you saw.",
    "",
    "5. WRITE THE TRIAGE REPORT. Put a markdown file in your workdir and `graph artifact push <file> --for <the",
    "   task id>`. It should carry: the pinned score and issue total, the family ranking, the specific instances",
    "   (file, line, message) of the family you chose, why that family is the one worth doing next, and what a fix",
    "   would look like - concretely enough that somebody could judge the risk without opening the repo.",
    "",
    "6. ASK. `graph review request --about <the task id> --preset dispatch --question \"Fix this?\"` and pass the",
    "   FIX RUN's own work order as fields:",
    "     --field role=fix",
    "     --field brief=\"<what a fix run should change, in one paragraph>\"",
    "     --field workdir=<your workdir>",
    "     --field repos=superdesigndev/superdesign-platform",
    "     --field workflow=\"<how the fix run should work: branch off main, one focused change, verify by re-running",
    "       the pinned scan, open ONE pull request, track it, ask for the merge verdict>\"",
    "   The person approving that review is what dispatches the fix run, so those fields ARE its instructions.",
    "   You are not that run.",
    "",
    "Then stop, and print a short report: the score, the issue total, the family you filed, and the ids you created.",
  ].join("\n"),
};

export interface SeedArmRequest {
  /** The loop name or id, exactly as configured. */
  key: string;
  /** Minutes from now for the FIRST fire only. Absent ⇒ the natural occurrence. */
  firstFireInMinutes?: number;
}

/** `"a, b"` → requests; unset/blank → null, which means "arm nothing". */
export function configuredArms(env: NodeJS.ProcessEnv = process.env): SeedArmRequest[] | null {
  const raw = env[SEED_ARM_ENV]?.trim();
  if (!raw) return null;
  const minutesRaw = Number(env[SEED_ARM_IN_ENV]?.trim());
  const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.floor(minutesRaw) : undefined;
  const keys = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keys.length) return null;
  return keys.map((key) => ({ key, ...(minutes ? { firstFireInMinutes: minutes } : {}) }));
}

/** The authored workflow for a loop, or undefined. Name first, then id, matching
 *  the seed scope's rule so one spelling works in both variables. */
export function workflowFor(loop: Pick<ProdLoop, "id" | "name">): string | undefined {
  const byName = Object.entries(SEEDED_WORKFLOWS).find(([k]) => k.trim().toLowerCase() === loop.name.trim().toLowerCase());
  if (byName) return byName[1];
  return SEEDED_WORKFLOWS[loop.id];
}

/** Does this request name this loop? Same exact-match rule as the seed scope. */
export function armMatches(request: SeedArmRequest, loop: Pick<ProdLoop, "id" | "name">): boolean {
  const key = request.key.trim().toLowerCase();
  return key === loop.name.trim().toLowerCase() || key === loop.id.trim().toLowerCase();
}

/** ISO instant of the requested first fire, or undefined for the natural one. */
export function firstFireAt(request: SeedArmRequest, now: string): string | undefined {
  if (!request.firstFireInMinutes) return undefined;
  return new Date(Date.parse(now) + request.firstFireInMinutes * 60_000).toISOString();
}
