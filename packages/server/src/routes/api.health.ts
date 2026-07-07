import { createFileRoute } from '@tanstack/react-router'

// Build provenance is baked into the image: the Dockerfile turns the GIT_SHA /
// BUILT_AT build args into container ENV (see Dockerfile + .github/workflows/*).
// Unset in local dev (no build args) → a graceful "unknown" placeholder, never a
// crash. Read per-request so tests can set the env dynamically.
const buildSha = () => process.env.GIT_SHA || 'unknown'
const buildAt = () => process.env.BUILT_AT || 'unknown'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () =>
        Response.json({ ok: true, sha: buildSha(), builtAt: buildAt() }),
    },
  },
})
