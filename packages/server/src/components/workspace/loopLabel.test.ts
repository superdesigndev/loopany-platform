import { describe, expect, it } from 'vitest'

import { isDeletedLoop, loopLabel } from './loopLabel'

/**
 * How a loop reference reads on screen. Pure, and worth its own file because the
 * three screens that print a watcher or a creator all read through it — the
 * whole point is that a group heading, a board card and a drawer row cannot say
 * three different things about the same loop.
 */

describe('loopLabel — name first, id as the fallback', () => {
  it('prefers the resolved name whichever world answered', () => {
    expect(loopLabel({ id: 'loop-605e39', title: 'Housekeeper', source: 'kernel' })).toBe('Housekeeper')
    expect(loopLabel({ id: 'loop-mqkxn6lq-4c81d1b2', title: 'React Doctor', source: 'prod' })).toBe('React Doctor')
  })

  it('falls back to the id — the mixed id world is paid for by rendering names, not by aliasing them', () => {
    expect(loopLabel({ id: 'loop-605e39', title: null, source: 'prod' })).toBe('loop-605e39')
    expect(loopLabel(null, 'loop-605e39')).toBe('loop-605e39')
    expect(loopLabel(undefined)).toBe('')
  })

  /**
   * A production loop can be hard-deleted while tasks still name it (no foreign
   * key, nothing cascades). The reference then dangles, and a bare id would read
   * as any other unnamed loop — so the tombstone says what actually happened.
   */
  it('names a deleted loop as deleted, and marks it un-openable', () => {
    const gone = { id: 'loop-gone', title: null, source: 'missing' } as const
    expect(loopLabel(gone)).toBe('deleted loop loop-gone')
    expect(isDeletedLoop(gone)).toBe(true)
    expect(isDeletedLoop({ id: 'loop-a', title: 'A', source: 'prod' })).toBe(false)
    expect(isDeletedLoop(null)).toBe(false)
  })
})
