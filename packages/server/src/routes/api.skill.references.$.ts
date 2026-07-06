import { createFileRoute } from '@tanstack/react-router'

// The loopany skill's reference files, inlined at build time (Vite ?raw) so they
// ship in the nitro bundle — same source of truth as /api/skill (packages/server/
// src/skill/). Served as the BOOTSTRAP FALLBACK: normally the agent reads these
// from the local install (`loopany up` installs the skill via `npx skills` into
// ./.claude/skills/loopany/references/), but when that install was skipped (no
// network/npx) the bootstrap doc (skill/bootstrap.md, served at /api/skill) tells
// the agent to fetch them here instead.
import create from '../skill/references/create.md?raw'
import update from '../skill/references/update.md?raw'
import evolve from '../skill/references/evolve.md?raw'
import run from '../skill/references/run.md?raw'

const REFERENCES: Record<string, string> = {
  'create.md': create,
  'update.md': update,
  'evolve.md': evolve,
  'run.md': run,
}

const PREFIX = '/api/skill/references/'

/**
 * GET /api/skill/references/:file — serve one loopany skill reference file. Path-safe:
 * only an exact, single-segment name from the static REFERENCES map resolves; anything
 * else (nested paths, traversal, unknown names) is 404. The server only reads bytes it
 * shipped — no filesystem access, no user input reaches disk (zero-exec invariant holds).
 */
export const Route = createFileRoute('/api/skill/references/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname
        if (!pathname.startsWith(PREFIX)) return Response.json({ error: 'not found' }, { status: 404 })
        const name = pathname.slice(PREFIX.length)
        const body = Object.prototype.hasOwnProperty.call(REFERENCES, name) ? REFERENCES[name] : undefined
        if (body === undefined) return Response.json({ error: 'not found' }, { status: 404 })
        return new Response(body, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
        })
      },
    },
  },
})
