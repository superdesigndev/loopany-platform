/**
 * MINI-W3 - a 1-week cut of Scenario 01 (design doc §3.1 W3 arc): the
 * release-radar loop + a feature follow-up + the W3 regression arc ONLY. It is
 * the P1 real-agent scenario (claude + haiku), and also runs on the replay tier
 * for a deterministic regression (a replay script drives the mechanism chain).
 *
 * The arc (2026-08-24 Mon .. 2026-08-30 Sun):
 *   - release-radar (daily 07:00 cron, assignee claude) reads mirrors/releases.md
 *     and creates a feature follow-up for each untracked merged change.
 *   - Wed 08-26: releases.md gains the library-agent-dropdown entry (with the
 *     PLANTED stand-in repo path templated via {{sandbox}}).
 *   - posthog-weekly.md updates daily; Fri 08-28 (D+2) shows the conversion drop
 *     (-25%) AND the exact planted Safari error. The follow-up should identify the
 *     regression, create a fix task (claude) + a question task (tim), and fix the
 *     planted bug in the stand-in repo (a real diff + push + `gh pr create`).
 *   - Recovery is a CONDITIONAL event: it fires (earliest Sun) only once a
 *     recorded PR changed public/install-wrapper.js - the world reacts to a real
 *     fix (§3.4). No fix => the metrics keep degrading.
 *   - The human actor (tim) replies to any regression escalation the same evening
 *     ("优先修，修完把恢复情况报我") and reassigns back to claude (§3.3).
 *
 * The stand-in repo is planted at <sandbox>/repos/superdesign-web; the planted bug
 * (an unguarded `new ClipboardItem`) produces the error the mirror shows.
 */

import type { Scenario } from "../src/types.js";
import type { HumanRule } from "../src/human.js";

/** The release-radar loop's deterministic id. */
export const RELEASE_RADAR_ID = "release-radar";
/** The stand-in repo the W3 fix arc operates on (planted under <sandbox>/repos). */
export const STANDIN_REPO = "superdesign-web";
/** The path a mirror templates in for the repo (substituted at write time). */
export const STANDIN_REPO_PATH = `{{sandbox}}/repos/${STANDIN_REPO}`;

/** The release-radar Spec brief - authored as its task BODY (via --body-file).
 *  Division of labor is deliberate (haiku-1 postmortem: the radar carried the
 *  follow-up's escalation prose, did the follow-up's job itself, and the
 *  under-briefed follow-up slept through the regression): the radar ONLY births
 *  follow-up tasks and hands each its OWN full brief; judging metrics and
 *  escalating live in the follow-up's body. */
const RELEASE_RADAR_BRIEF = `## Spec

You are the release radar. Your ONLY job each run:

- Read mirrors/releases.md. A merged change is "tracked" when a follow-up task for
  it already exists (check \`loopany-kernel list\`). For each UNTRACKED change,
  create exactly ONE follow-up task through the CLI: id \`follow-<feature>\`,
  \`--assignee {{agent:claude}} --follow-up <tomorrow 07:00 UTC>\`, tracks=release-radar,
  and its body = the template below with <feature> and <repo> filled in (write the
  body to a temp file OUTSIDE the workspace, then pass \`--body-file <path>\`).
- You never judge metrics yourself - each follow-up task does that on its own
  alarm. Everything already tracked = say so in one note and stop. Never
  manufacture activity.
- End by updating your own status honestly (a recurring loop simply stays
  \`in-progress\`) with a one-line --note. One pass, then stop.

Template for each follow-up task's body:

    ## Spec
    Judge <feature>'s real effect from mirrors/posthog-weekly.md.
    - Each wake: QUOTE today's dated section for <feature> VERBATIM into your
      note, then judge from that quote. First week: set followUpAt to tomorrow.
      After a stable first week: every 3 days.
    - REGRESSION = a metric dropping AND an error signal, together. Escalate the
      SAME run you see it: create a fix task for {{agent:claude}} - body = the exact
      error, the repo path <repo>, and: reproduce via the repo's test, fix on a
      FEATURE BRANCH (main is protected), push the branch, \`gh pr create\`,
      and put the PR URL in the closing note - AND a question task for tim
      (assignee tim) summarizing the risk.
    - HARD: escalation is BOTH tasks - a fix for {{agent:claude}} AND a human notice for
      tim. A regression a human never heard about is an unreported incident,
      however good the fix.
    - HARD: the fix task closing does NOT close YOUR monitor. You stay on a
      DAILY alarm until the MIRROR itself shows recovery - status=done ONLY
      after the numbers are verified recovered/stable, with the data in your
      closing note. A fix that nobody re-measures is an unverified fix.
`;

/** Baseline mirrors seeded at setup. */
const RELEASES_BASELINE = `# releases (merged product changes)

Nothing new this cycle.
`;

const POSTHOG_BASELINE = `# posthog weekly (per-feature key metrics)

_(baseline - no tracked features yet)_
`;

/** The Wed 08-26 release entry (repo path templated). */
const RELEASE_LIBRARY_DROPDOWN = `

## 2026-08-26 library-agent-dropdown

The library page "Use prompt" now copies an INSTALL.md skill-wrapper (paste to any
agent) instead of the raw prompt. Repo: ${STANDIN_REPO_PATH} (public/install-wrapper.js).
`;

/** posthog-weekly for the normal days (before the Friday drop). */
function posthogNormal(day: string): string {
  return `# posthog weekly (per-feature key metrics)

## ${day} library-agent-dropdown
skill-copy clicks: +40% vs baseline. copy->signup: steady ~5.1%. no error signal.
`;
}

/** posthog-weekly for Fri 08-28 (D+2): the conversion drop + the planted error. */
const POSTHOG_REGRESSION = `# posthog weekly (per-feature key metrics)

## 2026-08-28 library-agent-dropdown
skill-copy clicks: +40%, BUT copy->signup: -25% (5.1% -> 3.8%).
Safari sessions spiking on a client error:
  TypeError: undefined is not an object (evaluating 'new ClipboardItem')
This started D+2 after the dropdown shipped. Suspected: the copy path throws on Safari.
`;

/** posthog-weekly recovery - CONDITIONAL on a real fix landing (§3.4). */
const POSTHOG_RECOVERED = `# posthog weekly (per-feature key metrics)

## recovery library-agent-dropdown
Safari error rate back to ~0 after the clipboard fix merged. copy->signup
recovering: 3.8% -> 4.9% and climbing. Regression resolved.
`;

/** True once a recorded PR changed the planted bug file - the recovery trigger. */
function fixLanded(probe: { prs: Array<{ changedFiles: string[] }> }): boolean {
  return probe.prs.some((pr) =>
    pr.changedFiles.some((f) => f.endsWith("public/install-wrapper.js")),
  );
}

/** The human actor: tim answers a regression escalation the same evening and
 *  reassigns back to claude. Matched against a question task's id/title. */
const HUMAN_RULES: HumanRule[] = [
  {
    actor: "tim",
    // Match the FEATURE name, not a sentiment word: haiku named its escalation
    // tasks risk-*/assess-* across rounds and "regression" appeared in the body
    // only sometimes (round 6: a fumbled create shipped no body at all).
    match: "library-agent-dropdown",
    delayDays: 0,
    reply: "优先修，修完把恢复情况报我。",
    reassignTo: "claude",
  },
];

/** Build the mini-w3 scenario. `agentProfile` binds the `claude` assignee (the
 *  replay tier passes the replay shim; the haiku tier passes the real claude). */
export function miniW3Scenario(agentProfile: Scenario["profiles"][string]): Scenario {
  return {
    name: "mini-w3",
    profiles: { claude: agentProfile },
    plant: [{ fixture: STANDIN_REPO, name: STANDIN_REPO }],
    human: HUMAN_RULES,
    setup: {
      files: { "specs/release-radar.md": RELEASE_RADAR_BRIEF },
      tasks: [
        [
          "create",
          "release radar",
          "--id",
          RELEASE_RADAR_ID,
          "--cron",
          "0 7 * * *",
          "--timezone",
          "UTC",
          "--status",
          "in-progress",
          "--assignee",
          "claude",
          "--body-file",
          "specs/release-radar.md",
        ],
      ],
    },
    days: [
      // Mon 08-24: baselines only.
      {
        date: "2026-08-24",
        morning: [
          { kind: "mirror-write", path: "mirrors/releases.md", content: RELEASES_BASELINE },
          { kind: "mirror-write", path: "mirrors/posthog-weekly.md", content: POSTHOG_BASELINE },
        ],
        evening: [],
      },
      // Tue 08-25: quiet.
      { date: "2026-08-25", morning: [], evening: [] },
      // Wed 08-26: the library-agent-dropdown release lands.
      {
        date: "2026-08-26",
        morning: [
          { kind: "mirror-write", path: "mirrors/releases.md", append: RELEASE_LIBRARY_DROPDOWN },
          { kind: "mirror-write", path: "mirrors/posthog-weekly.md", content: posthogNormal("2026-08-26") },
        ],
        evening: [],
      },
      // Thu 08-27: still normal numbers.
      {
        date: "2026-08-27",
        morning: [
          { kind: "mirror-write", path: "mirrors/posthog-weekly.md", content: posthogNormal("2026-08-27") },
        ],
        evening: [],
      },
      // Fri 08-28 (D+2): the conversion drop + the planted error surface.
      {
        date: "2026-08-28",
        morning: [
          { kind: "mirror-write", path: "mirrors/posthog-weekly.md", content: POSTHOG_REGRESSION },
        ],
        evening: [],
      },
      // Sat 08-29: numbers hold at the regression (no recovery yet).
      {
        date: "2026-08-29",
        morning: [
          { kind: "mirror-write", path: "mirrors/posthog-weekly.md", content: POSTHOG_REGRESSION },
        ],
        evening: [],
      },
      // Sun 08-30: recovery is CONDITIONAL - it fires only if a fix PR landed.
      {
        date: "2026-08-30",
        morning: [
          {
            kind: "mirror-write",
            path: "mirrors/posthog-weekly.md",
            content: POSTHOG_RECOVERED,
            when: fixLanded,
          },
        ],
        evening: [],
      },
    ],
  };
}

/** A deterministic replay script for the REPLAY tier: the radar's run creates the
 *  follow-up on the day the release lands, and the follow-up run escalates on the
 *  regression day (fix task + question task) and lands a real fix PR. Keyed by
 *  task id; only the radar id is stable (dynamically-created follow-ups are not
 *  replayed, so the replay tier proves the radar mechanism, not the full arc). */
export const MINI_W3_REPLAY: Record<string, string[][]> = {
  [RELEASE_RADAR_ID]: [
    ["note", RELEASE_RADAR_ID, "read releases.md; nothing new yet - clean stop"],
  ],
};
