/**
 * /api/health exposes the baked build provenance so a deploy smoke check can assert
 * "prod is serving the commit I pushed" and drift is queryable. sha/builtAt come
 * from image ENV (Dockerfile GIT_SHA/BUILT_AT build args); unset in local dev →
 * a graceful "unknown" placeholder, never a crash. Read per-request so env set
 * after module load is honored.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Route } from './api.health'

const GET = (Route as any).options.server.handlers.GET as () =>
  | Response
  | Promise<Response>

const call = async () => (await GET()).json() as Promise<Record<string, unknown>>

describe('/api/health', () => {
  const saved = { sha: process.env.GIT_SHA, at: process.env.BUILT_AT }
  beforeEach(() => {
    delete process.env.GIT_SHA
    delete process.env.BUILT_AT
  })
  afterEach(() => {
    if (saved.sha === undefined) delete process.env.GIT_SHA
    else process.env.GIT_SHA = saved.sha
    if (saved.at === undefined) delete process.env.BUILT_AT
    else process.env.BUILT_AT = saved.at
  })

  test('reports the baked sha + builtAt when the env is set', async () => {
    process.env.GIT_SHA = 'abc123def'
    process.env.BUILT_AT = '2026-07-07T12:00:00Z'
    expect(await call()).toEqual({
      ok: true,
      sha: 'abc123def',
      builtAt: '2026-07-07T12:00:00Z',
    })
  })

  test('falls back to "unknown" placeholders in local dev (env unset)', async () => {
    expect(await call()).toEqual({ ok: true, sha: 'unknown', builtAt: 'unknown' })
  })
})
