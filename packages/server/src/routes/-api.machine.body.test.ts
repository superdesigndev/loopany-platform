/**
 * Machine-route body-size boundary. The gateway's per-field wire caps clip
 * strings AFTER parse; readJsonBody bounds the whole body at ingress so an
 * oversized POST is a clean 413 before any parse/boot work. Exercised on the
 * handlers directly for the paths that settle BEFORE the dynamic boot import
 * (so no DB is touched), plus unit coverage of the helper's result kinds.
 */
import { describe, expect, test } from 'vitest'

import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { Route as PollRoute } from './api.machine.poll'
import { Route as ReportRoute } from './machine.report'
import { Route as LoopRoute } from './api.machine.loop'
import { Route as AgentApiRoute } from './agent-api.loop'

type Handler = (ctx: { request: Request }) => Response | Promise<Response>
const handler = (route: unknown, method: string): Handler =>
  (route as any).options.server.handlers[method]

const oversized = (url: string, method = 'POST') =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: `{"pad":"${'x'.repeat(MACHINE_BODY_CAP + 1)}"}`,
  })

describe('readJsonBody', () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { method: 'POST', headers, body })

  test('parses a normal body', async () => {
    expect(await readJsonBody(req('{"a":1}'), 1024)).toEqual({ kind: 'ok', body: { a: 1 } })
  })

  test('empty body parses as {} (matches the old .catch(() => ({})) behavior)', async () => {
    expect(await readJsonBody(req(''), 1024)).toEqual({ kind: 'ok', body: {} })
  })

  test('unparseable JSON → invalid (each route keeps its own policy)', async () => {
    expect(await readJsonBody(req('not json'), 1024)).toEqual({ kind: 'invalid' })
  })

  test('over-cap body → too-large (actual text, and the declared content-length)', async () => {
    expect(await readJsonBody(req('x'.repeat(2049)), 2048)).toEqual({ kind: 'too-large' })
    expect(await readJsonBody(req('{}', { 'content-length': '999999' }), 2048)).toEqual({ kind: 'too-large' })
  })
})

describe('machine routes reject an oversized JSON body with 413', () => {
  test.each([
    ['/api/machine/poll', handler(PollRoute, 'POST')],
    ['/machine/report', handler(ReportRoute, 'POST')],
    ['/agent-api/loop', handler(AgentApiRoute, 'POST')],
    ['/api/machine/loop', handler(LoopRoute, 'POST')],
  ])('%s', async (url, h) => {
    const res = await h({ request: oversized(url) })
    expect(res.status).toBe(413)
  })

  test('/api/machine/loop PATCH', async () => {
    const res = await handler(LoopRoute, 'PATCH')({ request: oversized('/api/machine/loop', 'PATCH') })
    expect(res.status).toBe(413)
  })
})
