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

// Per-template on-demand references (templates/<name>/reference.md): bulky
// material a template's setup flow needs (e.g. a dashboard reference layout)
// that must NOT ride in the paste prompt. Exposed under the build-time key
// `templates/<name>/reference.md` — still a static map, so the path-safety
// argument below is unchanged (only exact known keys resolve).
const templateRefs = import.meta.glob<string>('../skill/templates/*/reference.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

const REFERENCES: Record<string, string> = {
  'create.md': create,
  'update.md': update,
  'evolve.md': evolve,
  'run.md': run,
  ...Object.fromEntries(
    Object.entries(templateRefs).map(([path, body]) => [path.replace('../skill/', ''), body]),
  ),
}

const PREFIX = '/api/skill/references/'

/**
 * GET /api/skill/references/:file — serve one loopany skill reference file. Path-safe:
 * only a key present in the static REFERENCES map resolves — a top-level `<name>.md`
 * or a template's `templates/<name>/reference.md` — and anything else (traversal, other
 * files in a template folder, unknown names) is 404. Keys are compared whole, so a
 * nested-looking path is not a path: nothing is joined or walked. The server only reads
 * bytes it shipped — no filesystem access, no user input reaches disk (zero-exec holds).
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
