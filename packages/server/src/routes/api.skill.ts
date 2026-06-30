import { createFileRoute } from '@tanstack/react-router'
// Inlined at build time (Vite ?raw) so it ships in the nitro bundle. Served from
// a server route (not /public) so we control the charset — static .md serving
// omits `charset=utf-8`, which garbles the UTF-8 content for some clients. A
// non-extension path (/api/skill) is used because Vite's dev static layer would
// otherwise swallow a `.md` path before the route runs.
//
// This serves the skill's OVERVIEW (skill/SKILL.md) — the bootstrap an agent
// follows on the very first capture before the loopany skill is installed locally.
// The overview routes to the focused references (create/update/evolve), which the
// agent reads from the local install (`loopany up` installs the skill via `npx
// skills`) or, as a fallback, fetches over HTTP from /api/skill/references/<file>
// (see api.skill.references.$.ts). Single source of truth: packages/server/src/skill/.
import skill from '../skill/SKILL.md?raw'

/** GET /api/skill — the loop-builder skill overview Claude Code follows (see ComposeModal). */
export const Route = createFileRoute('/api/skill')({
  server: {
    handlers: {
      GET: () =>
        new Response(skill, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
        }),
    },
  },
})
