/**
 * POST /api/kernel/cli route-BOUNDARY behavior — the HTTP seam the M6 remote
 * driver consumes. The gateway function itself is covered by
 * kernel/kernelCli.integration.test.ts; here we pin exactly what the route adds
 * on TOP of it: Bearer parsing, the body cap, malformed-JSON handling, and — the
 * fix under test — that every PRE-gateway failure returns the SAME
 * `{ok, notices, refusal:{code,message}}` envelope the gateway returns, never a
 * bare `{error}`. A single response shape means the remote driver needs one
 * parser (design §12: two error shapes is already the maximum).
 */
import { afterEach, describe, expect, test } from 'vitest'

import { MACHINE_BODY_CAP } from '../gateway/http'
import { __resetMachineRateLimiters } from '../gateway/rateLimit'
import { Route } from './api.kernel.cli'

type Handler = (ctx: { request: Request }) => Response | Promise<Response>
const post = (Route as any).options.server.handlers.POST as Handler

function req(opts: { auth?: string; body?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.auth !== undefined) headers.authorization = opts.auth
  return new Request('http://localhost:3000/api/kernel/cli', {
    method: 'POST',
    headers,
    body: opts.body,
  })
}

describe('POST /api/kernel/cli — pre-gateway envelope', () => {
  test('missing credential → 401 in the {ok,notices,refusal} envelope', async () => {
    const res = await post({ request: req({ body: '{"command":{"op":"create","title":"x"}}' }) })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.notices).toEqual([])
    expect(body.refusal.code).toBe('UNAUTHORIZED')
    expect(body.error).toBeUndefined() // never the bare {error} shape
  })

  test('a non-Bearer authorization header is treated as no credential', async () => {
    const res = await post({ request: req({ auth: 'Basic abc', body: '{}' }) })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.refusal.code).toBe('UNAUTHORIZED')
  })

  test('oversized body → 413 in the envelope (settles before any gateway/DB work)', async () => {
    const res = await post({
      request: req({ auth: 'Bearer dk_x', body: `{"pad":"${'x'.repeat(MACHINE_BODY_CAP + 1)}"}` }),
    })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.refusal.code).toBe('BODY_TOO_LARGE')
    expect(body.error).toBeUndefined()
  })

  test('malformed JSON with a valid Bearer → 400 INVALID_BODY, not a misleading 422 UNKNOWN_COMMAND', async () => {
    // A non-empty Bearer token clears the credential check, so this ALSO proves
    // Bearer parsing: the request reaches readJsonBody and settles at the body
    // seam BEFORE any gateway/DB import.
    const res = await post({ request: req({ auth: 'Bearer dk_x', body: 'not json' }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.refusal.code).toBe('INVALID_BODY')
    expect(body.error).toBeUndefined()
  })

  test('a JSON `null` body does NOT crash (no unhandled 500) — settles in the envelope', async () => {
    // readJsonBody returns {kind:'ok', body:null} for a literal `null`; the old
    // `body.command` read threw a TypeError → unhandled 500. The `?? {}` guard
    // turns it into a clean envelope (an unknown/absent machine → 401 here; a real
    // machine would get decide()'s 422 UNKNOWN_COMMAND for the absent command).
    const res = await post({ request: req({ auth: 'Bearer dk_x', body: 'null' }) })
    expect(res.status).not.toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.refusal.code).toBeTypeOf('string')
    expect(body.notices).toEqual([])
    expect(body.error).toBeUndefined()
  })
})

describe('POST /api/kernel/cli — rate limit envelope', () => {
  afterEach(() => {
    __resetMachineRateLimiters()
    delete process.env.LOOPANY_RATE_LIMIT
  })

  test('a spent rate-limit bucket → 429 in the envelope (not the bare text-sink {error}), with Retry-After', async () => {
    process.env.LOOPANY_RATE_LIMIT = 'on'
    __resetMachineRateLimiters()
    // Drain the per-token bucket (default burst 120) so the next call is limited.
    // Every request shares one IP bucket too, but the token bucket is smaller-or-
    // equal and one of the two dries first; either way a 429 fires.
    // `dk_x` fails the device-token SHAPE check, so a non-limited request settles
    // at kernelCli's 401 WITHOUT touching the DB — the loop never needs a seeded
    // machines table, and the 429 (checked before the gateway) is what we assert.
    let res: Response | undefined
    for (let i = 0; i < 400; i++) {
      res = await post({ request: req({ auth: 'Bearer dk_x', body: 'null' }) })
      if (res.status === 429) break
    }
    expect(res!.status).toBe(429)
    expect(res!.headers.get('retry-after')).toBe('1')
    const body = await res!.json()
    expect(body.ok).toBe(false)
    expect(body.notices).toEqual([])
    expect(body.refusal.code).toBe('RATE_LIMITED')
    expect(body.error).toBeUndefined() // never the bare text-sink {error,text,exitCode}
    expect(body.text).toBeUndefined()
  })
})
