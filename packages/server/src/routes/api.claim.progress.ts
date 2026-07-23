import { createFileRoute } from '@tanstack/react-router'
import { machineRouteLimit } from '../gateway/rateLimit'
import { isCreationStep } from '../lib/creationSteps'

/**
 * POST /api/claim/progress — the coding agent reports a loop-creation milestone
 * during a New-loop paste, bound to the claim token the onboarding wizard polls.
 *
 * ZERO daemon/CLI change: the agent already has a shell, so the pasted snippet tells
 * it to `curl` this endpoint per milestone. Pure progress reporting — no code exec,
 * the server only stores an enum key in a bounded in-memory map.
 *
 * Untrusted input, so it is locked down: enum-only `step` (free text rejected),
 * `dk_`-shaped claim, a tiny body cap, and the standard per-IP flood guard. It is
 * BEST-EFFORT and never authoritative — the loop-created claim result remains the
 * real completion signal, so nothing here can gate or forge loop creation.
 */
export const Route = createFileRoute('/api/claim/progress')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const text = await request.text()
        // Bound the body before parsing (this is a public, unauthenticated write).
        if (text.length > 1024) return Response.json({ error: 'body too large' }, { status: 413 })
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        const b = body as { claim?: unknown; step?: unknown }
        const claim = typeof b.claim === 'string' ? b.claim.trim() : ''
        const step = typeof b.step === 'string' ? b.step.trim() : ''
        // Per-IP + per-claim flood guard (claim doubles as the token bucket key).
        const limited = machineRouteLimit(request, claim || undefined)
        if (limited) return limited
        const { isDeviceTokenShape } = await import('../gateway/tokens.js')
        if (!claim || !isDeviceTokenShape(claim)) return Response.json({ error: 'invalid claim' }, { status: 400 })
        // Reject anything outside the fixed step vocabulary (no free text is stored).
        if (!isCreationStep(step)) return Response.json({ error: 'unknown step' }, { status: 400 })
        const { recordClaimProgress } = await import('../gateway/tokens.js')
        recordClaimProgress(claim, step)
        return Response.json({ ok: true })
      },
    },
  },
})
