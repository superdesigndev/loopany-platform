/**
 * The /api/skill overview route. Exercises the GET handler directly (vitest
 * resolves the `?raw` SKILL.md import the same way the nitro build does) — the
 * bootstrap an agent follows on first capture. Asserts the reworded lead-in that
 * allows the two quick check-ins (empty task §0, loose cadence/output §0.5)
 * instead of the old blanket "don't ask follow-up questions".
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.skill'

const GET = (Route as any).options.server.handlers.GET as () => Response | Promise<Response>

describe('/api/skill', () => {
  test('serves the SKILL.md overview as markdown', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
  })

  test('overview allows two quick check-ins (empty task §0, loose params §0.5)', async () => {
    const body = await (await GET()).text()
    // The old blanket "don't ask follow-up questions" is reworded to permit check-ins.
    expect(body).toContain('keep questions to quick')
    expect(body).not.toContain("don't ask follow-up questions")
    // It points at both references that define the allowed check-ins.
    expect(body).toContain('references/create.md` §0)')
    expect(body).toContain('references/create.md` §0.5)')
    // The §0.5 check-in is specifically about cadence / per-run output.
    expect(body).toContain('cadence or per-run output')
    expect(body).toContain('propose a sensible default')
  })
})
