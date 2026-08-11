/**
 * SEO-SCALE - Scenario 02 (docs/plans/2026-08-10-simulator-scenario-02-seo.md):
 * two weekly loops collaborating THROUGH task objects across three virtual weeks.
 * bet-manager runs the 试水→判赢→交接→放大 lifecycle (open bets, hand-write trial
 * pages, judge winners done, mint UNASSIGNED scale-* tasks, kill losers archived,
 * refresh a human-readable portfolio doc); engine pulls the unassigned scale tasks
 * (a SINGLE-update claim), batch-generates the related-keyword pages (<=5/run), and
 * stops clean when there is nothing to scale. tim is absent the whole run.
 *
 * The arc (2026-08-31 Mon W1 .. 2026-09-18 Fri W3):
 *   - bet A "ai design agent": trial page (W1) -> world moves its rank only after
 *     the page lands -> judged done W2 Mon + scale-A minted -> engine beds the
 *     scale pages (W2 Wed offline -> caught up Thu) -> cluster impressions rise
 *     once the scale pages land (W3 visible).
 *   - bet B "figma alternative": trial page written, rank flat two weeks -> W3 Mon
 *     killed archived with a data conclusion, no orphan children.
 *   - opportunity "claude code design": surfaces mid-W2 in the mirror -> discovered
 *     W3 Mon as bet C.
 *   - W2 Wed 09-09 offline (harness skips --spawn): engine's fire defers, Thursday
 *     catches it up - late a day, not failed.
 *   - W2 Fri 09-11: the mirror duplicates bet A's entry - must not re-open / re-mint.
 *
 * The two conditional world stages key on the FILE PROBE (§3.4): the trial page
 * landing lifts bet A's rank; the scale pages landing lifts the whole cluster.
 * Those files are only written on the real-agent (haiku) tier - a replay agent
 * can only run kernel CLI argv, so on the replay tier the file-gated events simply
 * never fire, and the replay e2e asserts the CLI-expressible mechanism chain only.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../src/types.js";
import type { HumanRule } from "../src/human.js";

/** Deterministic loop + task ids (pinned so the replay script + assertions key on
 *  them without deriving slugs). */
export const BET_MANAGER_ID = "seo-bet-manager";
export const ENGINE_ID = "seo-engine";
export const BET_A_ID = "bet-ai-design-agent";
export const BET_B_ID = "bet-figma-alternative";
export const BET_C_ID = "bet-claude-code-design";
export const SCALE_A_ID = "scale-ai-design-agent";

/** Absolute path to the replay-agent shim (resolved relative to this package). */
export function replayAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "shims", "replay-agent.mjs");
}

// ---- loop briefs (authored as task BODY via --body-file) ----

const BET_MANAGER_BRIEF = `## Spec

You are the SEO bet manager. Weekly (Monday), one pass then stop:

- Read mirrors/search-console.md. Open a bet for EACH promising new keyword that
  has no open bet yet (a good week may open several; a quiet week opens none):
  \`create "bet: <kw>" --id bet-<slug> --parent seo-bet-manager --assignee claude
  --status in-progress\`. Then HAND-WRITE a trial page to content/trial/<slug>.md
  (a real file - the trial IS the page; the world only reacts once it lands).
- Review open bets against the mirror. A bet that crossed the validation line
  (rank into the low 20s): judge it WON - \`update bet-<slug> status=done --note
  "<data>"\` (done is terminal, it kills the alarm) and mint a scale task for the
  engine, UNASSIGNED, parented to the bet: \`create "scale: <kw>" --id scale-<slug>
  --parent bet-<slug>\`. Do NOT assign it and do NOT pass --status - born
  \`todo\` + unassigned is exactly what the engine's pull query finds.
- A bet flat for TWO WEEKS (from its created date): collect it - \`update
  bet-<slug> status=archived --note "<data conclusion>"\`. Leave no orphan
  children.
- Every Monday REPLACE the whole portfolio doc: \`doc put seo-portfolio --file
  <path>\`. Four sections: (1) live bets table (kw / data / this-week decision /
  next checkpoint), (2) this week's wins + kills with their data, (3) scale output
  list pointing at content/scale/, (4) next week's plan. Write the body to a temp
  file OUTSIDE the workspace, then pass --file.
- Also FREEZE this week's judgment as a dated report: \`doc put
  seo-report-<ISO week, e.g. 2026-w37> --file <path>\` - a NEW key every week,
  never overwrite a past week's report. The portfolio is the WINDOW (current
  state, replaced weekly); the report is the RECORD (this week's decisions with
  their evidence, immortal). Not a copy of each other - the report captures what
  THIS pass decided and why.
- Nothing new to bet on = say so in one note and stop. Never manufacture activity.
`;

const ENGINE_BRIEF = `## Spec

You are the SEO scale engine. Weekly (Wednesday), PULL mode, one pass then stop:

- Find claimable scale tasks by MEANING, not by one status filter: claimable =
  a \`scale-*\` task with NO assignee whose status is not done/archived. Run
  \`list --json\` and filter yourself - a producer may have minted the task with
  a sloppy status, and a too-literal query would leave a real handoff waiting
  forever. Nothing claimable = one note, clean stop. Never invent work.
- CLAIM in ONE command: \`update scale-<slug> assignee=claude status=in-progress\`.
  Set BOTH fields in the SAME update. Claiming in two steps (assignee first, then
  status) leaves the task momentarily todo+assigned, which mints a spurious
  assignment run - you will see the extra run in the event log. One update is the
  correct move.
- Produce related-keyword pages under content/scale/<slug>/, at most 5 pages per
  run (batch discipline - more keywords wait for next week). Then \`update
  scale-<slug> status=done --note "<page list>"\`.
- Keep heavy work OUT of the loop folder; the pages are the product.
`;

// ---- mirror arcs (the world writes mirrors/search-console.md daily) ----

/** search-console for W1: bet A pre-trial (rank 35), bet B pre-trial (rank 42). */
const MIRROR_W1 = `# search console (weekly keyword ranks + impressions)

ai design agent | rank 35 | imp 400
figma alternative | rank 42 | imp 900
`;

/** After bet A's trial page lands (file-gated): rank moves 35 -> 22 (over the
 *  validation line). bet B stays flat. */
const MIRROR_A_TRIAL_MOVED = `# search console (weekly keyword ranks + impressions)

ai design agent | rank 22 | imp 900   (crossed validation line after trial page)
figma alternative | rank 41 | imp 900
`;

/** Mid-W2: the opportunity keyword surfaces; bet A holding at its validated rank,
 *  bet B still flat. */
const MIRROR_W2_OPPORTUNITY = `# search console (weekly keyword ranks + impressions)

ai design agent | rank 22 | imp 950
figma alternative | rank 45 | imp 850
claude code design | rank 30 | imp 1100   (rising - opportunity, no bet yet)
`;

/** W2 Friday DUPLICATE injection: bet A's entry appended a second time. The agent
 *  must not re-open a bet / re-mint a scale for it (idempotency). */
const MIRROR_W2_DUP = `# search console (weekly keyword ranks + impressions)

ai design agent | rank 22 | imp 950
figma alternative | rank 45 | imp 850
claude code design | rank 30 | imp 1100   (rising - opportunity, no bet yet)
ai design agent | rank 22 | imp 950   (DUPLICATE ENTRY - same keyword)
`;

/** After the scale pages land (file-gated): the whole ai-design cluster's
 *  impressions rise (W3 visible). */
const MIRROR_CLUSTER_RISEN = `# search console (weekly keyword ranks + impressions)

ai design agent | rank 22 | imp 2400   (cluster impressions up - scale pages indexed)
ai design agent (cluster) | pages 5 | imp 1500
figma alternative | rank 45 | imp 850
claude code design | rank 29 | imp 1200
`;

// ---- the two file-gated conditional stages (§3.4) ----

/** Stage 1: bet A's rank moves ONLY once the trial page really landed. */
function trialPageLanded(probe: { fileExists: (rel: string) => boolean }): boolean {
  return probe.fileExists("content/trial/ai-design-agent.md");
}

/** Stage 2: the cluster impressions rise ONLY once a scale page really landed.
 *  Probes the DIRECTORY, not a hardcoded filename - round-1 forensics: the agent
 *  wrote 5 named pages and no index.md, so a filename probe never fired. */
function scalePagesLanded(probe: { dirHasFiles: (rel: string) => boolean }): boolean {
  return probe.dirHasFiles("content/scale/ai-design-agent");
}

// ---- human (tim is absent; one broad fallback so an escalation never dead-ends) ----

/** tim is expected to receive NOTHING this whole run (the "don't find people when
 *  you shouldn't" test). The single rule is a broad fallback: any task assigned to
 *  tim gets a generic +2-day reply, so an UNEXPECTED escalation is caught rather
 *  than dead-ending the scenario - but under a correct run it never fires. */
const HUMAN_RULES: HumanRule[] = [
  {
    actor: "tim",
    match: "", // matches any task in tim's inbox (should stay empty)
    delayDays: 2,
    reply: "ack - go ahead, keep me posted.",
    reassignTo: "claude",
  },
];

/** Build the seo-scale scenario. `agentProfile` binds the `claude` assignee (the
 *  replay tier passes the replay shim; the haiku tier passes the real claude). */
export function seoScaleScenario(agentProfile: Scenario["profiles"][string]): Scenario {
  return {
    name: "seo-scale",
    profiles: { claude: agentProfile },
    human: HUMAN_RULES,
    setup: {
      files: {
        "specs/bet-manager.md": BET_MANAGER_BRIEF,
        "specs/engine.md": ENGINE_BRIEF,
      },
      tasks: [
        [
          "create",
          "seo bet manager",
          "--id",
          BET_MANAGER_ID,
          "--cron",
          "0 7 * * 1", // Mondays
          "--timezone",
          "UTC",
          "--status",
          "in-progress",
          "--assignee",
          "claude",
          "--body-file",
          "specs/bet-manager.md",
        ],
        [
          "create",
          "seo scale engine",
          "--id",
          ENGINE_ID,
          "--cron",
          "0 7 * * 3", // Wednesdays
          "--timezone",
          "UTC",
          "--status",
          "in-progress",
          "--assignee",
          "claude",
          "--body-file",
          "specs/engine.md",
        ],
      ],
    },
    days: [
      // ===== Week 1 =====
      // Mon 08-31: baseline mirror; bet-manager opens bet A + bet B, writes trials.
      {
        date: "2026-08-31",
        morning: [{ kind: "mirror-write", path: "mirrors/search-console.md", content: MIRROR_W1 }],
        evening: [],
      },
      { date: "2026-09-01", morning: [], evening: [] }, // Tue
      // Wed 09-02: engine's first fire - no scale tasks yet, clean stop.
      { date: "2026-09-02", morning: [], evening: [] },
      { date: "2026-09-03", morning: [], evening: [] }, // Thu
      // Fri 09-04: bet A's rank moves - CONDITIONAL on the trial page having landed.
      {
        date: "2026-09-04",
        morning: [
          {
            kind: "mirror-write",
            path: "mirrors/search-console.md",
            content: MIRROR_A_TRIAL_MOVED,
            when: trialPageLanded,
          },
        ],
        evening: [],
      },
      { date: "2026-09-05", morning: [], evening: [] }, // Sat
      { date: "2026-09-06", morning: [], evening: [] }, // Sun
      // ===== Week 2 =====
      // Mon 09-07: bet A judged won + scale-A minted; portfolio refresh.
      { date: "2026-09-07", morning: [], evening: [] },
      // Tue 09-08: the opportunity keyword surfaces mid-week.
      {
        date: "2026-09-08",
        morning: [
          { kind: "mirror-write", path: "mirrors/search-console.md", content: MIRROR_W2_OPPORTUNITY },
        ],
        evening: [],
      },
      // Wed 09-09: OFFLINE all day (engine's fire defers, catches up Thu).
      { date: "2026-09-09", morning: [], evening: [], offline: true },
      { date: "2026-09-10", morning: [], evening: [] }, // Thu: engine catch-up
      // Fri 09-11: DUPLICATE bet A entry injected (idempotency guard).
      {
        date: "2026-09-11",
        morning: [
          { kind: "mirror-write", path: "mirrors/search-console.md", content: MIRROR_W2_DUP },
        ],
        evening: [],
      },
      { date: "2026-09-12", morning: [], evening: [] }, // Sat
      // Sun 09-13: the cluster impressions rise - CONDITIONAL on scale pages landing.
      {
        date: "2026-09-13",
        morning: [
          {
            kind: "mirror-write",
            path: "mirrors/search-console.md",
            content: MIRROR_CLUSTER_RISEN,
            when: scalePagesLanded,
          },
        ],
        evening: [],
      },
      // ===== Week 3 =====
      // Mon 09-14: bet B killed; opportunity discovered as bet C; portfolio refresh.
      { date: "2026-09-14", morning: [], evening: [] },
      { date: "2026-09-15", morning: [], evening: [] }, // Tue
      // Wed 09-16: engine's W3 fire (any fresh scale work, else clean stop).
      { date: "2026-09-16", morning: [], evening: [] },
      { date: "2026-09-17", morning: [], evening: [] }, // Thu
      { date: "2026-09-18", morning: [], evening: [] }, // Fri - close of window
    ],
  };
}

// ---- the deterministic replay script (replay tier only) ----

/** A SIMPLIFIED but complete replay of the CLI-expressible mechanism chain. Keys
 *  are date-keyed (`<taskId>@<YYYY-MM-DD>`) so each weekly fire replays a different
 *  sequence. File products (trial/scale pages) are NOT expressible as kernel argv,
 *  so the replay agent skips them and the file-gated world stages never fire on
 *  this tier - the replay e2e asserts the object/handoff mechanics only. Provenance
 *  rides via env (LOOPANY_SESSION_ID/_ACTOR from the spawn), so no --actor here.
 *
 *  bet-manager: W1 Mon opens bet A + bet B + portfolio; W2 Mon wins bet A + mints
 *  scale-A + portfolio; W3 Mon kills bet B (archived) + opens bet C + portfolio.
 *  engine: catches up its offline-Wed fire on Thu 09-10 with the SINGLE-update
 *  claim of scale-A + done. */
export const SEO_SCALE_REPLAY: Record<string, string[][]> = {
  // --- bet-manager, W1 Monday: open both bets, seed the portfolio ---
  [`${BET_MANAGER_ID}@2026-08-31`]: [
    ["create", "bet: ai design agent", "--id", BET_A_ID, "--parent", BET_MANAGER_ID, "--assignee", "claude", "--status", "in-progress", "--note", "opened bet on \"ai design agent\" (rank 35)"],
    ["create", "bet: figma alternative", "--id", BET_B_ID, "--parent", BET_MANAGER_ID, "--assignee", "claude", "--status", "in-progress", "--note", "opened bet on \"figma alternative\" (rank 42)"],
    ["doc", "put", "seo-portfolio", "--file", "specs/bet-manager.md"],
    ["doc", "put", "seo-report-2026-w36", "--file", "specs/bet-manager.md"],
    ["note", BET_MANAGER_ID, "W1: opened bets A + B; trial pages written; portfolio seeded"],
  ],
  // --- bet-manager, W2 Monday: bet A won -> done + scale-A minted (unassigned) ---
  [`${BET_MANAGER_ID}@2026-09-07`]: [
    ["update", BET_A_ID, "status=done", "--note", "won: \"ai design agent\" rank 35 -> 22, crossed validation line"],
    ["create", "scale: ai design agent", "--id", SCALE_A_ID, "--parent", BET_A_ID, "--note", "unassigned - engine pulls this"],
    ["doc", "put", "seo-portfolio", "--file", "specs/bet-manager.md"],
    ["doc", "put", "seo-report-2026-w37", "--file", "specs/bet-manager.md"],
    ["note", BET_MANAGER_ID, "W2: bet A won -> scale-A minted for engine; bet B still flat"],
  ],
  // --- bet-manager, W3 Monday: kill bet B (archived), discover opportunity as C ---
  [`${BET_MANAGER_ID}@2026-09-14`]: [
    ["update", BET_B_ID, "status=archived", "--note", "killed: \"figma alternative\" flat at rank 41-45 two weeks, no signal"],
    ["create", "bet: claude code design", "--id", BET_C_ID, "--parent", BET_MANAGER_ID, "--assignee", "claude", "--status", "in-progress", "--note", "discovered \"claude code design\" rising (rank 30) - new bet"],
    ["doc", "put", "seo-portfolio", "--file", "specs/bet-manager.md"],
    ["doc", "put", "seo-report-2026-w38", "--file", "specs/bet-manager.md"],
    ["note", BET_MANAGER_ID, "W3: killed bet B; opened bet C on the opportunity keyword"],
  ],
  // --- engine, offline-Wed fire caught up Thu 09-10: SINGLE-update claim + done ---
  [`${ENGINE_ID}@2026-09-10`]: [
    ["update", SCALE_A_ID, "assignee=claude", "status=in-progress", "--note", "claimed scale-A in one update (assignee + status together)"],
    ["update", SCALE_A_ID, "status=done", "--note", "generated 5 related-keyword pages under content/scale/ai-design-agent/"],
    ["note", ENGINE_ID, "caught up the offline-Wed fire: scaled ai-design-agent (5 pages)"],
  ],
  // --- engine, W1 Wed + W3 Wed: nothing unassigned to scale, clean stop ---
  [`${ENGINE_ID}@2026-09-02`]: [["note", ENGINE_ID, "no unassigned scale tasks - clean stop"]],
  [`${ENGINE_ID}@2026-09-16`]: [["note", ENGINE_ID, "no unassigned scale tasks - clean stop"]],
};
