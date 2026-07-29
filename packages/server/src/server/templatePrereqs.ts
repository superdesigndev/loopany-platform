import type { TemplatePrereq } from '../types'

/**
 * Editorial per-template PREREQUISITES for the public detail page — what a loop needs
 * on the machine before it can run well: tools, access, setup pieces. Keyed by
 * template name, like `templateRatings.ts`. NOT every template has an entry — only
 * those with real prerequisites carry the section (an empty checklist is noise).
 *
 * `optional: true` = nice-to-have; absent = the loop needs it. A link renders INSIDE
 * the description via `linkLabel` (context first, then the jump); keep links few and
 * load-bearing.
 */
const VERIFIER: TemplatePrereq = {
  label: 'Verifier setup for code changes',
  desc: 'A repo-specific harness so every fix is proven against the real app before a PR.',
  href: 'https://github.com/AI-Builder-Club/skills/tree/main/skills/verifier-setup',
  linkLabel: 'Set it up with the verifier-setup skill',
  optional: true,
}

const TREG = 'https://treg.superdesign.dev'

export const TEMPLATE_PREREQS: Record<string, TemplatePrereq[]> = {
  // ── Growth ──────────────────────────────────────────────────
  'reddit-karma': [
    {
      label: 'Content wiki library',
      desc: 'A curated knowledge base of your own content — the agent only cites positions you documented.',
    },
    {
      label: 'OpenCLI for Reddit operations',
      desc: "Drives Reddit through your own logged-in browser session — no API app, no bot account.",
      href: 'https://github.com/jackwener/opencli',
      linkLabel: 'Get OpenCLI',
    },
    {
      label: 'Workflow trigger',
      desc: 'The deterministic pre-stage that randomizes posting slots so the cadence reads human — built into Loopany, no extra install.',
      optional: true,
    },
  ],

  'seo-scout': [
    {
      label: 'Live Google Search Console read access',
      desc: 'An API script, CLI, or MCP tool that pulls live query data for your site — every verdict reads it.',
      href: TREG,
      linkLabel: 'Manage agent credentials with treg',
    },
    {
      label: 'Your content repo, with a PR flow',
      desc: 'The blog lives in git; every bet ships as one pull request a human merges.',
    },
  ],

  // ── Business Ops ────────────────────────────────────────────
  'support-triage': [
    {
      label: 'CLI / endpoint for your ticketing system',
      desc: 'Read + reply access to the support inbox.',
      href: TREG,
      linkLabel: 'Manage agent credentials with treg',
    },
    {
      label: 'Company wiki',
      desc: 'Product and policy knowledge the triage grounds its replies in.',
    },
    VERIFIER,
  ],
  'metrics-digest': [
    {
      label: 'Access to your DB / product analytics',
      desc: 'Read-only access to where the numbers live (PostHog, warehouse, DB).',
      href: TREG,
      linkLabel: 'Manage agent credentials with treg',
    },
  ],
  'funnel-watch': [
    {
      label: 'Access to your DB / product analytics',
      desc: 'Read-only access to the funnel data.',
      href: TREG,
      linkLabel: 'Manage agent credentials with treg',
    },
  ],

  // ── Codebase Autopilot — every member ships with the verifier + its own tool ──
  'docs-sweep': [VERIFIER],
  'error-sweep': [
    {
      label: 'A readable error source',
      desc: 'Logs, an error tracker, a URL, or gh — the sweep needs somewhere real to read errors from.',
    },
    VERIFIER,
  ],
  'react-doctor': [
    {
      label: 'react-doctor',
      desc: 'The scanner the loop runs each morning — fetched via npx, nothing to install.',
      href: 'https://github.com/millionco/react-doctor',
      linkLabel: 'See what react-doctor checks',
    },
    VERIFIER,
  ],
  housekeeper: [VERIFIER],
  'dependency-triage': [
    {
      label: 'gh with access to your dependency PRs',
      desc: "The triage reads Dependabot/Renovate PRs and each one's CI through gh.",
    },
    VERIFIER,
  ],
}

/** The template's prerequisites, or null when it declares none. */
export function templatePrereqs(name: string): TemplatePrereq[] | null {
  return TEMPLATE_PREREQS[name] ?? null
}
