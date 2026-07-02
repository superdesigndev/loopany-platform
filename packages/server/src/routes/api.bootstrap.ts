import { createFileRoute } from '@tanstack/react-router'
// Inlined at build time (Vite ?raw) so it ships in the nitro bundle. Served from
// a server route (not /public) so we control the charset — static .md serving
// omits `charset=utf-8`, which garbles the UTF-8 content for some clients. A
// non-extension path (/api/bootstrap) is used because Vite's dev static layer would
// otherwise swallow a `.md` path before the route runs.
//
// This serves the BOOTSTRAP doc (skill/bootstrap.md) — the onboarding an agent
// follows on the very first capture, before the loopany skill is installed locally.
// bootstrap.md carries the first-contact-only content (interpret the pasted
// server-url/connect-key, `loopany up`, read the session to decide what loop to build,
// fetch references over HTTP because the skill isn't on disk yet) and has NO
// frontmatter — it's fetched-and-followed, not installed. It is server-only: the
// daemon bundles/installs the clean SKILL.md instead (see sync-skill.mjs), so the
// on-disk skill never carries "I'm probably not installed yet" noise. bootstrap.md
// routes to the focused references (create/update/evolve), which the agent fetches
// over HTTP from /api/skill/references/<file> (see api.skill.references.$.ts) until
// the local install lands. Single source of truth: packages/server/src/skill/.
//
// Route renamed from /api/skill to /api/bootstrap in batch 2 (it never served the
// installable skill — it serves the bootstrap doc, so the path now says so). The
// old /api/skill root route is gone; the references stay at /api/skill/references/*.
import bootstrap from '../skill/bootstrap.md?raw'

/** GET /api/bootstrap — the first-capture bootstrap doc Claude Code follows (see ComposeModal). */
export const Route = createFileRoute('/api/bootstrap')({
  server: {
    handlers: {
      GET: () =>
        new Response(bootstrap, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
        }),
    },
  },
})
