/**
 * The path-safe /api/template/<name> route — serves a template-market setup doc as
 * markdown. Exercises the GET handler directly (vitest resolves the `?raw` template
 * glob the same way the nitro build does): a known template name serves its bundled
 * bytes as markdown, and everything else (unknown name, nested path, traversal) is a
 * clean JSON 404. Mirrors api.skill.references.$ — this is the public template surface.
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.template.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) => GET({ request: new Request(`http://localhost:3000${pathname}`) })

// Prose in the docs is hard-wrapped; collapse whitespace before substring-matching.
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('/api/template/$', () => {
  test('serves the react-doctor doc as markdown', async () => {
    const res = await call('/api/template/react-doctor')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
  })

  test('carries the React Doctor recipe (preconditions, no-stacking, board, score)', async () => {
    const body = flat(await (await call('/api/template/react-doctor')).text())
    // The setup preconditions (React project + gh authed) come first.
    expect(body).toContain('npx react-doctor@latest')
    expect(body).toContain('gh auth status')
    // The non-obvious daily rules the doc must encode.
    expect(body).toContain('No-stacking')
    expect(body).toContain('loop-kanban columns=\\"open,merged\\"')
    expect(body).toContain('loop-chart series=\\"score:Red Dot Score')
    expect(body).toContain('loopany report')
    // Open monitor loop — no goal.
    expect(body).toContain('open monitor loop')
    // Instructs `loopany new` for creation.
    expect(body).toContain('loopany-cli> new --json')
  })

  test('unknown name → 404 json', async () => {
    const res = await call('/api/template/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  test('path traversal / nested paths are refused (not in the static map)', async () => {
    for (const p of [
      '/api/template/..%2f..%2fpackage.json',
      '/api/template/react-doctor/template.md',
      '/api/template/react-doctor/extra',
      '/api/template/',
    ]) {
      const res = await call(p)
      expect(res.status).toBe(404)
    }
  })
})
