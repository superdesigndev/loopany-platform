import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { cardActions, hasActions } from './board'
import type { TaskCard } from './api'

/**
 * Which actions a card offers.
 *
 * The rule under test is not "which moves feel natural" — it is "which acts
 * correspond to a human entrance that already exists in the kernel". There are
 * exactly three (`close`, and the `watcher` PATCH in both directions), each an
 * explicit button; the board offers no drag path, so a write can only happen
 * through one of them.
 *
 * NB the source-reading guard at the bottom keeps the path in a VARIABLE — Vite
 * statically rewrites the literal `new URL('./x', import.meta.url)` form into an
 * asset URL, which `fileURLToPath` then rejects.
 */

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'task-1', title: 'Verify the nightly backup', status: 'open', followUpAt: null, pendingQuestion: null,
  watcher: 'loop-a', createdByLoop: 'loop-b', createdAt: '', updatedAt: '', due: false, column: 'watched', ...over,
})

describe('close — the one task transition', () => {
  it('is offered on any open card, watched or not', () => {
    expect(cardActions(card({ column: 'watched' })).canClose).toBe(true)
    expect(cardActions(card({ column: 'unclaimed', watcher: null })).canClose).toBe(true)
    expect(cardActions(card({ column: 'due', followUpAt: '2026-01-01T00:00:00.000Z', due: true })).canClose).toBe(true)
  })

  it('is withheld while a question is waiting — the kernel refuses it too (OPEN_QUESTION)', () => {
    expect(cardActions(card({ column: 'waiting', pendingQuestion: 'revert or wait?' })).canClose).toBe(false)
  })

  it('is withheld on a closed card: close is one-way and there is no reopen', () => {
    expect(cardActions(card({ column: 'closed', status: 'closed' })).canClose).toBe(false)
  })
})

describe('claim and release — the watcher facet, both directions', () => {
  it('offers claim exactly when nobody watches it', () => {
    expect(cardActions(card({ column: 'unclaimed', watcher: null })).canClaim).toBe(true)
    expect(cardActions(card({ column: 'watched', watcher: 'loop-a' })).canClaim).toBe(false)
  })

  it('offers release exactly when somebody does', () => {
    expect(cardActions(card({ column: 'watched', watcher: 'loop-a' })).canRelease).toBe(true)
    expect(cardActions(card({ column: 'due', watcher: 'loop-a' })).canRelease).toBe(true)
    expect(cardActions(card({ column: 'unclaimed', watcher: null })).canRelease).toBe(false)
  })

  // Consequential (the eventual answer would wake no loop) but deliberate: a
  // labelled button on one named card, not a gesture that can be made by
  // accident. There is no drag surface that could green-light it silently.
  it('still offers release on a waiting card — an explicit act, not a spatial one', () => {
    expect(cardActions(card({ column: 'waiting', watcher: 'loop-a', pendingQuestion: 'revert or wait?' })).canRelease).toBe(true)
  })

  it('offers neither on a closed card — it is a record', () => {
    const closed = cardActions(card({ column: 'closed', status: 'closed', watcher: 'loop-a' }))
    expect(closed).toEqual({ canClose: false, canClaim: false, canRelease: false })
  })
})

describe('hasActions — a card shows no empty action bar', () => {
  it('is true for any open card', () => {
    expect(hasActions(card({ column: 'watched', watcher: 'loop-a' }))).toBe(true)
    expect(hasActions(card({ column: 'unclaimed', watcher: null }))).toBe(true)
    expect(hasActions(card({ column: 'waiting', watcher: null, pendingQuestion: 'ask?' }))).toBe(true)
  })

  it('is false for a closed card', () => {
    expect(hasActions(card({ column: 'closed', status: 'closed', watcher: null }))).toBe(false)
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
    expect(source).toMatch(/\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/close/)
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
    const card = pane.slice(pane.indexOf('function BoardCard'), pane.indexOf('function CloseNote'))
    expect(card).not.toMatch(/onClaim|onRelease|onAskClose|patchWatcher|postClose/)
    const row = pane.slice(pane.indexOf('function TaskRowEntry'), pane.indexOf('function Column'))
    expect(row).not.toMatch(/onClaim|onRelease|onAskClose|patchWatcher|postClose/)
    const actions = pane.slice(pane.indexOf('function TaskActions'))
    for (const act of ['onClaim', 'onRelease', 'onAskClose']) expect(actions).toMatch(new RegExp(act))
  })

  // The board is a read layout plus buttons, by product decision: no card is
  // draggable, no column is a drop target, and nothing may quietly reintroduce
  // one — a drop carries no note, no loop id and no date, so every write here
  // needs a labelled control anyway.
  it('has no drag-and-drop surface at all — in either view', () => {
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/draggable|onDrag[A-Z]|onDrop|dataTransfer/)
  })
})
