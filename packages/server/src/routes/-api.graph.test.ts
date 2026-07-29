/**
 * `/api/graph/*` is the Graph v1 workspace demo's API. It seeds a fixed team id
 * and exposes an UNAUTHENTICATED write path, so the production gate is the thing
 * that matters most about it — this suite pins that gate and the splat routing.
 *
 * The gate is checked BEFORE the handler imports the database, so these cases
 * run without a DB (an unknown view and a production request both return before
 * `read.js` is loaded).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Route } from './api.graph.$'

const handlers = (Route as any).options.server.handlers as {
  GET: (ctx: { params: { _splat?: string }; request: Request }) => Promise<Response>
  POST: (ctx: { params: { _splat?: string }; request: Request }) => Promise<Response>
}

const get = (splat: string) =>
  handlers.GET({ params: { _splat: splat }, request: new Request(`http://x/api/graph/${splat}`) })

const post = (splat: string, body: unknown) =>
  handlers.POST({
    params: { _splat: splat },
    request: new Request(`http://x/api/graph/${splat}`, { method: 'POST', body: JSON.stringify(body) }),
  })

describe('/api/graph dev gate', () => {
  const saved = process.env.NODE_ENV
  beforeEach(() => {
    process.env.NODE_ENV = 'production'
  })
  afterEach(() => {
    process.env.NODE_ENV = saved
  })

  test('every read view 404s in a production build', async () => {
    for (const view of ['summary', 'system', 'library', 'timeline', 'inbox']) {
      expect((await get(view)).status).toBe(404)
    }
  })

  test('the write path 404s in a production build', async () => {
    const res = await post('verdict', { objectId: 'obj-x', transition: 'approve' })
    expect(res.status).toBe(404)
  })
})

describe('/api/graph routing', () => {
  test('an unknown view is a 404, not a crash', async () => {
    const res = await get('nope')
    expect(res.status).toBe(404)
  })

  test('POST to anything but verdict is a 404', async () => {
    expect((await post('system', {})).status).toBe(404)
  })

  test('verdict validates its body before touching the engine', async () => {
    const missing = await post('verdict', { objectId: 'obj-x' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: expect.stringContaining('required') })
  })

  test('a non-JSON verdict body is a 400', async () => {
    const res = await handlers.POST({
      params: { _splat: 'verdict' },
      request: new Request('http://x/api/graph/verdict', { method: 'POST', body: 'not json' }),
    })
    expect(res.status).toBe(400)
  })
})
