import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE — UNATTENDED DISCOVERY REACHES A PERSON, over a REAL pglite database
 * and the SHIPPED type specs (`DEMO_TYPES`), not a scratch type.
 *
 * The chain under test is the whole story, with nobody watching at any step:
 *
 *   the clock fires  →  the fire DISPATCHES a run (and does nothing else)
 *   a machine agent claims the work order and runs it
 *   the run CALLS `graph review request` over its own credential
 *   the review's gate opens  →  the item is in "Needs you"
 *   the run REPORTS BACK  →  the loop records that this fire found something
 *
 * ── the change captain decision 15 made here ────────────────────────────────
 *
 * The review used to be created BY THE ENGINE: `escalate` declared an
 * `enqueue-review` action and the outbox built a shepherd over the run's report.
 * That is spec-declared sequencing, and decision 15 moves it into the agent - so
 * the run asks, in as many words, through the same seam. The last probe in this
 * file pins the old chain as GONE, because two paths to one review is exactly the
 * drift the decision exists to prevent.
 *
 * ── why the shape is this and not "let the clock open the review" ────────────
 *
 * The captain's ruling (`decisions/clock-opens-review.md`): a periodic human review
 * is always worth an agent gathering the materials first, so the clock keeps exactly
 * one power — dispatch — and the RUN'S REPORT-BACK is what opens the gate, through
 * the `agent-run`/`rule` entrance every review already admits. The last probe here is
 * the one that keeps that true: no shipped type may declare a gate-opening transition
 * the clock can enter.
 *
 * Every instant is explicit and passed in; nothing in this file sleeps.
 */

let tmp: string
let graph: typeof import('../../db/graphStore.js')
let read: typeof import('./read.js')
let sched: typeof import('../schedule/scheduler.js')
let arm: typeof import('../schedule/arm.js')
let cadence: typeof import('../schedule/cadence.js')
let exec: typeof import('../outbox/executor.js')
let channel: typeof import('../effects/channel.js')
let runs: typeof import('../agent/runs.js')
let specs: typeof import('./specs.js')
let cli: typeof import('../cli/cli.js')
let context: typeof import('../cli/context.js')
let identity: typeof import('../cli/identity.js')

const USER = 'u-discovery-captain'
/** The machine-agent channel secret this probe's run credentials derive from. */
const CHANNEL_TOKEN = 'probe-channel-secret'
const AGENT = 'probe-machine-agent'
const T0 = '2026-07-30T09:00:00.000Z'

/** One probe's isolated world: its own team, carrying the BUILTIN archetypes plus
 *  every shipped demo type, armed exactly the way the seed arms them. */
async function world(name: string): Promise<string> {
  const teamId = `team-discovery-${name}`
  await graph.seedBuiltinTypes(undefined, teamId, T0)
  for (const t of specs.DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      rationale: t.rationale,
      now: T0,
    })
    await graph.armTypeVersion(undefined, { teamId, name: t.name, version: 1, now: T0 })
  }
  return teamId
}

/** A loop with a cadence ARMED by a human — the standing approval its R3 fire rests
 *  on. `activate` first, because a loop is born `planned` and arming is a human act. */
async function armedLoop(teamId: string, title: string) {
  const object = await graph.createObject(undefined, {
    teamId,
    archetype: 'task',
    type: 'loop',
    status: 'planned',
    title,
    // `role` is what decides which verbs its runs may call (decision 15a), and
    // `workflow` is the prose composed into their work orders (decision 15.5).
    // Both are INSTANCE FIELDS - that is the whole point.
    payload: {
      brief: 'watch the thing and report',
      band: 'platform',
      role: 'discovery',
      workflow: 'Look at the export. If it is empty again, write it up and ask a person.',
    },
    now: T0,
  })
  const { applyTransition } = await import('../applyTransition.js')
  const activated = await applyTransition({
    objectId: object.id,
    transition: 'activate',
    actor: { entrance: 'human', actorId: USER },
    now: T0,
  })
  if (!activated.ok) throw new Error(`probe could not activate: ${activated.code} ${activated.message}`)
  const parsed = cadence.parseCadence({ interval: '2m' })
  if (!parsed.ok) throw new Error(parsed.why)
  const armed = await arm.armSchedule({ objectId: object.id, cadence: parsed.spec, userId: USER, now: T0 })
  if (!armed.ok) throw new Error(`probe could not arm: ${armed.code} ${armed.message}`)
  const { eq } = await import('drizzle-orm')
  const dbmod = await import('../../db/index.js')
  const schema = await import('../../db/graph-schema.js')
  await dbmod.db.update(schema.objects).set({ nextFire: T0 }).where(eq(schema.objects.id, object.id))
  return (await graph.getObject(undefined, object.id))!
}

/**
 * The whole unattended chain, up to the moment the run reports back.
 *
 * Deliberately no shortcuts: the clock fires through `runOnce`, the outbox turns the
 * declared dispatch into a work order, and the work order is CLAIMED through the real
 * channel so the run report-back passes the lease check a zombie would fail.
 */
async function fireAndClaim(teamId: string, objectId: string, at: string) {
  const pass = await sched.runOnce({ now: at, teamId })
  if (pass.fired !== 1) throw new Error(`probe expected one fire, got ${JSON.stringify(pass)}`)
  await exec.drainOutbox({ now: at, teamId, maxPasses: 4 })
  const claim = await channel.claimDirectives({ now: at, agent: AGENT, teamId })
  const directive = claim.directives.find((d) => d.objectId === objectId && d.kind === 'run-task')
  if (!directive) throw new Error('probe claimed no run work order')
  await runs.runStarted({ now: at, agent: AGENT, directiveId: directive.id })
  return directive
}

/**
 * ONE `graph` COMMAND, as the run itself would send it.
 *
 * Deliberately the FULL path: the credential is derived exactly the way the
 * machine agent derives it (`runCliToken`), resolved exactly the way the wire
 * resolves it (`resolveRunContext`, which re-checks that the work order is still
 * claimed), and dispatched through the real argv router. A helper that called the
 * verb functions directly would prove the verbs work and say nothing about
 * whether a run can actually reach them.
 */
async function runCli(directiveId: string, argv: string[]) {
  const resolved = await context.resolveRunContext({
    runId: `run-${directiveId}`,
    authorization: `Bearer ${identity.runCliToken(CHANNEL_TOKEN, `run-${directiveId}`)}`,
    now: '2026-07-30T09:00:30.000Z',
  })
  if (!resolved.ok) throw new Error(`probe could not resolve the run: ${resolved.code} ${resolved.message}`)
  return cli.graphCli(resolved.ctx, argv)
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-discovery-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'
  process.env.LOOPANY_AGENT_TOKEN = CHANNEL_TOKEN
  delete process.env.DATABASE_URL

  const dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../../db/graphStore.js')
  read = await import('./read.js')
  sched = await import('../schedule/scheduler.js')
  arm = await import('../schedule/arm.js')
  cadence = await import('../schedule/cadence.js')
  exec = await import('../outbox/executor.js')
  channel = await import('../effects/channel.js')
  runs = await import('../agent/runs.js')
  specs = await import('./specs.js')
  cli = await import('../cli/cli.js')
  context = await import('../cli/context.js')
  identity = await import('../cli/identity.js')
}, 120_000)

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 — a scheduled fire whose run reports a discovery lands in "Needs you"
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an unattended fire whose run finds something reaches a person', () => {
  it('opens a human-verdict gate through the run’s OWN `review request`, with nobody in the chain', async () => {
    const team = await world('discovery')
    const loop = await armedLoop(team, 'Scratch survey (scheduled)')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    // THE RUN'S OWN HANDS. Not a helper and not a declared action: the real argv
    // path, over the real run credential, exactly as `graph` sends it from inside
    // a dispatched run.
    const pushed = await runCli(directive.id, [
      'artifact',
      'push',
      'export-watch.md',
      '--body',
      '# Export watch\n\nThree empty exports in a row.\n',
      '--title',
      'Export watch — 2026-07-30',
    ])
    expect(pushed.exitCode).toBe(0)
    const reportId = String((pushed.json as Record<string, unknown>).objectId)

    const asked = await runCli(directive.id, [
      'review',
      'request',
      '--about',
      reportId,
      '--question',
      'The nightly export has been empty for three days — do we page the data team?',
    ])
    expect(asked.exitCode).toBe(0)
    // SELF-GUIDING (decision 15b): the result tells the run what happens next.
    expect(asked.text).toContain('waiting on a person')
    expect(asked.text).toContain('help[')

    // The run then reports its outcome, which records that this fire found
    // something - and, since decision 15, does nothing else.
    const finished = await runs.runFinished({
      now: '2026-07-30T09:01:00.000Z',
      agent: AGENT,
      directiveId: directive.id,
      outcome: 'success',
      finding: 'discovery',
      summary: 'the nightly export has been empty for three days',
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    // The FINDING chose the path: `escalate`, not the plain `complete`.
    expect(finished.advanced?.transition).toBe('escalate')

    const drained = await exec.drainOutbox({ now: '2026-07-30T09:01:01.000Z', teamId: team, maxPasses: 4 })
    expect(drained.deadLettered).toBe(0)

    const inbox = await read.inboxView(team)
    expect(inbox.items).toHaveLength(1)
    const item = inbox.items[0]!
    expect(item.class).toBe('human-verdict')
    // ONE key on ONE type since the collapse (captain decision 16) - the five
    // shepherd types and their five obligation keys are gone.
    expect(item.key).toBe('verdict')
    expect(item.type).toBe('review')
    // The person is deciding about the RUN'S REPORT — the context the run prepared.
    expect(item.reviews).toBe(reportId)
    // …and the row carries the transition that discharges it, so it is actionable.
    expect(item.verdict?.transition).toBe('approve')

    // THE PROVENANCE CHAIN, end to end, with no human entrance anywhere in it.
    const loopEvents = await graph.listObjectEvents(undefined, loop.id)
    const fire = loopEvents.find((e) => e.transition === 'fire')!
    expect(fire.entrance).toBe('clock')
    expect(fire.actorId).toBe(sched.scheduleActorId(loop.id))
    // The fire's only consequence is the dispatch. It opened nothing.
    expect((await graph.listActionsForEvent(undefined, fire.id)).map((a) => a.kind)).toEqual(['dispatch-outward-run'])

    const escalate = loopEvents.find((e) => e.transition === 'escalate')!
    expect(escalate.entrance).toBe('rule')
    expect((escalate.payload as Record<string, unknown>).finding).toBe('discovery')
    // AND IT CAUSED NOTHING. The old `enqueue-review` chain is gone; the review
    // exists because the run asked for it.
    expect(await graph.listActionsForEvent(undefined, escalate.id)).toEqual([])

    const reviewEvents = await graph.listObjectEvents(undefined, item.objectId)
    const opened = reviewEvents.find((e) => e.transition === 'submit')!
    // THE RUN opened it, as itself - the actor is the run id, which is what
    // `entrance: "agent-run"` means (design §12).
    expect(opened.entrance).toBe('agent-run')
    expect(opened.actorId).toBe(`run-${directive.id}`)

    const chain = [fire, escalate, opened]
    for (const e of chain) expect(e.entrance).not.toBe('human')

    // The count and the list agree, which is what the badge renders from.
    expect((await read.summaryView(team)).needsYou).toBe(inbox.items.length)
  }, 120_000)

  it('is idempotent: the same `review request` twice opens ONE review', async () => {
    const team = await world('replay')
    const loop = await armedLoop(team, 'Replay survey')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    const ask = () =>
      runCli(directive.id, ['review', 'request', '--question', 'Does this need a person?', '--preset', 'decision'])
    const first = await ask()
    // A RETRY - the exact shape a run takes when it lost the first response.
    const second = await ask()
    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    expect((second.json as Record<string, unknown>).objectId).toBe((first.json as Record<string, unknown>).objectId)
    expect(second.text).toContain('replay')

    await exec.drainOutbox({ now: '2026-07-30T09:01:02.000Z', teamId: team, maxPasses: 4 })
    expect((await read.inboxView(team)).items).toHaveLength(1)
    expect(await graph.listObjects(undefined, team, { type: 'review' })).toHaveLength(1)
  }, 120_000)

  it('refuses a verb outside the run’s role, and says what the role MAY do', async () => {
    const team = await world('role')
    const loop = await armedLoop(team, 'Role survey')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    // The loop's role is `discovery`, which does not include `wait open`
    // (decision 15a: one to three verbs, never seven).
    const refused = await runCli(directive.id, [
      'wait',
      'open',
      loop.id,
      '--key',
      'anything',
      '--question',
      'well?',
      '--watcher',
      loop.id,
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.text).toContain('FORBIDDEN')
    expect(refused.text).toContain('discovery')
    // THE WAY OUT, every time (decision 15b).
    expect(refused.text).toContain('graph task create')
    expect(refused.text).toContain('graph review request')
  }, 120_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 — a run that found nothing wakes nobody
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a work order STATES what this loop has already produced, even when nothing', () => {
  it('carries `alreadyRecorded` as an empty list rather than omitting the key', async () => {
    // Absent and empty are different answers to "what have I already filed?", and a
    // run cannot tell a harness that stayed silent from a graph that holds nothing.
    // The first live triage run on loopany-testing hit exactly this: it fell back to
    // reconstructing a duplicate-check from `git log`, and said in its own report
    // that the key was "absent, not empty".
    const team = await world('already-empty')
    const loop = await armedLoop(team, 'Scratch survey (nothing filed yet)')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    const context = (directive.payload as { context: Record<string, unknown> }).context
    expect(context).toHaveProperty('alreadyRecorded')
    expect(context.alreadyRecorded).toEqual([])
  })

  it('lists what the loop produced once it has produced something', async () => {
    const team = await world('already-filled')
    const loop = await armedLoop(team, 'Scratch survey (one task filed)')
    const first = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')
    const made = await runCli(first.id, ['task', 'create', '--type', 'task', '--title', 'Empty exports'])
    expect(made.exitCode).toBe(0)
    // The loop is `running` until its run reports back, so the second fire needs the
    // first one closed - the same order a real day has.
    const done = await runs.runFinished({
      now: '2026-07-30T09:01:00.000Z',
      agent: AGENT,
      directiveId: first.id,
      outcome: 'success',
      summary: 'filed one',
    })
    expect(done.ok).toBe(true)
    await exec.drainOutbox({ now: '2026-07-30T09:01:01.000Z', teamId: team, maxPasses: 4 })

    // The NEXT fire tells the next run what the last one already recorded - which is
    // the whole mechanism behind "check reality before acting".
    const second = await fireAndClaim(team, loop.id, '2026-07-31T09:00:05.000Z')
    const context = (second.payload as { context: Record<string, unknown> }).context
    const already = context.alreadyRecorded as { title: string | null }[]
    expect(already.map((a) => a.title)).toContain('Empty exports')
  })
})

describe('probe: a run reporting nothing-new opens nothing', () => {
  it('stands the loop down and leaves the inbox empty', async () => {
    const team = await world('quiet')
    const loop = await armedLoop(team, 'Quiet survey')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    const finished = await runs.runFinished({
      now: '2026-07-30T09:01:00.000Z',
      agent: AGENT,
      directiveId: directive.id,
      outcome: 'success',
      finding: 'nothing-new',
      summary: 'nothing changed since yesterday',
      report: { title: 'Quiet report', body: 'Nothing to report.\n' },
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    // "Nothing found" is a first-class outcome, and it has its own transition so the
    // Timeline does not read a quiet run as an ordinary completion.
    expect(finished.advanced?.transition).toBe('stand-down')
    expect(finished.advanced?.status).toBe('idle')

    await exec.drainOutbox({ now: '2026-07-30T09:01:01.000Z', teamId: team, maxPasses: 4 })
    expect((await read.inboxView(team)).items).toHaveLength(0)
    expect((await read.summaryView(team)).needsYou).toBe(0)
    expect(await graph.listObjects(undefined, team, { type: 'review' })).toHaveLength(0)
  }, 120_000)

  it('falls back to the plain success path when the run reports NO finding at all', async () => {
    // An executor that does not speak the contract (or a run that never answered)
    // must behave exactly as it did before findings existed - quiet, and `complete`.
    const team = await world('silent')
    const loop = await armedLoop(team, 'Silent survey')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    const finished = await runs.runFinished({
      now: '2026-07-30T09:01:00.000Z',
      agent: AGENT,
      directiveId: directive.id,
      outcome: 'success',
      report: { title: 'Silent report', body: 'did the work\n' },
    })
    expect(finished.ok && finished.advanced?.transition).toBe('complete')
    await exec.drainOutbox({ now: '2026-07-30T09:01:01.000Z', teamId: team, maxPasses: 4 })
    expect((await read.inboxView(team)).items).toHaveLength(0)
  }, 120_000)

  it('ignores a finding on a FAILED run - a run that broke cannot say what it found', async () => {
    const team = await world('broken')
    const loop = await armedLoop(team, 'Broken survey')
    const directive = await fireAndClaim(team, loop.id, '2026-07-30T09:00:05.000Z')

    const finished = await runs.runFinished({
      now: '2026-07-30T09:01:00.000Z',
      agent: AGENT,
      directiveId: directive.id,
      outcome: 'failure',
      finding: 'discovery',
      summary: 'the run exited 1',
    })
    expect(finished.ok && finished.advanced?.transition).toBe('fail')
    await exec.drainOutbox({ now: '2026-07-30T09:01:01.000Z', teamId: team, maxPasses: 4 })
    expect((await read.inboxView(team)).items).toHaveLength(0)
  }, 120_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 — the clock still cannot open a gate
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: no shipped type lets the CLOCK open a human gate', () => {
  it('keeps every gate-opening transition off the clock entrance', () => {
    const offenders: string[] = []
    for (const t of specs.DEMO_TYPES) {
      for (const transition of t.spec.transitions) {
        const opensGate = (transition.opens ?? []).some((g) => g.class === 'human-verdict')
        if (!opensGate) continue
        const entrance = transition.entrance
        const set = entrance === undefined ? ['<unrestricted>'] : Array.isArray(entrance) ? entrance : [entrance]
        // Unrestricted is an offender too: it ADMITS the clock, which is the same
        // hole with better manners.
        if (set.includes('clock') || set.includes('<unrestricted>')) offenders.push(`${t.name}.${transition.name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps `enqueue-review` off every clock-enterable transition', () => {
    // The other half of the same ruling: a fire must not be able to CAUSE a review
    // either, which a clock-entered `enqueue-review` action would do just as
    // effectively as a clock-entered gate.
    const offenders: string[] = []
    for (const t of specs.DEMO_TYPES) {
      for (const transition of t.spec.transitions) {
        const entrance = transition.entrance
        const set = entrance === undefined ? [] : Array.isArray(entrance) ? entrance : [entrance]
        if (!set.includes('clock')) continue
        if ((transition.actions ?? []).some((a) => a.kind === 'enqueue-review')) offenders.push(`${t.name}.${transition.name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('leaves the loop’s fire with exactly one power: dispatch', () => {
    const fire = specs.LOOP_SPEC.transitions.find((t) => t.name === 'fire')!
    expect(fire.entrance).toBe('clock')
    expect((fire.actions ?? []).map((a) => a.kind)).toEqual(['dispatch-outward-run'])
    expect(fire.opens ?? []).toEqual([])
    // And the escalation it eventually causes is on the RUN REPORT-BACK path -
    // where it now DECLARES NOTHING. Captain decision 15 moved "and then open a
    // review" out of the spec and into the agent, so this transition is a
    // guardrail (it records that this fire found something) and not a chain.
    const escalate = specs.LOOP_SPEC.transitions.find((t) => t.name === 'escalate')!
    expect(escalate.entrance).toEqual(['agent-run', 'rule'])
    expect(escalate.actions ?? []).toEqual([])

    // THE DE-HARDCODING, stated once over the whole shipped catalogue: no type
    // declares an `enqueue-review` or a `register-watch` any more. Both are verbs
    // an agent calls (`review request`, `wait open`), and leaving a declaration
    // behind would be the second competing path decision 15 exists to remove.
    const chains: string[] = []
    for (const t of specs.DEMO_TYPES) {
      for (const transition of t.spec.transitions) {
        for (const action of transition.actions ?? []) {
          if (action.kind === 'enqueue-review' || action.kind === 'register-watch') {
            chains.push(`${t.name}.${transition.name} → ${action.kind}`)
          }
        }
      }
    }
    expect(chains).toEqual([])
  })
})
