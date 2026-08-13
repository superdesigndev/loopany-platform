import { createFileRoute } from '@tanstack/react-router'
import { MACHINE_BODY_CAP, readJsonBody } from '../gateway/http'
import { machineRouteLimit } from '../gateway/rateLimit'
import { auth as betterAuth } from '../auth'

/**
 * POST /api/kernel/cli — the SERVER host for `@loopany/kernel` (milestone M5).
 *
 * Body: the discriminated `{command|tick|read, now?}` envelope (`kernel/gateway.ts`
 * `KernelCliBody`) — a write Command, a host tick, or a read of the authority
 * snapshot (M6 remote backend). A bare `{command}` still parses (back-compat).
 * Auth is the existing `dk_` device-token machinery (Bearer), resolved to the
 * machine's owner/team scope exactly like every other machine route; the server
 * OVERRIDES the actor identity from the credential and never trusts the body.
 * Same 2MB `readJsonBody` cap + rate limit.
 *
 * Response JSON is ALWAYS the `{ok, refusal?, conflict?, notices, result?}`
 * envelope (`kernel/gateway.ts` `KernelCliResponse`) — never a bare `{error}`.
 * Statuses: 200 ok, 422 on a decide-time `Refusal`, 409 on a persist-time
 * `ApplyConflict` (§12: the two error shapes ride distinctly, not unified). The
 * PRE-gateway failures (missing credential 401, oversized body 413, unparseable
 * JSON 400) also return the envelope with a typed `refusal.code`, so M6's thin
 * remote driver parses ONE response shape everywhere — no dual error parser.
 * The kernel decides in-process and `kernel/store.ts` applies the Changeset in
 * ONE transaction.
 */
function envelope(code: string, message: string) {
  return { ok: false as const, notices: [] as string[], refusal: { code, message } }
}

export const Route = createFileRoute('/api/kernel/cli')({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const authorization = request.headers.get('authorization') ?? ''
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        const limited = machineRouteLimit(request, token || undefined)
        // machineRouteLimit's own 429 body is the text-sink `{error,text,exitCode}`
        // shape; re-wrap it in the kernel envelope (preserving Retry-After) so this
        // route keeps its ONE-response-shape contract and M6's driver needs no
        // second parser.
        if (limited)
          return Response.json(envelope('RATE_LIMITED', 'rate limited — slow down'), {
            status: 429,
            headers: { 'retry-after': limited.headers.get('retry-after') ?? '1' },
          })
        if (!token)
          return Response.json(envelope('UNAUTHORIZED', 'missing credential'), { status: 401 })
        const parsed = await readJsonBody(request, MACHINE_BODY_CAP)
        if (parsed.kind === 'too-large')
          return Response.json(envelope('BODY_TOO_LARGE', 'request body too large'), { status: 413 })
        // Unparseable JSON is a client error — fail loud (400) rather than
        // silently degrading to `{}` → `decide(undefined)` → a misleading 422
        // UNKNOWN_COMMAND that hides the real fault (a malformed body).
        if (parsed.kind === 'invalid')
          return Response.json(envelope('INVALID_BODY', 'request body is not valid JSON'), { status: 400 })
        // A JSON body of literal `null` parses as {kind:'ok', body:null}; guard it
        // (a null deref would throw an unhandled 500) — an empty envelope then
        // yields decide()'s proper 422 UNKNOWN_COMMAND (it never throws on undefined).
        // The body is the discriminated {command|tick|read, now} envelope; the
        // gateway normalizes a bare Command for back-compat.
        const body = parsed.body ?? {}
        const { kernelCli } = await import('../kernel/gateway.js')
        const session = token.startsWith('rk_') || token.startsWith('mk_') || token.startsWith('dk_')
          ? null
          : await betterAuth.api.getSession({ headers: request.headers })
        const teamId = request.headers.get('x-loopany-team-id') ?? (typeof body === 'object' && body ? String((body as any).teamId ?? '') : '')
        if (session?.user && !teamId)
          return Response.json(envelope('TEAM_REQUIRED', 'select a team with --team'), { status: 400 })
        const r = await kernelCli(token, body, session?.user ? { userId: session.user.id, teamId } : undefined)
        return Response.json(r.body, { status: r.status })
      },
    },
  },
})
