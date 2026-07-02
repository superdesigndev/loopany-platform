/**
 * The session-authed artifact download route. Exercises the GET handler directly
 * for the input-validation paths that settle BEFORE the dynamic store/auth
 * imports (so no DB is touched): a malformed percent-encoded loop id must be a
 * clean 400 — `decodeURIComponent` throws a URIError on bad encoding, which used
 * to escape the handler as a 500.
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.artifact.$loopId.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) =>
  GET({ request: new Request(`http://localhost:3000${pathname}`) })

describe('/api/artifact/$loopId/$', () => {
  test('malformed percent-encoding in the loop id → 400, not a thrown 500', async () => {
    const res = await call('/api/artifact/%zz/report.md')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad loop id' })
  })

  test('a lone trailing % in the loop id → 400', async () => {
    const res = await call('/api/artifact/loop-1%/report.md')
    expect(res.status).toBe(400)
  })

  test('malformed percent-encoding in a path segment → 400 (same policy as the loop id)', async () => {
    const res = await call('/api/artifact/loop-1/data/%zz.json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad path' })
  })

  test('missing file path → 400', async () => {
    const res = await call('/api/artifact/loop-1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing path' })
  })
})
