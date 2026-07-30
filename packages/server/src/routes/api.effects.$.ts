import { createFileRoute } from '@tanstack/react-router'

/**
 * The EFFECT DIRECTIVE CHANNEL — the wire a machine-side effect agent speaks.
 *
 *   POST /api/effects/claim      {agent, machine?, limit?} → work orders + leases
 *   POST /api/effects/heartbeat  {agent, id}               → lease extended
 *   POST /api/effects/report     {agent, id, ok, …}        → outcome recorded
 *
 * ── why this is its own route and its own credential ─────────────────────────
 *
 * `/api/graph/*` is a HUMAN surface: it is gated on a signed-in session against
 * an allowlist, because it renders real customer content. This is a MACHINE
 * surface with the opposite shape - no session, one bearer token, and a payload
 * that acts on the outside world rather than describing it. Mixing the two behind
 * one guard would mean either browsers could claim work orders or agents needed
 * cookies, and both are wrong.
 *
 * The token is `LOOPANY_EFFECT_AGENT_TOKEN`, read from the environment and NEVER
 * committed. It FAILS CLOSED: an unset token 401s everything, because "not
 * configured" cannot mean "open" for a channel that hands out instructions to
 * merge pull requests.
 *
 * ── what this route deliberately does NOT decide ─────────────────────────────
 *
 * Whether an effect is safe. The repo allowlist, the default-branch refusal and
 * the approval re-check all live in the AGENT, where the credentials are - a
 * guard on this side would be a guard on the wrong side of the trust boundary.
 * What this side guarantees is narrower and still worth having: no directive
 * exists without a human approval event behind it, and every claim carries that
 * event's resolved provenance so the agent can check it for itself.
 *
 * The clock is read HERE and passed in, like every other seam in the graph, so a
 * probe can expire a lease at a chosen instant.
 */

/** Bodies are tiny work-order acknowledgements; anything larger is a mistake or
 *  an attack, and reading it would be the cost. */
const BODY_CAP = 64 * 1024

const json = (body: unknown, status = 200) => Response.json(body, { status })
const notFound = () => json({ error: 'not found' }, 404)

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const raw = await request.text()
  if (raw.length > BODY_CAP) return undefined
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export const Route = createFileRoute('/api/effects/$')({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const verb = String((params as { _splat?: string })._splat ?? '')

        // Auth before anything else, and before any database import: an
        // unauthenticated request costs one string comparison.
        const { effectAgentTokenMatches, effectChannelConfigured } = await import('../graph/effects/config.js')
        if (!effectChannelConfigured()) {
          return json(
            { error: 'unauthorized', detail: 'the effect channel is not configured on this server' },
            401,
          )
        }
        if (!effectAgentTokenMatches(request.headers.get('authorization'))) {
          return json({ error: 'unauthorized' }, 401)
        }

        const body = await readBody(request)
        if (!body) return json({ error: 'body must be JSON and under 64KB' }, 400)
        const agent = str(body.agent)
        if (!agent) return json({ error: 'agent is required (an instance id, recorded on the row)' }, 400)

        const channel = await import('../graph/effects/channel.js')
        const now = new Date().toISOString()

        if (verb === 'claim') {
          const { DEMO_TEAM_ID } = await import('../graph/workspace/specs.js')
          const limitRaw = Number(body.limit)
          const result = await channel.claimDirectives({
            now,
            agent,
            teamId: str(body.teamId) ?? DEMO_TEAM_ID,
            ...(str(body.machine) ? { machine: str(body.machine)! } : {}),
            ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.min(Math.floor(limitRaw), 20) } : {}),
          })
          return json({ ok: true, ...result })
        }

        const id = str(body.id)
        if (!id) return json({ error: 'id is required' }, 400)

        if (verb === 'heartbeat') {
          const r = await channel.heartbeatDirective({ now, agent, id })
          return r.ok ? json(r) : json(r, 409)
        }

        if (verb === 'report') {
          const ok = body.ok === true
          if (!ok) {
            // A failure MUST be typed. An untyped one would leave the attention
            // list unable to say whether a retry is worth offering, which is the
            // single most useful thing it tells a person.
            const { DIRECTIVE_REFUSAL_CODES } = await import('../graph/types.js')
            const code = str(body.refusalCode)
            if (!code || !(DIRECTIVE_REFUSAL_CODES as readonly string[]).includes(code)) {
              return json({ error: `refusalCode must be one of ${DIRECTIVE_REFUSAL_CODES.join('|')}` }, 400)
            }
          }
          const r = await channel.reportDirective({
            now,
            agent,
            id,
            ok,
            result: (body.result ?? null) as Record<string, unknown> | null,
            refusalCode: ok ? null : (str(body.refusalCode) as never),
            error: str(body.error) ?? null,
          })
          return r.ok ? json(r) : json(r, 409)
        }

        return notFound()
      },
    },
  },
})
