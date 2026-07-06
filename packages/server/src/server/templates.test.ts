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

  test('ships exactly the default templates', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      'dependency-triage',
      'docs-sweep',
      'error-sweep',
      'follow-up-tracker',
      'housekeeper',
      'market-research',
      'react-doctor',
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
    expect(mr.label).toBe('Market Research')
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
    expect(ds.label).toBe('Docs Sweep')
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
    expect(hk.label).toBe('Housekeeper')
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
})
