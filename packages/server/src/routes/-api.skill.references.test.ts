/**
 * The path-safe /api/skill/references/<file> fallback route. Exercises the GET
 * handler directly (vitest resolves the `?raw` skill imports the same way the
 * nitro build does) — the four exact reference names serve their bundled bytes
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

// Prose in the reference docs is hard-wrapped, so a phrase can straddle a newline +
// indent. Collapse all whitespace runs to a single space before substring-matching.
const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('/api/skill/references/$', () => {
  for (const name of ['create.md', 'update.md', 'evolve.md', 'run.md']) {
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

  test('create.md carries the §2 propose → confirm → build guidance', async () => {
    const body = flat(await (await call('/api/skill/references/create.md')).text())
    // The new constraint: never silently guess cadence/output — propose, confirm, then build.
    expect(body).toContain('2 · Settle cadence, output')
    expect(body).toContain('propose → confirm → build')
    expect(body).toContain('Never silently guess')
    // The parameters the agent must settle before `loopany new`.
    expect(body).toContain('Cadence.')
    expect(body).toContain('Per-run output.')
    // Batch 3: a goal-shaped task also proposes a finish line (closed loop); a
    // monitor-shaped task never mentions a goal.
    expect(body).toContain('Finish line — only for goal-shaped tasks')
    // Concrete proposed defaults the guidance offers as examples.
    expect(body).toContain('every day at 9am your time')
    expect(body).toContain('every hour')
    expect(body).toContain('a short markdown summary in `report.md`')
  })

  test('create.md §1 owns decide-what-to-build (moved from bootstrap in batch 3)', async () => {
    const body = flat(await (await call('/api/skill/references/create.md')).text())
    // Session already has a task → turn THAT into the loop; empty session → brainstorm
    // loops FOR THIS project and let the user pick. This fork used to live in bootstrap.
    expect(body).toContain('already did a clear task')
    expect(body).toContain("There's no task yet")
    expect(body).toContain('useful FOR IT')
  })

  test('create.md drops the removed `task` field + tmp.json ritual, uses inline --json', async () => {
    const body = flat(await (await call('/api/skill/references/create.md')).text())
    // Batch 2 removed the `task` column and the loop.tmp.json config file; create.md
    // now authors an inline config passed to `loopany new --json` and previews with --dry-run.
    expect(body).not.toContain('loop.tmp.json')
    expect(body).not.toContain('--config')
    expect(body).toContain('loopany new --json')
    expect(body).toContain('--dry-run')
  })

  test('create.md carries the optional Dashboard-at-create step (author ui now when the shape is known)', async () => {
    const body = flat(await (await call('/api/skill/references/create.md')).text())
    // The follow-up round: when the product shape is already known (template-driven
    // loops), author the initial `ui` in the create config instead of deferring to an
    // evolve pass — and cross-reference evolve.md §3 rather than duplicating it.
    expect(body).toContain('Dashboard at create')
    expect(body).toContain('day-one dashboard')
    expect(body).toContain('evolve.md` §3')
    // `ui` is now a documented (optional) config field.
    expect(body).toContain('`ui` is optional')
  })

  test('run.md carries the runtime protocol depth (batch 3: extracted from exec-loop §1-§4)', async () => {
    const body = flat(await (await call('/api/skill/references/run.md')).text())
    // The task file is the loop's memory, with its three standing sections.
    expect(body).toContain('## Spec')
    expect(body).toContain('## Current understanding')
    expect(body).toContain('## Timeline')
    // Compress-don't-append discipline.
    expect(body).toContain('Compress, don\'t append forever')
    // Surface-only-what-changed nuance.
    expect(body).toContain('surfaces only what is new or changed')
    // The report/finish grammar and the strict finish bar.
    expect(body).toContain('loopany report --status nothing-new')
    expect(body).toContain('loopany finish --message')
    expect(body).toContain('selfFinish: allowed')
    expect(body).toContain('Never finish early')
    // The schedule levers with `loopany show` first, and the run-path cadence floors.
    expect(body).toContain('loopany show')
    expect(body).toContain('loopany reschedule')
    expect(body).toContain('loopany set-cron')
    expect(body).toContain('cadence floors')
    // Front-matter product conventions (type/title/date).
    expect(body).toContain('front-matter')
    expect(body).toContain('type: report')
  })

  test('run.md is dual-audience (in-run enrichment + owner-readable), not edit-run mechanics', async () => {
    const body = flat(await (await call('/api/skill/references/run.md')).text())
    // Explicitly addresses both the in-run agent and the owner reading the skill.
    expect(body).toContain('Two audiences')
    // The prompt's inline CORE stays authoritative; the skill is enrichment.
    expect(body).toContain('your prompt wins')
    // OQ1 scope guard: the edit-run CORE stays server-internal — no set-*/edit-run
    // verb mechanics leak into the public run protocol.
    expect(body).not.toContain('set-ui')
    expect(body).not.toContain('set-workflow')
    expect(body).not.toContain('set-schema')
  })

  test('unknown name → 404 json', async () => {
    const res = await call('/api/skill/references/nope.md')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  test('internal run prompts are NOT served (public surface = create/update/evolve only)', async () => {
    // exec-loop.md / edit.md live under skill/run/ — internal run-dispatch only. They
    // must never leak through the public references route (or the npm bundle).
    for (const name of ['exec-loop.md', 'edit.md', 'control-on.md', 'control-off.md']) {
      const res = await call(`/api/skill/references/${name}`)
      expect(res.status).toBe(404)
    }
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
