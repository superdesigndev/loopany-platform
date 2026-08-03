import { describe, expect, it } from 'vitest'

import { DEGRADE_WINDOW_MS, RETRY_MS, WorkspaceLive, shouldRefetch, type LiveDeps, type LiveSignal, type LiveSource } from './live'

/**
 * The freshness state machine, driven with no network and no DOM: resume
 * cursor, `reset`, the two-errors-in-60s degrade, and the `cursorSeq` race
 * guard. Every external is an injected seam, so these assertions are about the
 * contract rather than about a browser's `EventSource` behavior.
 */

class FakeSource implements LiveSource {
  handlers = new Map<string, ((event: { data?: string }) => void)[]>()
  closed = false
  addEventListener(type: string, handler: (event: { data?: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler])
  }
  close() {
    this.closed = true
  }
  fire(type: string, data?: string) {
    for (const handler of this.handlers.get(type) ?? []) handler({ data })
  }
}

function harness(start = 0) {
  const sources: FakeSource[] = []
  const timers: { fn: () => void; ms: number; id: number }[] = []
  const intervals: { fn: () => void; ms: number; id: number }[] = []
  let clock = 1_000
  let next = 1
  const deps: LiveDeps = {
    open: () => {
      const source = new FakeSource()
      sources.push(source)
      return source
    },
    setTimeout: (fn, ms) => {
      const id = next++
      timers.push({ fn, ms, id })
      return id
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const id = next++
      intervals.push({ fn, ms, id })
      return id
    },
    clearInterval: () => {},
    now: () => clock,
  }
  const bus = new WorkspaceLive(deps, start)
  const signals: LiveSignal[] = []
  bus.subscribe((signal) => signals.push(signal))
  return {
    bus,
    sources,
    signals,
    advance: (ms: number) => {
      clock += ms
    },
    runTimers: () => {
      const due = timers.splice(0, timers.length)
      for (const timer of due) timer.fn()
    },
    tickIntervals: () => {
      for (const interval of intervals) interval.fn()
    },
  }
}

const message = (seq: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, id: `ev-${seq}`, kind: 'object-updated', objectId: 'task-1', objectKind: 'task', loopId: 'loop-a', entrance: 'agent', ts: '2026-08-08T02:00:00.000Z', ...over })

describe('SSE resume', () => {
  it('opens at the cursor it was constructed with', () => {
    const h = harness(41822)
    h.bus.start()
    expect(h.bus.opened).toEqual(['/api/events/stream?since=41822'])
  })

  it('reconnects from the highest seq it actually saw — losslessly', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('open')
    h.sources[0]!.fire('change', message(41822))
    h.sources[0]!.fire('change', message(41823))
    h.sources[0]!.fire('error')
    h.runTimers()
    expect(h.bus.cursor).toBe(41823)
    expect(h.bus.opened).toEqual(['/api/events/stream?since=0', '/api/events/stream?since=41823'])
    expect(h.sources[0]!.closed).toBe(true)
  })

  it('never rewinds the cursor on an out-of-order message', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('change', message(50))
    h.sources[0]!.fire('change', message(20))
    expect(h.bus.cursor).toBe(50)
  })

  it('honors a server reset by jumping to the new tail — never a silent gap', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('change', message(10))
    h.sources[0]!.fire('reset', JSON.stringify({ seq: 900 }))
    expect(h.bus.cursor).toBe(900)
    expect(h.signals.at(-1)).toEqual({ type: 'reset', seq: 900 })
    h.sources[0]!.fire('error')
    h.runTimers()
    expect(h.bus.opened.at(-1)).toBe('/api/events/stream?since=900')
  })

  it('drops a malformed message rather than corrupting the cursor', () => {
    const h = harness(7)
    h.bus.start()
    h.sources[0]!.fire('change', 'not json')
    h.sources[0]!.fire('change', JSON.stringify({ id: 'ev-x' }))
    expect(h.bus.cursor).toBe(7)
    expect(h.signals).toEqual([])
  })

  it('retries on the server-controlled backoff', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('error')
    expect(h.bus.opened).toHaveLength(1)
    h.runTimers()
    expect(h.bus.opened).toHaveLength(2)
    expect(RETRY_MS).toBe(3000)
  })
})

describe('the degraded fallback', () => {
  it('needs two errors inside the window, and keeps retrying the stream', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('error')
    expect(h.bus.status).not.toBe('degraded')
    h.runTimers()
    h.sources[1]!.fire('error')
    expect(h.bus.status).toBe('degraded')
    h.runTimers()
    expect(h.bus.opened).toHaveLength(3)
  })

  it('does not degrade on two errors spread beyond the window', () => {
    const h = harness()
    h.bus.start()
    h.sources[0]!.fire('error')
    h.advance(DEGRADE_WINDOW_MS + 1)
    h.runTimers()
    h.sources[1]!.fire('error')
    expect(h.bus.status).not.toBe('degraded')
  })

  it('polls only while degraded, and stops once the stream is live again', () => {
    const h = harness()
    h.bus.start()
    h.tickIntervals()
    expect(h.signals).toEqual([])
    h.sources[0]!.fire('error')
    h.runTimers()
    h.sources[1]!.fire('error')
    h.tickIntervals()
    expect(h.signals).toEqual([{ type: 'poll' }])
    h.runTimers()
    h.sources[2]!.fire('open')
    h.tickIntervals()
    expect(h.signals).toEqual([{ type: 'poll' }])
    expect(h.bus.status).toBe('live')
  })

  it('stops opening sources after stop()', () => {
    const h = harness()
    h.bus.start()
    h.bus.stop()
    h.sources[0]!.fire('error')
    h.runTimers()
    expect(h.bus.opened).toHaveLength(1)
  })
})

describe('shouldRefetch — cursorSeq is what keeps a refetch from racing the stream', () => {
  const change = (seq: number, over: Record<string, unknown> = {}): LiveSignal => ({ type: 'change', message: JSON.parse(message(seq, over)) })

  it('skips a message the payload on screen already reflects', () => {
    expect(shouldRefetch(change(41823), 41823)).toBe(false)
    expect(shouldRefetch(change(41822), 41823)).toBe(false)
  })

  it('refetches for a newer message', () => {
    expect(shouldRefetch(change(41824), 41823)).toBe(true)
  })

  it('honors the view predicate for a newer message', () => {
    expect(shouldRefetch(change(99, { objectKind: 'doc' }), 0, (m) => m.objectKind === 'doc')).toBe(true)
    expect(shouldRefetch(change(99, { objectKind: 'task' }), 0, (m) => m.objectKind === 'doc')).toBe(false)
  })

  it('always refetches on reset and poll — both mean "you may have missed something"', () => {
    expect(shouldRefetch({ type: 'reset', seq: 5 }, 99_999)).toBe(true)
    expect(shouldRefetch({ type: 'poll' }, 99_999)).toBe(true)
  })
})
