import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { cardActions, hasActions, tellMode } from './board'
import type { TaskCard } from './api'

/**
 * Which actions a card offers.
 *
 * The rule under test is not "which moves feel natural" — it is "which acts
 * correspond to a human entrance that already exists in the kernel". There are
 * exactly two: TELL (the composer, which answers a pending question and
 * otherwise leaves a directive) and the `watcher` PATCH — TRANSFER only, since
 * the watcher rule made a null watcher a refusal. The board offers no drag path,
 * so a write can only happen through one of them.
 *
 * CLOSE IS DELIBERATELY ABSENT (captain direction 2026-08-04) and its absence is
 * asserted, not merely unexercised: a task ends when its WATCHER closes it, so a
 * human close here would settle the record while the external world it describes
 * carried on unchanged.
 *
 * NB the source-reading guard at the bottom keeps the path in a VARIABLE — Vite
 * statically rewrites the literal `new URL('./x', import.meta.url)` form into an
 * asset URL, which `fileURLToPath` then rejects.
 */

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'task-1', title: 'Verify the nightly backup', status: 'open', followUpAt: null, pendingQuestion: null,
  watcher: 'loop-a', createdByLoop: 'loop-b', createdAt: '', updatedAt: '', due: false, column: 'watched', ...over,
})

describe('tell — one composer, two conversations', () => {
  it('is offered on any open card, question or not', () => {
    expect(cardActions(card({ column: 'watched' })).canTell).toBe(true)
    expect(cardActions(card({ column: 'due', followUpAt: '2026-01-01T00:00:00.000Z', due: true })).canTell).toBe(true)
    expect(cardActions(card({ column: 'waiting', pendingQuestion: 'revert or wait?' })).canTell).toBe(true)
  })

  it('is withheld on a closed card: there is no run to queue for a conversation about a record', () => {
    expect(cardActions(card({ column: 'closed', status: 'closed' })).canTell).toBe(false)
  })

  // The two modes ride ONE affordance because they are one write from the
  // person's side: free text that queues one run for the watcher.
  it('answers while a question is pending, and otherwise leaves a directive', () => {
    expect(tellMode(card({ pendingQuestion: 'revert or wait?' }))).toBe('answer')
    expect(tellMode(card({ pendingQuestion: null }))).toBe('directive')
    // Whitespace is not a question — the kernel reads it the same way
    // (`hasOpenQuestion` trims), so the two surfaces cannot disagree.
    expect(tellMode(card({ pendingQuestion: '   ' }))).toBe('directive')
  })
})

describe('close is not an action this screen offers', () => {
  // Structural, not incidental: the property is that the UI has no close path at
  // all, so a later "helpful" re-add has to defeat a named assertion.
  it('exposes no close affordance, under any name', () => {
    const source = readFileSync(fileURLToPath(new URL('./board.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/canClose/)
    expect(Object.keys(cardActions(card()))).toEqual(['canTell'])
  })

  it('is not reachable from the data layer either — there is no postClose', () => {
    const source = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/export async function postClose/)
    expect(source).not.toMatch(/'POST', \{ note \}/)
    // The directive endpoint replaces it: a task ends by the watcher closing it.
    expect(source).toMatch(/export async function postDirective/)
  })
})

/**
 * THE WATCHER IS NOT AN ACTION (captain ruling 2026-08-05). The drawer used to
 * carry a picker that handed a task to a different loop, and the whole surface
 * is gone — not disabled, not hidden — along with the kernel capability behind
 * it. What is asserted here is the ABSENCE, structurally, because the failure
 * mode is somebody re-deriving a picker from the shape of the module.
 */
describe('the watcher facet is not an action at all', () => {
  it('offers only `tell`, on any open task', () => {
    expect(cardActions(card({ column: 'watched', watcher: 'loop-a' }))).toEqual({ canTell: true })
    expect(cardActions(card({ column: 'due', watcher: 'loop-a' }))).toEqual({ canTell: true })
    expect(cardActions(card({ column: 'waiting', watcher: 'loop-a', pendingQuestion: 'revert or wait?' }))).toEqual({ canTell: true })
  })

  it('offers nothing on a closed card — it is a record', () => {
    expect(cardActions(card({ column: 'closed', status: 'closed', watcher: 'loop-a' }))).toEqual({ canTell: false })
  })

  // TRANSFER AND RELEASE ARE BOTH GONE: the kernel refuses a watcher rewrite
  // (WATCHER_IMMUTABLE) and a null watcher (WATCHER_REQUIRED), so an affordance
  // for either would advertise a write that cannot succeed.
  it('has no transfer, claim or release affordance anywhere in the module', () => {
    const source = readFileSync(fileURLToPath(new URL('./board.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/canRelease|canClaim|canTransfer/)
  })
})

describe('hasActions — a card shows no empty action bar', () => {
  it('is true for any open card', () => {
    expect(hasActions(card({ column: 'watched', watcher: 'loop-a' }))).toBe(true)
    expect(hasActions(card({ column: 'waiting', pendingQuestion: 'ask?' }))).toBe(true)
  })

  it('is false for a closed card', () => {
    expect(hasActions(card({ column: 'closed', status: 'closed' }))).toBe(false)
  })
})

describe('the screen invents no write path', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('reaches the kernel only through the endpoints the CLI already uses', () => {
    const source = read('./api.ts')
    // Every URL literal in the data layer, whether quoted or a template.
    const endpoints = [...source.matchAll(/[`'](\/[^`']*)[`']/g)].map((m) => m[1]!)
    expect(endpoints.length).toBeGreaterThan(5)
    for (const endpoint of endpoints) {
      expect(endpoint.startsWith('/api/'), `${endpoint} must be an existing /api endpoint`).toBe(true)
    }
    expect(source).toMatch(/\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/directive/)
  })

  it('performs no write from the pane except through those helpers', () => {
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/fetch\(/)
  })

  /**
   * Captain direction (2026-08-04): every write moved into the drawer, so a row
   * and a card are pure entrances. The guard is structural — the on-card action
   * bar and its class are gone, and the three writes are reachable only from the
   * drawer's `TaskActions`.
   */
  it('offers no action on a row or a card — the write surface is the drawer', () => {
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/board-card-actions/)
    const card = pane.slice(pane.indexOf('function BoardCard'), pane.indexOf('function ExternalItems'))
    expect(card).not.toMatch(/postDirective|postVerdict/)
    const row = pane.slice(pane.indexOf('function TaskRowEntry'), pane.indexOf('function Column'))
    expect(row).not.toMatch(/postDirective|postVerdict/)
    const actions = pane.slice(pane.indexOf('function TaskActions'))
    expect(actions).toMatch(/TellBox/)
  })

  /**
   * Captain direction (2026-08-04): the close action leaves the drawer
   * entirely. Asserted on the SOURCE rather than only through a rendered pass,
   * because the failure mode is somebody adding it back in one of several
   * places — a button, a dialog, a helper — and any of them would match here.
   */
  it('has no close control, dialog or call anywhere in the pane', () => {
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/CloseNote|onAskClose|postClose|pendingClose/)
    expect(pane).not.toMatch(/close…/)
    expect(pane).not.toMatch(/ws-close-note/)
  })

  // The board is a read layout plus buttons, by product decision: no card is
  // draggable, no column is a drop target, and nothing may quietly reintroduce
  // one — a drop carries no note, no loop id and no date, so every write here
  // needs a labelled control anyway.
  it('has no drag-and-drop surface at all — in either view', () => {
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/draggable|onDrag[A-Z]|onDrop|dataTransfer/)
  })

  /**
   * The watcher rule at the wire: the data layer cannot EXPRESS a watcher write
   * of any kind — not a transfer, not a release. The removal is real rather than
   * cosmetic, so there is no helper for the drawer to call back into.
   */
  it('has no watcher write helper at all — hand-off is not a thing today', () => {
    const source = read('./api.ts')
    expect(source).not.toMatch(/transferWatcher|patchWatcher/)
    // No PATCH to a task from this client either: the watcher facet was its only
    // caller, so a new one would be a new capability, not a reuse.
    expect(source).not.toMatch(/'PATCH'/)
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/transferWatcher|hand off/i)
  })
})
