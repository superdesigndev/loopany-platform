/**
 * The device-token blob upload route. Exercises the PUT handler directly for the
 * input-validation paths that settle BEFORE the dynamic gateway import (so no DB
 * is touched): a malformed percent-encoded hash must be a clean 400 —
 * `decodeURIComponent` throws a URIError on bad encoding, which used to escape
 * the handler as a 500.
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.machine.blob.$hash'

const PUT = (Route as any).options.server.handlers.PUT as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string, headers: Record<string, string> = {}) =>
  PUT({ request: new Request(`http://localhost:3000${pathname}`, { method: 'PUT', headers }) })

describe('/api/machine/blob/$hash', () => {
  test('missing device token → 401 (unchanged guard, runs before the decode)', async () => {
    const res = await call('/api/machine/blob/%zz')
    expect(res.status).toBe(401)
  })

  test('malformed percent-encoding in the hash → 400, not a thrown 500', async () => {
    const res = await call('/api/machine/blob/%zz', { authorization: 'Bearer dev-token' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad hash' })
  })
})
