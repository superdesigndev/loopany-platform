/**
 * The /api/bootstrap route serves the BOOTSTRAP doc (skill/bootstrap.md), not the
 * installable SKILL.md. (Renamed from /api/skill in batch 2 — that path never served
 * the installable skill; the references stay at /api/skill/references/*.) Exercises
 * the GET handler directly (vitest resolves the `?raw` bootstrap import the same way
 * the nitro build does) — the first-capture onboarding an agent follows before the
 * loopany skill is on disk. Asserts the bootstrap-only content: no frontmatter, the
 * connect step, fetch-references-over-HTTP, and the captain's session-situation
 * division (task-done → guide that into a loop; empty session → brainstorm loops FOR
 * THIS project and let the user pick).
 */
import { describe, expect, test } from 'vitest'

import { Route } from './api.bootstrap'

const GET = (Route as any).options.server.handlers.GET as () => Response | Promise<Response>

// Prose in the doc is hard-wrapped, so a phrase can straddle a newline + indent.
// Collapse all whitespace runs to a single space before substring-matching prose.
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('/api/bootstrap', () => {
  test('serves the bootstrap doc as markdown', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = await res.text()
    expect(body.length).toBeGreaterThan(100)
  })

  test('is bootstrap, NOT the installable skill — no frontmatter', async () => {
    const body = await (await GET()).text()
    // The installable SKILL.md opens with a `---\nname: loopany` frontmatter block;
    // the fetched-and-followed bootstrap doc must NOT (it's not installed).
    expect(body.startsWith('---')).toBe(false)
    expect(body).not.toContain('name: loopany')
  })

  test('carries the first-capture onboarding (connect + fetch references over HTTP)', async () => {
    const body = flat(await (await GET()).text())
    // Interpret the pasted values and connect the machine.
    expect(body).toContain('connect-key')
    expect(body).toContain('loopany up')
    // The skill isn't on disk yet, so the references are fetched over HTTP.
    expect(body).toContain('/api/skill/references/create.md')
    // Still a quick check-in, not a full interview.
    expect(body).toContain('keep questions to quick')
  })

  test('reads the session situation: guide a done task, else brainstorm project loops', async () => {
    const body = flat(await (await GET()).text())
    // Task already done in this session → turn THAT into the loop.
    expect(body).toContain('already did a clear task')
    // No task yet → do not invent; look at what THIS project is and brainstorm.
    expect(body).toContain('no task yet')
    expect(body).toContain('FOR THIS project')
    expect(body).toContain('let the user pick')
  })
})
