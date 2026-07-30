import { createFileRoute } from '@tanstack/react-router'

/**
 * THE MACHINE AGENT CHANNEL — the whole wire a machine-side agent speaks.
 *
 * EFFECTS — the outward direction (an approved verdict reaching the world):
 *   POST /api/agent/effects/claim      {agent, machine?, limit?} → work orders + leases
 *   POST /api/agent/effects/heartbeat  {agent, id}               → lease extended
 *   POST /api/agent/effects/report     {agent, id, ok, …}        → outcome recorded
 *
 * SENSING — the inward direction (the world reaching the graph), captain decision 10:
 *   POST /api/agent/sensing/watchlist    {agent, teamId?}       → the mirrors to keep fresh
 *   POST /api/agent/sensing/observations {agent, observations[]} → facts ingested
 *
 * RUNS — the runs bridge's report-back half:
 *   POST /api/agent/runs/started   {agent, directive}                    → run-started
 *   POST /api/agent/runs/finished  {agent, directive, outcome, finding?, summary?…} → run-finished
 *
 * ── one route, one credential, both directions ───────────────────────────────
 *
 * `/api/graph/*` is a HUMAN surface: gated on a signed-in session against an
 * allowlist, because it renders real customer content. This is a MACHINE surface
 * with the opposite shape — no session, one bearer token, and payloads that act on
 * the world or report back from it rather than describing it to a browser. Mixing
 * the two behind one guard would mean either browsers could claim work orders or
 * agents needed cookies, and both are wrong.
 *
 * All three groups share this route and that token deliberately. Captain decision
 * 10's whole point is that ACTING and OBSERVING are the same trust boundary — the
 * credentials that could comment on a pull request are the credentials that can
 * read a private one — so splitting the surface would suggest they were two
 * boundaries and invite one of them to be configured more loosely than the other.
 *
 * The token is `LOOPANY_AGENT_TOKEN`, read from the environment and NEVER
 * committed. It FAILS CLOSED: unset 401s everything, because "not configured"
 * cannot mean "open" for a channel that hands out instructions to merge pull
 * requests and run commands.
 *
 * ── what this route deliberately does NOT decide ─────────────────────────────
 *
 * Whether an effect is safe, or a run is. The repo allowlist, the default-branch
 * refusal, the run command allowlist and the sandbox root all live in the AGENT,
 * where the credentials are — a guard on this side would be a guard on the wrong
 * side of the trust boundary. What this side guarantees is narrower and still worth
 * having: no directive exists without a human approval event behind it, every claim
 * carries that event's resolved provenance for the agent to check itself, and a run
 * lifecycle report is accepted only from the agent still HOLDING that work order's
 * lease.
 *
 * ── why the reads are POSTs ──────────────────────────────────────────────────
 *
 * `sensing/watchlist` reads. It is a POST because this is a machine surface where
 * every request already carries a bearer header and a body naming the caller
 * (`agent`) and its scope (`teamId`) — one request shape for the whole channel is
 * worth more here than REST verb purity, and nothing on this route is cacheable or
 * linkable.
 *
 * The clock is read HERE and passed in, like every other seam in the graph, so a
 * probe can expire a lease or replay an observation at a chosen instant.
 */

/** Work-order acknowledgements are tiny; an observation report carries a whole
 *  sweep's worth of facts, so the cap is the larger of the two needs and still far
 *  below anything that could hurt. Bigger than this is a mistake or an attack, and
 *  reading it would be the cost. */
const BODY_CAP = 512 * 1024

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
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export const Route = createFileRoute('/api/agent/$')({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const verb = String((params as { _splat?: string })._splat ?? '')

        // THE RUN'S OWN CHANNEL, and the ONE thing on this route that is not
        // authenticated by the channel token: a `graph` CLI call carries a RUN
        // credential (`graph/cli/identity.ts`), derived per run so the machine
        // agent never has to hand its own secret to a model. Checked first
        // because its answer is different (and narrower) than the channel's.
        if (verb === 'cli') return runCli(request)

        // Auth before anything else, and before any database import: an
        // unauthenticated request costs one string comparison.
        const { agentTokenMatches, agentChannelConfigured } = await import('../graph/agent/config.js')
        if (!agentChannelConfigured()) {
          return json({ error: 'unauthorized', detail: 'the machine agent channel is not configured on this server' }, 401)
        }
        if (!agentTokenMatches(request.headers.get('authorization'))) {
          return json({ error: 'unauthorized' }, 401)
        }

        const body = await readBody(request)
        if (!body) return json({ error: `body must be JSON and under ${Math.floor(BODY_CAP / 1024)}KB` }, 400)
        const agent = str(body.agent)
        if (!agent) return json({ error: 'agent is required (an instance id, recorded on the row)' }, 400)

        const { DEMO_TEAM_ID } = await import('../graph/workspace/specs.js')
        const teamId = str(body.teamId) ?? DEMO_TEAM_ID
        const now = new Date().toISOString()

        if (verb.startsWith('effects/')) return effects(verb.slice('effects/'.length), { agent, teamId, now, body })
        if (verb.startsWith('sensing/')) return sensing(verb.slice('sensing/'.length), { agent, teamId, now, body })
        if (verb.startsWith('runs/')) return runs(verb.slice('runs/'.length), { agent, now, body })
        return notFound()
      },
    },
  },
})

interface Ctx {
  agent: string
  teamId: string
  now: string
  body: Record<string, unknown>
}

// ---- the run's CLI: the seven verbs, driven by argv ----

/**
 * `POST /api/agent/cli  {runId, argv[]}` with the run's own bearer credential.
 *
 * The whole surface an in-run agent has (captain decision 15). It is deliberately
 * ONE endpoint taking argv rather than seven RPCs: the caller is a `graph` binary
 * that must stay a pure text sink, so parsing, the role fence and rendering all
 * happen here where there is one implementation of each. The verb ENDPOINTS the
 * UI uses (`/api/graph/verb/*`) call the same functions with a human actor.
 *
 * A refusal comes back 200 with a non-zero `exitCode`: the HTTP call SUCCEEDED in
 * delivering a refusal, and giving an agent a 4xx here would invite its client to
 * retry the transport instead of reading the answer. Transport-level failures
 * (bad credential, dead run) keep their real statuses.
 */
async function runCli(request: Request): Promise<Response> {
  const body = await readBody(request)
  if (!body) return json({ error: `body must be JSON and under ${Math.floor(BODY_CAP / 1024)}KB` }, 400)

  const runId = str(body.runId) ?? str(body.run)
  if (!runId) return json({ error: 'runId is required' }, 400)
  const argv = Array.isArray(body.argv) ? body.argv.filter((a): a is string => typeof a === 'string') : undefined
  if (!argv) return json({ error: 'argv must be an array of strings' }, 400)

  const { resolveRunContext } = await import('../graph/cli/context.js')
  const resolved = await resolveRunContext({
    runId,
    authorization: request.headers.get('authorization'),
    now: new Date().toISOString(),
  })
  if (!resolved.ok) {
    const { errorBlock } = await import('../gateway/toon.js')
    return json(
      { text: errorBlock(resolved.message, resolved.code), exitCode: 1, error: resolved.message, code: resolved.code },
      resolved.status,
    )
  }

  const { graphCli } = await import('../graph/cli/cli.js')
  const result = await graphCli(resolved.ctx, argv)
  return json({ text: result.text, exitCode: result.exitCode, json: result.json })
}

// ---- effects: the outward direction ----

async function effects(verb: string, ctx: Omit<Ctx, never>): Promise<Response> {
  const channel = await import('../graph/effects/channel.js')
  const { agent, teamId, now, body } = ctx

  if (verb === 'claim') {
    const limitRaw = num(body.limit) ?? Number(body.limit)
    const result = await channel.claimDirectives({
      now,
      agent,
      teamId,
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
      // A failure MUST be typed. An untyped one would leave the attention list
      // unable to say whether a retry is worth offering, which is the single most
      // useful thing it tells a person.
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
}

// ---- sensing: the inward direction ----

async function sensing(verb: string, ctx: Ctx): Promise<Response> {
  const watch = await import('../graph/sensing/watch.js')
  const { teamId, now, body } = ctx

  if (verb === 'watchlist') {
    const limit = num(body.limit)
    return json({ ok: true, ...(await watch.watchList({ teamId, ...(limit ? { limit } : {}) })) })
  }

  if (verb === 'observations') {
    const parsed = parseObservations(body.observations)
    if (!parsed.ok) return json({ error: parsed.why }, 400)
    const result = await watch.ingestObservations({
      now,
      teamId,
      observations: parsed.observations,
      unresolved: parseUnresolved(body.unresolved),
    })
    return json({ ok: true, ...result })
  }

  return notFound()
}

/**
 * Validate a reported fact set at the WIRE.
 *
 * The observation seam already refuses an observation aimed at the wrong mirror or
 * carrying an undeclared status, so this is not the safety boundary — it is the
 * shape boundary, and it exists because the seam's guarantees are about GRAPH
 * consistency while these are about not letting a malformed body reach it at all.
 * Every field is checked against the closed sets `sensing/pr.ts` declares; an
 * unknown `state` or `checks` value is a refusal rather than a coerced default,
 * because a coerced observation is a fabricated one.
 */
function parseObservations(
  raw: unknown,
): { ok: true; observations: import('../graph/sensing/pr.js').ObservedPr[] } | { ok: false; why: string } {
  if (!Array.isArray(raw)) return { ok: false, why: 'observations must be an array' }
  const states = new Set(['open', 'merged', 'closed'])
  const checks = new Set(['passing', 'failing', 'pending', 'none'])
  const out: import('../graph/sensing/pr.js').ObservedPr[] = []
  for (const [i, item] of raw.entries()) {
    const o = (item ?? {}) as Record<string, unknown>
    const repo = str(o.repo)
    const number = num(o.number)
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      return { ok: false, why: `observations[${i}].repo must be "owner/name"` }
    }
    if (!number || !Number.isSafeInteger(number) || number <= 0) {
      return { ok: false, why: `observations[${i}].number must be a positive integer` }
    }
    if (!states.has(String(o.state))) {
      return { ok: false, why: `observations[${i}].state must be one of ${[...states].join('|')}` }
    }
    if (!checks.has(String(o.checks))) {
      return { ok: false, why: `observations[${i}].checks must be one of ${[...checks].join('|')}` }
    }
    out.push({
      repo,
      number,
      state: o.state as 'open' | 'merged' | 'closed',
      merged: o.merged === true,
      checks: o.checks as 'passing' | 'failing' | 'pending' | 'none',
      title: str(o.title) ?? `PR #${number}`,
      draft: o.draft === true,
      ...(Array.isArray(o.references) ? { references: parseRefs(o.references) } : {}),
    })
  }
  return { ok: true, observations: out }
}

function parseRefs(raw: unknown[]): import('../graph/sensing/pr.js').PrIdentity[] {
  const out: import('../graph/sensing/pr.js').PrIdentity[] = []
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    const repo = str(r.repo)
    const number = num(r.number)
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) continue
    if (!number || !Number.isSafeInteger(number) || number <= 0) continue
    out.push({ repo, number })
  }
  return out
}

function parseUnresolved(raw: unknown): { externalId: string; why: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { externalId: string; why: string }[] = []
  for (const item of raw) {
    const u = (item ?? {}) as Record<string, unknown>
    const externalId = str(u.externalId)
    if (!externalId) continue
    out.push({ externalId, why: (str(u.why) ?? 'no reason reported').slice(0, 400) })
  }
  return out
}

// ---- runs: the runs bridge's report-back half ----

async function runs(verb: string, ctx: Omit<Ctx, 'teamId'>): Promise<Response> {
  const { runStarted, runFinished, isRunOutcome, isRunFinding, RUN_FINDINGS } = await import('../graph/agent/runs.js')
  const { agent, now, body } = ctx
  const directiveId = str(body.directive) ?? str(body.id)
  if (!directiveId) return json({ error: 'directive is required (the run work order this reports on)' }, 400)

  if (verb === 'started') {
    const r = await runStarted({ now, agent, directiveId })
    return r.ok ? json(r) : json(r, r.code === 'LEASE_LOST' ? 409 : 404)
  }

  if (verb === 'finished') {
    const outcome = body.outcome
    if (!isRunOutcome(outcome)) return json({ error: 'outcome must be "success" or "failure"' }, 400)
    // ABSENT is legal (an executor that does not speak the contract); a value
    // outside the closed set is REFUSED rather than coerced, for the same reason an
    // unknown observation `state` is - a coerced finding is a fabricated one, and
    // this one decides which transition the dispatching object runs.
    const finding = body.finding
    if (finding !== undefined && finding !== null && !isRunFinding(finding)) {
      return json({ error: `finding must be one of ${RUN_FINDINGS.join('|')} (or absent)` }, 400)
    }
    const report = (body.report ?? null) as { title?: unknown; body?: unknown } | null
    const r = await runFinished({
      now,
      agent,
      directiveId,
      outcome,
      ...(isRunFinding(finding) ? { finding } : {}),
      summary: str(body.summary) ?? null,
      exitCode: num(body.exitCode) ?? null,
      durationMs: num(body.durationMs) ?? null,
      report: report && str(report.body) ? { title: str(report.title) ?? null, body: String(report.body) } : null,
    })
    return r.ok ? json(r) : json(r, r.code === 'LEASE_LOST' ? 409 : 404)
  }

  return notFound()
}
