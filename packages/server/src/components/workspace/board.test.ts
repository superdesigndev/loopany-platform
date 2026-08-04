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
 * exactly two (`close`, and the `watcher` PATCH — TRANSFER only, since the
 * watcher rule made a null watcher a refusal), each an explicit button; the
 * board offers no drag path, so a write can only happen through one of them.
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
    expect(cardActions(card({ column: 'due', followUpAt: '2026-01-01T00:00:00.000Z', due: true })).canClose).toBe(true)
  })

  it('is withheld while a question is waiting — the kernel refuses it too (OPEN_QUESTION)', () => {
    expect(cardActions(card({ column: 'waiting', pendingQuestion: 'revert or wait?' })).canClose).toBe(false)
  })

  it('is withheld on a closed card: close is one-way and there is no reopen', () => {
    expect(cardActions(card({ column: 'closed', status: 'closed' })).canClose).toBe(false)
  })
})

describe('transfer — the watcher facet, one direction only', () => {
  it('is offered on any open task, because every task already has a watcher', () => {
    expect(cardActions(card({ column: 'watched', watcher: 'loop-a' })).canTransfer).toBe(true)
    expect(cardActions(card({ column: 'due', watcher: 'loop-a' })).canTransfer).toBe(true)
  })

  // Consequential (the eventual answer wakes whichever loop is watching when it
  // lands) but deliberate: a labelled picker on one named task, not a gesture
  // that can be made by accident. There is no drag surface to green-light it.
  it('is offered on a waiting task too — an explicit act, not a spatial one', () => {
    expect(cardActions(card({ column: 'waiting', watcher: 'loop-a', pendingQuestion: 'revert or wait?' })).canTransfer).toBe(true)
  })

  it('offers nothing on a closed card — it is a record', () => {
    const closed = cardActions(card({ column: 'closed', status: 'closed', watcher: 'loop-a' }))
    expect(closed).toEqual({ canClose: false, canTransfer: false })
  })

  // RELEASE IS GONE, not merely unused: `watcher: null` is a kernel refusal
  // (WATCHER_REQUIRED), so an affordance for it would advertise a write that
  // cannot succeed.
  it('has no release affordance anywhere in the module', () => {
    const source = readFileSync(fileURLToPath(new URL('./board.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/canRelease|canClaim/)
    expect(Object.keys(cardActions(card()))).toEqual(['canClose', 'canTransfer'])
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
    expect(card).not.toMatch(/onTransfer|onAskClose|transferWatcher|postClose/)
    const row = pane.slice(pane.indexOf('function TaskRowEntry'), pane.indexOf('function Column'))
    expect(row).not.toMatch(/onTransfer|onAskClose|transferWatcher|postClose/)
    const actions = pane.slice(pane.indexOf('function TaskActions'))
    for (const act of ['onTransfer', 'onAskClose']) expect(actions).toMatch(new RegExp(act))
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
   * The watcher rule at the wire: the data layer can no longer EXPRESS a
   * release. `transferWatcher` takes a plain `string`, so a null watcher is a
   * type error at every call site rather than a request the kernel refuses.
   */
  it('cannot send a null watcher — transfer is the only shape the client has', () => {
    const source = read('./api.ts')
    expect(source).toMatch(/export async function transferWatcher\(taskId: string, watcher: string\)/)
    expect(source).not.toMatch(/patchWatcher/)
    const pane = read('./TasksPane.tsx')
    expect(pane).not.toMatch(/transferWatcher\([^)]*null/)
  })
})
