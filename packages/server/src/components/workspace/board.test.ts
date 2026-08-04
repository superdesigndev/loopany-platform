import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { isDraggable, legalMove } from './board'
import type { BoardColumnKey, TaskCard } from './api'

/**
 * The drag legality guard.
 *
 * The rule under test is not "which drops feel natural" — it is "which drops
 * correspond to a legal HUMAN ENTRANCE that already exists in the kernel".
 * There are exactly two (`close`, and the `watcher` PATCH), so the interesting
 * assertions are the REFUSALS: every other drop must be refused here, with a
 * reason, rather than fired at the server to see what happens.
 *
 * NB the source-reading guard at the bottom keeps the path in a VARIABLE — Vite
 * statically rewrites the literal `new URL('./x', import.meta.url)` form into an
 * asset URL, which `fileURLToPath` then rejects.
 */

const COLUMNS: BoardColumnKey[] = ['waiting', 'unclaimed', 'due', 'watched', 'closed']

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'task-1', title: 'Verify the nightly backup', status: 'open', followUpAt: null, pendingQuestion: null,
  watcher: 'loop-a', createdByLoop: 'loop-b', createdAt: '', updatedAt: '', due: false, column: 'watched', ...over,
})

describe('close — the one task transition', () => {
  it('is legal from any open column and demands the note the kernel requires', () => {
    for (const column of ['unclaimed', 'due', 'watched'] as BoardColumnKey[]) {
      expect(legalMove(card({ column, watcher: column === 'unclaimed' ? null : 'loop-a' }), 'closed')).toEqual({ ok: true, verb: 'close', needsNote: true })
    }
  })

  it('is refused while a question is waiting — the kernel refuses it too (OPEN_QUESTION)', () => {
    const verdict = legalMove(card({ column: 'waiting', pendingQuestion: 'revert or wait?' }), 'closed')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/answer it in the inbox/)
  })
})

describe('release — the watcher facet, cleared', () => {
  it('is legal for a watched card dropped on the pool', () => {
    expect(legalMove(card({ column: 'watched', watcher: 'loop-a' }), 'unclaimed')).toEqual({ ok: true, verb: 'release', needsNote: false })
    expect(legalMove(card({ column: 'due', watcher: 'loop-a' }), 'unclaimed')).toEqual({ ok: true, verb: 'release', needsNote: false })
  })

  it('is refused when there is no watcher to release', () => {
    const verdict = legalMove(card({ column: 'waiting', watcher: null, pendingQuestion: 'ask?' }), 'unclaimed')
    expect(verdict.ok).toBe(false)
  })
})

describe('the refusals — a drop with no kernel transition behind it', () => {
  it('never lets a closed card move: close is one-way and there is no reopen', () => {
    for (const to of COLUMNS) {
      expect(legalMove(card({ column: 'closed', status: 'closed' }), to).ok, `closed → ${to}`).toBe(false)
    }
    expect(isDraggable(card({ column: 'closed', status: 'closed' }), COLUMNS)).toBe(false)
  })

  it('never lets a human ask themself a question', () => {
    const verdict = legalMove(card({ column: 'watched' }), 'waiting')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/asked by a run/)
  })

  it('refuses due ↔ watched: a drop carries no follow-up date', () => {
    expect(legalMove(card({ column: 'watched' }), 'due').ok).toBe(false)
    expect(legalMove(card({ column: 'due' }), 'watched').ok).toBe(false)
  })

  it('refuses a claim by drop, because a column cannot name a loop', () => {
    const verdict = legalMove(card({ column: 'unclaimed', watcher: null }), 'watched')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/claim picker/)
  })

  it('treats a same-column drop as a no-op, not an error to shout about', () => {
    expect(legalMove(card({ column: 'watched' }), 'watched')).toEqual({ ok: false, reason: 'it is already here' })
  })
})

describe('isDraggable — a card never suggests a destination it has not got', () => {
  it('is true for an open card with at least one legal move', () => {
    expect(isDraggable(card({ column: 'watched', watcher: 'loop-a' }), COLUMNS)).toBe(true)
    expect(isDraggable(card({ column: 'unclaimed', watcher: null }), COLUMNS)).toBe(true)
  })

  it('is false for a question card with no watcher — it can neither close nor release', () => {
    expect(isDraggable(card({ column: 'waiting', watcher: null, pendingQuestion: 'ask?' }), COLUMNS)).toBe(false)
  })
})

describe('the board invents no write path', () => {
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
})
