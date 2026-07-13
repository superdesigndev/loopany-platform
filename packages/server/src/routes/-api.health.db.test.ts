/**
 * /api/health/db liveness probe (rationale: api.health.db.ts). Reachable DB → 200
 * {ok:true}; a failed/hung query → 503 {ok:false}. The db handle is mocked so both
 * branches are deterministic without a real pool.
 */
import { describe, expect, test, vi } from 'vitest'

const execute = vi.fn()
vi.mock('../db/index.js', () => ({ db: { execute } }))

import { Route } from './api.health.db'

const GET = (Route as any).options.server.handlers.GET as () =>
  | Response
  | Promise<Response>

describe('/api/health/db', () => {
  test('DB reachable → 200 {ok:true, db:"up"}', async () => {
    execute.mockResolvedValueOnce([{ '?column?': 1 }])
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: 'up' })
  })

  test('query fails/hangs → 503 {ok:false, db:"down"} with the error message', async () => {
    execute.mockRejectedValueOnce(new Error('connection closed'))
    const res = await GET()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, db: 'down', error: 'connection closed' })
  })

  test('a HUNG query → fast 503 via the client-side deadline (never eats the check timeout)', async () => {
    vi.useFakeTimers()
    try {
      // A wedged pool: the ping never settles. The probe must resolve via its own
      // 5s deadline, not hang until Fly's 10s check timeout.
      execute.mockReturnValueOnce(new Promise(() => {}))
      const resP = GET()
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await resP
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.db).toBe('down')
      expect(String(body.error)).toMatch(/timed out/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
