/**
 * The file-based template registry (server/templates.ts). It's built from a Vite glob
 * over skill/templates/*​/meta.json, so this asserts the registry is populated, every
 * entry satisfies the slimmed TemplateInfo shape (name/label/desc + a non-empty canned
 * `description` that rides the bootstrap snippet), and each of the three default
 * templates is present and expresses its guardrails. Adding a template is pure content
 * (a new folder); the shape tests then cover it automatically.
 */
import { describe, expect, test } from 'vitest'

import { TEMPLATES } from './templates'
import type { TemplateInfo } from '../types'

describe('template registry', () => {
  test('is non-empty and every entry has the TemplateInfo shape', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0)
    for (const t of TEMPLATES) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.label).toBe('string')
      expect(t.label.length).toBeGreaterThan(0)
      // The card blurb and the canned task description are both required + non-empty:
      // the description is the INTENT appended to the bootstrap snippet, so an empty
      // one would ship a template that pastes nothing to build.
      expect(typeof t.desc).toBe('string')
      expect(t.desc.trim().length).toBeGreaterThan(0)
      expect(typeof t.description).toBe('string')
      expect(t.description.trim().length).toBeGreaterThan(0)
    }
  })

  test('names are unique', () => {
    const names = TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('ships exactly the default templates, in the curated card order', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      // Code Health
      'docs-sweep',
      'error-sweep',
      'react-doctor',
      'housekeeper',
      'dependency-triage',
      // Ship with Confidence
      'test-guardian',
      'security-sweep',
      'ci-doctor',
      // Growth
      'market-research',
      'reddit-karma',
      'changelog-broadcaster',
      // Business Ops
      'support-triage',
      'metrics-digest',
      'funnel-watch',
      // Personal
      'morning-briefing',
      'homebrew-updater',
      'daily-lesson',
      // Others (individually-created, closed loops)
      'follow-up-tracker',
      'outcome-watch',
      'bug-vigil',
      'release-shepherd',
    ])
  })

  test('ships the React Doctor template (v1) with its guardrails in the description', () => {
    const rd = TEMPLATES.find((t) => t.name === 'react-doctor') as TemplateInfo
    expect(rd).toBeTruthy()
    expect(rd.label).toBe('React Doctor')
    const d = rd.description
    // The canned intent must express the non-obvious rules (the create flow handles
    // cadence/config on its own, but these are the loop's defining behaviors).
    expect(d).toContain('npx react-doctor@latest')
    expect(d).toContain('worktree') // fresh worktree off main — never dirty the checkout
    expect(d.toLowerCase()).toContain('unmerged') // no-stacking rule
    expect(d.toLowerCase()).toContain('kanban') // open/merged board
    expect(d.toLowerCase()).toContain('score') // daily health score
  })

  test('ships the Market Research template with its defining behaviors in the description', () => {
    const mr = TEMPLATES.find((t) => t.name === 'market-research') as TemplateInfo
    expect(mr).toBeTruthy()
    expect(mr.label).toBe('Market Monitor')
    const d = mr.description.toLowerCase()
    expect(d).toContain('confirm') // propose a focus, confirm before creating
    expect(d).toContain('type: report') // front-matter convention for the calendar view
    expect(d).toContain('calendar') // reports ride the calendar; dashboard shows one
    expect(d).toContain('one dated markdown report') // exactly one report per day
  })

  test('ships the Dependency Triage template with its defining behaviors in the description', () => {
    const dt = TEMPLATES.find((t) => t.name === 'dependency-triage') as TemplateInfo
    expect(dt).toBeTruthy()
    expect(dt.label).toBe('Dependency Triage')
    const d = dt.description.toLowerCase()
    expect(d).toContain('smoke test') // verify gh can see dependency PRs before creating
    expect(d).toContain('confirm') // merge authority is propose-then-confirm at create
    expect(d).toContain('review-and-report-only') // the no-authority mode is explicit
    expect(d).toContain('exactly once') // one pass per PR per sweep
    expect(d).toContain('not proof of safety') // version labels are inputs, not proof
    expect(d).toContain('worktree') // tests run in a fresh worktree off main
    expect(d).toContain('kanban') // merged/deferred/blocked board
  })

  test('ships the Docs Sweep template with its defining behaviors in the description', () => {
    const ds = TEMPLATES.find((t) => t.name === 'docs-sweep') as TemplateInfo
    expect(ds).toBeTruthy()
    expect(ds.label).toBe('Doc Maintainer')
    const d = ds.description.toLowerCase()
    expect(d).toContain('worktree') // fresh worktree off main - never dirty the checkout
    expect(d).toContain('unmerged') // no-stacking rule
    expect(d).toContain('since the previous sweep') // scope = drift since the last sweep
    expect(d).toContain('never rewrite accurate docs') // anti-busywork guard
    expect(d).toContain('drift count') // per-run metric; zero is a clean stop
  })

  test('ships the Housekeeper template with its defining behaviors in the description', () => {
    const hk = TEMPLATES.find((t) => t.name === 'housekeeper') as TemplateInfo
    expect(hk).toBeTruthy()
    expect(hk.label).toBe('Tech Debt Cleanup')
    const d = hk.description.toLowerCase()
    expect(d).toContain('one candidate') // one proven cleanup per day
    expect(d).toContain('low-risk') // prove safety with concrete evidence first
    expect(d).toContain('uncommitted') // protect active/uncommitted/generated/uncertain work
    expect(d).toContain('worktree') // fresh worktree off main - never dirty the checkout
    expect(d).toContain('unmerged') // no-stacking rule
    expect(d).toContain('deferred-candidates') // uncertain items are listed, never deleted
    expect(d).toContain('kanban') // open/merged cleanup board
    expect(d).toContain('cleanups landed') // the daily metric
  })

  test('ships the Error Sweep template with its defining behaviors in the description', () => {
    const es = TEMPLATES.find((t) => t.name === 'error-sweep') as TemplateInfo
    expect(es).toBeTruthy()
    expect(es.label).toBe('Error Sweep')
    const d = es.description.toLowerCase()
    expect(d).toContain('smoke-test') // verify a real way to read errors before creating
    expect(d).toContain('blind loop') // refuse when nothing can be observed
    expect(d).toContain('confirm it with me') // source + sweep window are propose-then-confirm
    expect(d).toContain('agreed window') // each sweep covers the window agreed at create
    expect(d).toContain('worktree') // fresh worktree off main - never dirty the checkout
    expect(d).toContain('unmerged') // no-stacking rule
    expect(d).toContain('credentials') // logs are production data - never copy secrets/PII
    expect(d).toContain('type: report') // dated reports ride the calendar convention
    expect(d).toContain('actionable-error count') // the daily metric; clean stop at zero
  })

  test('ships the Follow-up Tracker template with its defining behaviors in the description', () => {
    const ft = TEMPLATES.find((t) => t.name === 'follow-up-tracker') as TemplateInfo
    expect(ft).toBeTruthy()
    expect(ft.label).toBe('Follow-up Tracker')
    const d = ft.description.toLowerCase()
    expect(d).toContain('smoke test') // verify a real observation path before creating
    expect(d).toContain('blind loop') // refuse when nothing can be observed
    expect(d).toContain('closed') // created closed, with a goal
    expect(d).toContain('finish condition') // the goal is a concrete finish line
    // The paste-right-after-shipping invocation is the card's job, not the snippet's.
    expect(ft.desc.toLowerCase()).toContain('after finishing the task')
  })

  test('ships the Reddit Karma template with its defining behaviors in the description', () => {
    const rk = TEMPLATES.find((t) => t.name === 'reddit-karma') as TemplateInfo
    expect(rk).toBeTruthy()
    expect(rk.label).toBe('Reddit Karma')
    const d = rk.description
    const l = d.toLowerCase()
    // KB gate: two-branch, and never invent opinions.
    expect(l).toContain('knowledge base')
    expect(l).toContain('documented') // cite documented positions, never reconstruct
    // The Reddit interface is opencli (concrete), verified before creating.
    expect(l).toContain('opencli')
    expect(l).toContain('sign-off') // explicit owner sign-off on the account
    // Shared-account ledger as a real file, read-before / append-after.
    expect(l).toContain('ledger')
    expect(l).toContain('>=21') // the per-account spacing floor
    // Subreddit boundary is derived, not a fixed list.
    expect(l).toContain('boundary')
    expect(l).toContain('broaden-into')
    // The pure-value firewall + draft-first default.
    expect(l).toContain('pure value only')
    expect(l).toContain('draft-for-review')
    // The anti-AI writing rules are the hard-won differentiator.
    expect(l).toContain('em-dash')
    expect(d).toContain('written by ChatGPT') // the #1 AI tell it guards against
  })
})

/**
 * The 12 templates added in the bundle-catalog expansion (round 4). Each must carry the
 * house-style disciplines in its description: confirm-with-me / never-a-blind-loop smoke
 * tests, fresh-worktree hygiene for repo work, one-PR-at-a-time etiquette, front-matter
 * typed cards, a per-run metric, dashboard-at-creation, and draft/report-only defaults
 * for outward-facing or risky work. These pin each new template's defining behaviors.
 */
describe('bundle-catalog expansion (round 4)', () => {
  const find = (name: string): TemplateInfo => {
    const t = TEMPLATES.find((x) => x.name === name)
    expect(t, `${name} should exist`).toBeTruthy()
    return t as TemplateInfo
  }

  test('Test Guardian - one solid test on the riskiest untested path, worktree + PR', () => {
    const d = find('test-guardian').description.toLowerCase()
    expect(d).toContain('never create a blind loop')
    expect(d).toContain('riskiest')
    expect(d).toContain('worktree')
    expect(d).toContain('unmerged') // no-stacking
    expect(d).toContain('kanban')
    expect(d).toContain('coverage')
  })

  test('Security Sweep - advisories/secrets/pins, provably-safe only, report-only sensitive', () => {
    const d = find('security-sweep').description.toLowerCase()
    expect(d).toContain('smoke-test')
    expect(d).toContain('advisories')
    expect(d).toContain('secret')
    expect(d).toContain('provably-safe')
    expect(d).toContain('report-only')
    expect(d).toContain('worktree')
    expect(d).toContain('never copy the secret')
  })

  test('CI Doctor - flaky/slow CI, fix or quarantine (never silent deletion)', () => {
    const d = find('ci-doctor').description.toLowerCase()
    expect(d).toContain('smoke test')
    expect(d).toContain('flaky')
    expect(d).toContain('quarantine')
    expect(d).toContain('never a silent deletion')
    expect(d).toContain('worktree')
    expect(d).toContain('pass rate')
  })

  test('Changelog Broadcaster - distill merged PRs, drafts held for review, never auto-post', () => {
    const d = find('changelog-broadcaster').description.toLowerCase()
    expect(d).toContain('smoke test')
    expect(d).toContain('since the previous run') // incremental scope
    expect(d).toContain('draft held for my review')
    expect(d).toContain('never auto-post')
    expect(d).toContain('type: report') // calendar-riding entries
    expect(d).toContain('items shipped')
  })

  test('Metrics Digest - confirm KPI + read access, read-only, flags anomalies plainly', () => {
    const d = find('metrics-digest').description.toLowerCase()
    expect(d).toContain('never create a blind loop')
    expect(d).toContain('read access')
    expect(d).toContain('read-only always')
    expect(d).toContain('anomaly')
    expect(d).toContain('type: report')
    expect(d).toContain('kpi')
  })

  test('Funnel Watch - alert on real drops with evidence, quiet when healthy, read-only', () => {
    const d = find('funnel-watch').description.toLowerCase()
    expect(d).toContain('smoke test')
    expect(d).toContain('conversion rate')
    expect(d).toContain('evidence')
    expect(d).toContain('stay quiet') // quiet when healthy
    expect(d).toContain('read-only always')
  })

  test('Morning Briefing - confirmed sources, grounded not fabricated, dated calendar report', () => {
    const d = find('morning-briefing').description.toLowerCase()
    expect(d).toContain('never create a blind loop')
    expect(d).toContain('weather')
    expect(d).toContain('calendar')
    expect(d).toContain('smoke-tested') // each source verified
    expect(d).toContain('never pad or fabricate')
    expect(d).toContain('type: report')
  })

  test('Homebrew Updater - pre-authorized allowlist only, verify key tools, majors report-only', () => {
    const d = find('homebrew-updater').description.toLowerCase()
    expect(d).toContain('brew outdated')
    expect(d).toContain('pre-authorized')
    expect(d).toContain('allowlist')
    expect(d).toContain('report-only')
    expect(d).toContain('rollback')
    expect(d).toContain('outdated-package count')
  })

  test('Daily Lesson - topic chosen at setup, builds on prior lessons, dated calendar report', () => {
    const d = find('daily-lesson').description.toLowerCase()
    expect(d).toContain('confirm it with me')
    expect(d).toContain('builds on')
    expect(d).toContain('never repeats')
    expect(d).toContain('type: report')
    expect(d).toContain('calendar')
    expect(d).toContain('never invent facts')
  })

  test('Outcome Watch - measurable verdict, closed with a finish condition, differentiated from follow-up', () => {
    const d = find('outcome-watch').description.toLowerCase()
    expect(d).toContain('sibling of the follow-up tracker') // explicit differentiation
    expect(d).toContain('smoke test')
    expect(d).toContain('conclusive-verdict finish condition')
    expect(d).toContain('create the loop closed')
    expect(d).toContain('finish the loop')
    // Card desc pins the paste-after-it-goes-live invocation.
    expect(find('outcome-watch').desc.toLowerCase()).toContain('right after the change goes live')
  })

  test('Bug Vigil - stake out one bug, capture full context on recurrence, then finish', () => {
    const d = find('bug-vigil').description.toLowerCase()
    expect(d).toContain('do not create a blind loop')
    expect(d).toContain('recurrence')
    expect(d).toContain('stack trace')
    expect(d).toContain('create the loop closed')
    expect(d).toContain('finish the loop')
    expect(d).toContain('never copy credentials')
  })

  test('Release Shepherd - bound to one release/date, daily checklist, report-only, final go/no-go', () => {
    const d = find('release-shepherd').description.toLowerCase()
    expect(d).toContain('target date')
    expect(d).toContain('checklist')
    expect(d).toContain('rollback')
    expect(d).toContain('report-only')
    expect(d).toContain('create the loop closed')
    expect(d).toContain('go/no-go')
    expect(d).toContain('finish the loop')
  })
})
