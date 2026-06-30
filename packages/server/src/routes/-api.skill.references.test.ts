/**
 * The path-safe /api/skill/references/<file> fallback route. Exercises the GET
 * handler directly (vitest resolves the `?raw` skill imports the same way the
 * nitro build does) — the three exact reference names serve their bundled bytes
 * as markdown, and everything else (unknown name, nested path, traversal) is a
 * clean JSON 404. This is the prod behavior; the Vite dev static layer swallows
 * `.md` paths before the route runs, so it can only be observed off the dev server.
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.skill.references.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) =>
  GET({ request: new Request(`http://localhost:3000${pathname}`) })

describe('/api/skill/references/$', () => {
  for (const name of ['create.md', 'update.md', 'evolve.md']) {
    test(`serves ${name} as markdown`, async () => {
      const res = await call(`/api/skill/references/${name}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      const body = await res.text()
      expect(body.length).toBeGreaterThan(100)
    })
  }

  test('serves the real create.md body (the create flow)', async () => {
    const body = await (await call('/api/skill/references/create.md')).text()
    expect(body).toContain('loopany new')
  })

  test('unknown name → 404 json', async () => {
    const res = await call('/api/skill/references/nope.md')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  test('path traversal is refused (not in the static map)', async () => {
    for (const p of [
      '/api/skill/references/..%2f..%2fpackage.json',
      '/api/skill/references/sub/create.md',
      '/api/skill/references/create.md/extra',
    ]) {
      const res = await call(p)
      expect(res.status).toBe(404)
    }
  })
})
