import { createFileRoute } from '@tanstack/react-router'
import { machineCredentialLimit, machineRouteLimit } from '../gateway/rateLimit'
import { readJsonBody } from '../gateway/http'
import { isCreationStep } from '../lib/creationSteps'

/** This body is one enum key + one `dk_` claim — a kilobyte is generous. */
const CLAIM_PROGRESS_BODY_CAP = 1024

/**
 * POST /api/claim/progress — the coding agent reports a loop-creation milestone
 * during a New-loop paste, bound to the claim token the onboarding wizard polls.
 *
 * The emit path is the loop-creation SKILL, not the pasted snippet: `references/create.md`
 * tells the agent to run `loopany progress <step> --connect-key <key>`, and the daemon
 * subcommand (`progress-cli.ts`) POSTs this contract best-effort. Pure progress
 * reporting: no code exec, the server only stores an enum key in a bounded in-memory map.
 *
 * Untrusted input, so it is locked down: enum-only `step` (free text rejected),
 * `dk_`-shaped claim, a tiny body cap, and the standard per-IP flood guard. It is
 * BEST-EFFORT and never authoritative — the loop-created claim result remains the
 * real completion signal, so nothing here can gate or forge loop creation.
 *
 * Ingress order matters on the one public write route: the per-IP flood guard runs
 * FIRST (a limited request never costs a body read), then the capped `readJsonBody`
 * rejects an oversized body on its declared content-length before buffering — the
 * same discipline every machine route follows. The per-claim bucket can only apply
 * once the claim is parsed, so it rides the credential-only tier.
 */
export const Route = createFileRoute('/api/claim/progress')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const limited = machineRouteLimit(request)
        if (limited) return limited
        const read = await readJsonBody(request, CLAIM_PROGRESS_BODY_CAP)
        if (read.kind === 'too-large') return Response.json({ error: 'body too large' }, { status: 413 })
        if (read.kind === 'invalid') return Response.json({ error: 'invalid json' }, { status: 400 })
        const b = read.body as { claim?: unknown; step?: unknown }
        const claim = typeof b.claim === 'string' ? b.claim.trim() : ''
        const step = typeof b.step === 'string' ? b.step.trim() : ''
        // Per-claim fairness (the claim doubles as the token bucket key).
        const claimLimited = claim ? machineCredentialLimit(claim) : null
        if (claimLimited) return claimLimited
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
