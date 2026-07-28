import type { TemplateRating } from '../types'

/**
 * Editorial per-template ratings for the public template list (round 6) — the SINGLE
 * source, keyed by template name. Merged onto each `TemplateInfo` in `templates.ts`.
 *
 * Three dimensions (see `TemplateRating`): ease of getting started, cycle & mechanism
 * (cadence short/long + open/closed loop), and effect visibility (bucket + one honest
 * line). Assigned by hand from each template's REAL mechanics and kept honest — heavy
 * setups are `advanced`, monitors that stay quiet until they fire are `compounds`, etc.
 *
 * Invariant (pinned by `templateRatings.test.ts`): every shipped template has an entry,
 * and `mechanism` agrees with the catalog's open/closed distinction — the "Others"
 * category templates are `closed`, everything else is `open`.
 */
export const TEMPLATE_RATINGS: Record<string, TemplateRating> = {
  // ── Code Health ─────────────────────────────────────────────
  'docs-sweep': {
    ease: 'moderate',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'few-runs',
    visibilityNote: 'Each caught drift lands as a PR; a well-kept codebase may take a few sweeps to surface one.',
    schedule: "Weekly · Mon ~6am",
  },
  'error-sweep': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'As soon as real production errors exist, the first sweep root-causes them into PRs.',
    schedule: "Daily · ~6am",
  },
  'react-doctor': {
    ease: 'easy',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'The first scan fixes the worst issue and reports a health score the same morning.',
    schedule: "Daily · ~6am",
  },
  housekeeper: {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'few-runs',
    visibilityNote: 'One proven cleanup a day; the codebase gets visibly tidier over a week or two.',
    schedule: "Daily · ~7am",
  },
  'dependency-triage': {
    ease: 'moderate',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'If you have open dependency PRs, the first triage clears the provably-safe ones.',
    schedule: "Weekly · Mon",
  },

  // ── Ship with Confidence ────────────────────────────────────
  'test-guardian': {
    ease: 'moderate',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'few-runs',
    visibilityNote: 'One meaningful test per week; coverage climbs steadily rather than overnight.',
    schedule: "Weekly · Mon ~6am",
  },
  'security-sweep': {
    ease: 'moderate',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'The first sweep surfaces existing advisories and unpinned CI actions right away.',
    schedule: "Weekly · Mon ~6am",
  },
  'ci-doctor': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'few-runs',
    visibilityNote: 'Fixes the worst flaky or slow offender each day; a healthier pipeline emerges over a week.',
    schedule: "Daily · ~7am",
  },

  // ── Growth ──────────────────────────────────────────────────
  'market-research': {
    ease: 'easy',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'A dated market report lands the very first morning.',
    schedule: "Daily · ~5am",
  },
  'reddit-karma': {
    ease: 'advanced',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'compounds',
    visibilityNote: 'Karma builds slowly from genuinely useful comments; expect weeks, and a real knowledge base to assemble first.',
    schedule: "Many slots across your active hours",
  },
  'changelog-broadcaster': {
    ease: 'easy',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: "The first run drafts a changelog and social posts from the week's merges.",
    schedule: "Weekly · Mon ~9am",
  },

  // ── Business Ops ────────────────────────────────────────────
  'support-triage': {
    ease: 'advanced',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'Heavy wiring up front (inbox + debugging stack); once connected, the first run triages real tickets.',
    schedule: "Always-on (polls for new messages)",
  },
  'metrics-digest': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'A KPI digest lands the first morning once read access is wired.',
    schedule: "Daily · ~8am",
  },
  'funnel-watch': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'compounds',
    visibilityNote: 'Quiet by design; its worth shows the day it catches a real conversion drop with the evidence.',
    schedule: "Daily · ~8am",
  },

  // ── Personal ────────────────────────────────────────────────
  'morning-briefing': {
    ease: 'easy',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'A full briefing arrives the very first morning.',
    schedule: "Daily · ~6am",
  },
  'homebrew-updater': {
    ease: 'easy',
    cadence: 'long',
    mechanism: 'open',
    visibility: 'few-runs',
    visibilityNote: 'Keeps tools current quietly; you mostly notice it when it holds back a risky major.',
    schedule: "Weekly (your choice)",
  },
  'daily-lesson': {
    ease: 'easy',
    cadence: 'short',
    mechanism: 'open',
    visibility: 'first-run',
    visibilityNote: 'Your first lesson arrives the next morning; the arc compounds from there.',
    schedule: "Daily · ~7am",
  },

  // ── Others (closed, goal-bound) ─────────────────────────────
  'follow-up-tracker': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'closed',
    visibility: 'first-run',
    visibilityNote: 'Reports what it observes from the first run and finishes once the outcome is confirmed.',
    schedule: "A few runs per day (you set it)",
    exitCondition: "Finishes once the tracked outcome is confirmed.",
  },
  'outcome-watch': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'closed',
    visibility: 'few-runs',
    visibilityNote: 'Tracks the metric against the verdict each run; the payoff is the conclusive pass/fail at the end.',
    schedule: "Fits the metric (you set it)",
    exitCondition: "Finishes when the metric reaches the verdict, or the decision window closes.",
  },
  'bug-vigil': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'closed',
    visibility: 'compounds',
    visibilityNote: 'Waits out an intermittent bug; the capture can take days or weeks until it recurs.',
    schedule: "Patrol cadence (you set it)",
    exitCondition: "Finishes on one clean capture of the bug (or a bounded give-up window).",
  },
  'release-shepherd': {
    ease: 'moderate',
    cadence: 'short',
    mechanism: 'closed',
    visibility: 'first-run',
    visibilityNote: 'The first readiness pass flags drift immediately; it finishes on release day.',
    schedule: "Daily until release day",
    exitCondition: "Finishes when the release ships or is formally called off.",
  },
}
