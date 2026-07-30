import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE — THE RUNS BRIDGE, over a REAL pglite database.
 *
 * The thing under test is the whole path a piece of WORK takes, minus the machine
 * itself:
 *
 *   a human approves  →  applyTransition enqueues the R3 dispatch against its OWN
 *                        human event as the approval
 *   the executor runs →  the handler writes a `run-task` DIRECTIVE carrying a
 *                        generic instruction (intent + context + scope). It never
 *                        executes anything - the server runs no work.
 *   an agent claims   →  with a lease, and with the approval evidence attached
 *   the run reports   →  run-started, then run-finished, which advances the
 *                        DISPATCHING task and can land a report doc
 *   or it dies        →  the lease expires and the failure becomes an attention
 *                        item naming the task, so nothing hangs silently
 *
 * Each block is one property that would cause a real incident if it stopped
 * holding, written the way the incident would find it:
 *
 *   1. dispatch            approve ⇒ exactly ONE run work order, with a human
 *                          approval block, a derived run id and the resolved
 *                          instruction; the same action twice ⇒ still one
 *   2. claim exclusivity   two agents claiming at once ⇒ one execution
 *   3. lease expiry        an abandoned claim returns to `pending`; past the budget
 *                          it FAILS into Attention naming the dispatching task
 *   4. report-back         run-finished advances the task EXACTLY ONCE, replay-safe,
 *                          with a report doc created through the kernel path
 *   5. failure surfacing   a failed run advances the failure transition AND leaves a
 *                          typed attention item; a dead agent's unfinished run is
 *                          visible, never a silently stuck task
 *   6. the lease is authority   only the holder may report a run lifecycle
 *   7. the ceiling         a malformed declaration dead-letters; the R2 `dispatch-run`
 *                          has no delivery shape at all
 *
 * Every probe passes `now` explicitly - nothing in this path reads a clock - so "the
 * lease expired" is an assertion rather than a sleep.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let graph: typeof import('../../db/graphStore.js')
let at: typeof import('../applyTransition.js')
let exec: typeof import('../outbox/executor.js')
let attention: typeof import('../outbox/attention.js')
let channel: typeof import('../effects/channel.js')
let instruction: typeof import('../effects/instruction.js')
let runs: typeof import('./runs.js')
let specs: typeof import('../workspace/specs.js')
let schema: typeof import('../../db/graph-schema.js')

const TEAM = 'team-runs'
const USER = 'u-probe-captain'
const NOW = '2026-07-30T09:00:00.000Z'
const SOON = '2026-07-30T09:00:30.000Z'
/** Comfortably past a 60s lease. */
const LATER = '2026-07-30T09:30:00.000Z'
/** Successive instants, each past the previous claim's lease, so a run of abandoned
 *  claims really does burn the attempt budget (`maxClaims()` is 3). */
const LEASE_CYCLE = ['2026-07-30T10:00:00.000Z', '2026-07-30T10:30:00.000Z', '2026-07-30T11:00:00.000Z']
const AFTER_CYCLE = '2026-07-30T12:00:00.000Z'

/** Arm the shipped demo types, so a probe cannot pass against a state machine the
 *  product does not have. */
async function armTypes(): Promise<void> {
  await graph.seedBuiltinTypes(undefined, TEAM, NOW)
  for (const t of specs.DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId: TEAM,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      now: NOW,
    })
    await graph.armTypeVersion(undefined, { teamId: TEAM, name: t.name, version: 1, now: NOW })
  }
}

/**
 * One `agent-task` parked in its verdict gate, exactly as `pnpm graph:dispatch`
 * leaves it: `submit` run by the agent run that staged it, its own actions settled so
 * the terminal transitions are not blocked by them.
 */
async function pendingTask(
  brief: string,
  over: Record<string, unknown> = {},
): Promise<import('../../db/graph-schema.js').GraphObject> {
  const task = await graph.createObject(undefined, {
    teamId: TEAM,
    archetype: 'task',
    type: 'agent-task',
    status: 'queued',
    title: brief.slice(0, 80),
    payload: { brief, ...over },
    now: NOW,
  })
  const submitted = await at.applyTransition({
    objectId: task.id,
    transition: 'submit',
    actor: { entrance: 'agent-run', actorId: 'run-probe' },
    now: NOW,
  })
  expect(submitted.ok).toBe(true)
  await exec.drainOutbox({ now: NOW, teamId: TEAM, maxPasses: 8 })
  return (await graph.getObject(undefined, task.id))!
}

/** The human verdict that dispatches it, plus the outbox pass that turns the
 *  approved action into a work order. Returns the directive. */
async function approve(taskId: string, now = NOW) {
  const approved = await at.applyTransition({
    objectId: taskId,
    transition: 'approve',
    actor: { entrance: 'human', actorId: USER },
    now,
  })
  expect(approved.ok).toBe(true)
  await exec.drainOutbox({ now, teamId: TEAM, maxPasses: 8 })
  const found = (await graph.listDirectives(undefined, TEAM, 100)).filter((d) => d.objectId === taskId)
  return { approved, directives: found }
}

/** Claim on behalf of an agent, the way the wire does. */
async function claim(agent: string, now = NOW) {
  return channel.claimDirectives({ now, agent, teamId: TEAM })
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-runs-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  graph = await import('../../db/graphStore.js')
  at = await import('../applyTransition.js')
  exec = await import('../outbox/executor.js')
  attention = await import('../outbox/attention.js')
  channel = await import('../effects/channel.js')
  instruction = await import('../effects/instruction.js')
  runs = await import('./runs.js')
  specs = await import('../workspace/specs.js')
  schema = await import('../../db/graph-schema.js')

  await armTypes()
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Each block starts from a clean team (types survive) so counts are absolute. */
beforeEach(async () => {
  const { eq } = await import('drizzle-orm')
  await dbmod.db.delete(schema.effectDirectives).where(eq(schema.effectDirectives.teamId, TEAM))
  await dbmod.db.delete(schema.graphNotifications).where(eq(schema.graphNotifications.teamId, TEAM))
  await dbmod.db.delete(schema.gateObligations).where(eq(schema.gateObligations.teamId, TEAM))
  await dbmod.db.delete(schema.outboxActions).where(eq(schema.outboxActions.teamId, TEAM))
  await dbmod.db.delete(schema.events).where(eq(schema.events.teamId, TEAM))
  await dbmod.db.delete(schema.edges).where(eq(schema.edges.teamId, TEAM))
  await dbmod.db.delete(schema.objects).where(eq(schema.objects.teamId, TEAM))
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - dispatch: an approved verdict becomes exactly one work order
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: approving a dispatch writes exactly one run work order', () => {
  it('carries the resolved instruction, the human approval and a derived run id', async () => {
    const task = await pendingTask('Survey the scratch directory.', { workdir: 'probe-1' })
    expect(task.status).toBe('awaiting-dispatch')

    const { approved, directives } = await approve(task.id)
    expect(approved.ok && approved.object.status).toBe('dispatched')
    expect(directives).toHaveLength(1)
    const d = directives[0]!
    expect(d.kind).toBe('run-task')
    expect(d.state).toBe('pending')
    // The target is the MACHINE, not a repo - a run's external entity is the run.
    expect(d.targetSource).toBe('machine')
    expect(d.objectId).toBe(task.id)
    // The approval this rests on is the human transition's OWN event (the
    // self-approval rule), and the executor re-resolved it before writing this row.
    expect(d.approvalEvent).toBe(approved.ok ? approved.event.id : '')

    // The INSTRUCTION: generic (intent + context + scope), with the instance's own
    // brief and workdir folded in. Nothing command-shaped anywhere on the row.
    const spec = instruction.instructionOf(d.payload)!
    expect(spec.runId).toBe(`run-${d.id}`)
    expect(spec.intent).toContain('context.object.brief')
    expect(spec.scope.workdir).toBe('probe-1')
    expect(spec.onSuccess).toBe('succeeded')
    expect(spec.onFailure).toBe('broke')
    expect((spec.context.object as Record<string, unknown>).brief).toBe('Survey the scratch directory.')
    expect(spec.context.dispatchedBy).toBe(task.id)

    // A claimed work order carries the approval EVIDENCE for the agent's own third
    // re-check - absent would mean the agent must refuse.
    const claimed = await claim('agent-a')
    expect(claimed.directives).toHaveLength(1)
    expect(claimed.directives[0]!.approval).toMatchObject({ entrance: 'human', actorId: USER })
  })

  it('the same action executed twice yields ONE work order', async () => {
    const task = await pendingTask('Do it once.')
    const { directives } = await approve(task.id)
    expect(directives).toHaveLength(1)
    const action = (await graph.listActionsForEvent(undefined, directives[0]!.eventId)).find(
      (a) => a.kind === 'dispatch-outward-run',
    )!

    // Force the at-least-once boundary: put the action back and run it again. The
    // directive's primary key IS the action id, so the second pass collides.
    await dbmod.db
      .update(schema.outboxActions)
      .set({ state: 'pending', deliveredAt: null, claimedAt: null, claimedBy: null })
      .where((await import('drizzle-orm')).eq(schema.outboxActions.id, action.id))
    await exec.drainOutbox({ now: SOON, teamId: TEAM, maxPasses: 4 })

    const after = (await graph.listDirectives(undefined, TEAM, 100)).filter((d) => d.kind === 'run-task')
    expect(after).toHaveLength(1)
    // And the run identity did not fork either, which is what makes the report-back
    // path replay-safe.
    expect(instruction.instructionOf(after[0]!.payload)!.runId).toBe(`run-${action.id}`)
  })

  it('the instance can FILL the scope its static declaration left open, never widen it', async () => {
    // `withObjectScope`'s direction, asserted end to end: the task supplies its own
    // repos, and the declaration's pinned `writes` is untouched by anything the
    // instance says.
    const task = await pendingTask('Look at the repo.', { repos: 'acme/widgets, acme/other', writes: ['everything'] })
    const { directives } = await approve(task.id)
    const spec = instruction.instructionOf(directives[0]!.payload)!
    expect(spec.scope.repos).toEqual(['acme/widgets', 'acme/other'])
    // The static declaration pinned this; the instance's `writes` field did not win.
    expect(spec.scope.writes).toEqual(['report.md'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - one work order, one execution
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: the same work order claimed twice is executed once', () => {
  it('two agents claiming at the same instant take disjoint sets', async () => {
    for (const brief of ['a', 'b', 'c']) {
      const task = await pendingTask(`work ${brief}`)
      await approve(task.id)
    }
    const [first, second] = await Promise.all([claim('agent-a'), claim('agent-b')])
    const ids = [...first.directives, ...second.directives].map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)

    // And a third agent gets nothing: every row is held.
    expect((await claim('agent-c')).directives).toHaveLength(0)
  })

  it('a second claim by the same agent does not re-offer what it holds', async () => {
    const task = await pendingTask('hold it')
    await approve(task.id)
    expect((await claim('agent-a')).directives).toHaveLength(1)
    expect((await claim('agent-a')).directives).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - lease expiry: a dead agent's run is recovered, then surfaced
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an abandoned run comes back, and eventually surfaces', () => {
  it('returns to pending on expiry and FAILS into Attention past the budget', async () => {
    const task = await pendingTask('abandon me')
    const { directives } = await approve(task.id)
    const id = directives[0]!.id

    // Claim and die. The next claim - by anybody - reclaims it first.
    expect((await claim('agent-dead')).directives).toHaveLength(1)
    const recovered = await claim('agent-b', LATER)
    expect(recovered.requeued).toBe(1)
    expect(recovered.directives.map((d) => d.id)).toEqual([id])

    // Keep dying. Past the attempt budget the row FAILS rather than cycling forever.
    for (const instant of LEASE_CYCLE) await claim('agent-b', instant)
    const settled = (await graph.getDirective(undefined, id))!
    expect(settled.state).toBe('failed')
    expect(settled.refusalCode).toBe('LEASE_EXPIRED')

    // AND IT IS VISIBLE, naming the task that is still waiting on it. This is the
    // probe for "a dead agent's unfinished run never hangs the task silently".
    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.ref === id)!
    expect(item.kind).toBe('directive-failed')
    expect(item.objectId).toBe(task.id)
    expect(item.reason).toBe('LEASE_EXPIRED')
    // An expiry is worth another go - unlike a guard refusal.
    expect(item.retryable).toBe(true)

    // The task itself is honest about where it is: still dispatched, not silently
    // "done" and not falsely "failed". A person now has both facts.
    expect((await graph.getObject(undefined, task.id))!.status).toBe('dispatched')
    // …and the run's own start is in the log, so "did anything ever happen?" has an
    // answer even though nothing reported back.
    const started = (await graph.listObjectEvents(undefined, task.id)).filter((e) => e.kind === 'run-started')
    expect(started).toHaveLength(0) // this run never even started - and that is the truth
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - report-back: the task advances exactly once
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: run-finished advances the dispatching task exactly once', () => {
  it('records the lifecycle, lands a report doc, and advances through applyTransition', async () => {
    const task = await pendingTask('produce a report')
    const { directives } = await approve(task.id)
    const d = directives[0]!
    await claim('agent-a')

    const started = await runs.runStarted({ now: NOW, agent: 'agent-a', directiveId: d.id })
    expect(started.ok && started.replay).toBe(false)
    expect(started.ok && started.runId).toBe(`run-${d.id}`)
    // "Started" is not an outcome: the task has NOT moved.
    expect((await graph.getObject(undefined, task.id))!.status).toBe('dispatched')

    const finished = await runs.runFinished({
      now: SOON,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'success',
      summary: 'Found three files and changed nothing.',
      exitCode: 0,
      durationMs: 1234,
      report: { title: 'Scratch survey', body: '# Scratch survey\n\nThree files, nothing to do.\n' },
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    expect(finished.advanced).toMatchObject({ transition: 'succeeded', status: 'done', replay: false })
    expect(finished.report?.created).toBe(true)

    // The task really moved, through the seam, with RULE provenance - the engine's
    // declarative consequence of a run finishing, not the run reaching in.
    const after = (await graph.getObject(undefined, task.id))!
    expect(after.status).toBe('done')
    const advance = (await graph.listObjectEvents(undefined, task.id)).find(
      (e) => e.kind === 'status-changed' && e.transition === 'succeeded',
    )!
    expect(advance.entrance).toBe('rule')
    expect(advance.origin).toBe('derived')

    // The RUN's own events carry agent-run provenance with the run as the actor.
    const lifecycle = (await graph.listObjectEvents(undefined, task.id)).filter((e) =>
      ['run-started', 'run-finished'].includes(e.kind),
    )
    expect(lifecycle).toHaveLength(2)
    for (const e of lifecycle) {
      expect(e.entrance).toBe('agent-run')
      expect(e.actorId).toBe(`run-${d.id}`)
      expect(e.origin).toBe('derived')
    }

    // The report is a real DOC, produced by the task, with the run as provenance and
    // a v1 artifact head - so the Library renders it like any other product.
    const doc = (await graph.getObject(undefined, finished.report!.objectId))!
    expect(doc.archetype).toBe('doc')
    expect(doc.type).toBe('report')
    expect(String((doc.payload as Record<string, unknown>).source)).toContain('type: report')
    expect(String((doc.payload as Record<string, unknown>).source)).toContain('Three files, nothing to do.')
    const produced = await graph.edgesFrom(undefined, task.id, 'produces')
    expect(produced.map((e) => e.dstId)).toContain(doc.id)
  })

  it('a re-delivered report changes nothing at all', async () => {
    const task = await pendingTask('replay me')
    const { directives } = await approve(task.id)
    const d = directives[0]!
    await claim('agent-a')

    const args = {
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'success' as const,
      summary: 'done',
      exitCode: 0,
      report: { title: 'R', body: 'body' },
    }
    await runs.runStarted({ now: NOW, agent: 'agent-a', directiveId: d.id })
    const first = await runs.runFinished({ ...args, now: SOON })
    expect(first.ok && first.replay).toBe(false)
    const events = await graph.countEvents(undefined, TEAM)
    const objects = (await graph.listObjects(undefined, TEAM)).length

    // The same report again, at a different instant. Every id is derived from the run,
    // so it all collides: no second event, no second doc, no second advance.
    const again = await runs.runFinished({ ...args, now: LATER })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.replay).toBe(true)
    expect(again.advanced?.replay).toBe(true)
    expect(again.report?.created).toBe(false)
    expect(await graph.countEvents(undefined, TEAM)).toBe(events)
    expect((await graph.listObjects(undefined, TEAM)).length).toBe(objects)
    expect((await graph.getObject(undefined, task.id))!.status).toBe('done')
    // Re-delivering it a third time is equally free.
    await runs.runFinished({ ...args, now: AFTER_CYCLE })
    expect(await graph.countEvents(undefined, TEAM)).toBe(events)
  })

  it('a run that produced nothing creates no empty report doc', async () => {
    const task = await pendingTask('nothing to report')
    const { directives } = await approve(task.id)
    await claim('agent-a')
    const finished = await runs.runFinished({
      now: SOON,
      agent: 'agent-a',
      directiveId: directives[0]!.id,
      outcome: 'success',
      summary: 'nothing found',
      exitCode: 0,
    })
    expect(finished.ok && finished.report).toBeUndefined()
    expect((await graph.listObjects(undefined, TEAM)).filter((o) => o.type === 'report')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - failure surfacing: a failed run advances AND raises an item
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a run failure is never silent', () => {
  it('advances the failure transition and raises a typed attention item', async () => {
    const task = await pendingTask('fail me')
    const { directives } = await approve(task.id)
    const d = directives[0]!
    await claim('agent-a')
    await runs.runStarted({ now: NOW, agent: 'agent-a', directiveId: d.id })

    const finished = await runs.runFinished({
      now: SOON,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'failure',
      summary: 'the executor exited 2',
      exitCode: 2,
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    // The task moves to its FAILURE state, not its success one.
    expect(finished.advanced).toMatchObject({ transition: 'broke', status: 'failed' })

    // …and the directive itself is failed, with the agent's typed reason, which is
    // what the attention list groups on.
    const report = await channel.reportDirective({
      now: SOON,
      agent: 'agent-a',
      id: d.id,
      ok: false,
      refusalCode: 'RUN_FAILED',
      error: 'the run exited 2',
    })
    expect(report.ok).toBe(true)
    const view = await attention.attentionView(TEAM)
    const item = view.items.find((i) => i.ref === d.id)!
    expect(item.kind).toBe('directive-failed')
    expect(item.reason).toBe('RUN_FAILED')
    expect(item.detail).toContain('exited 2')
    expect(item.objectId).toBe(task.id)
    // A broken run may well work on a second go, so a retry IS offered.
    expect(item.retryable).toBe(true)
  })

  it('a guard refusal offers no retry - a command does not join an allowlist by asking twice', async () => {
    const task = await pendingTask('refuse me')
    const { directives } = await approve(task.id)
    await claim('agent-a')
    await channel.reportDirective({
      now: SOON,
      agent: 'agent-a',
      id: directives[0]!.id,
      ok: false,
      refusalCode: 'RUN_NOT_PERMITTED',
      error: 'this agent has no instruction executor configured',
    })
    const item = (await attention.attentionView(TEAM)).items.find((i) => i.ref === directives[0]!.id)!
    expect(item.reason).toBe('RUN_NOT_PERMITTED')
    expect(item.retryable).toBe(false)
  })

  it('says so when the work order declares no transition for the outcome', async () => {
    // A pure-investigation dispatch that moves nothing is a legitimate posture - but
    // the result SAYS it moved nothing rather than leaving a caller to infer it from
    // an absence.
    const task = await pendingTask('investigate only')
    const { directives } = await approve(task.id)
    const d = directives[0]!
    // Strip the outcome wiring off the stored work order, the way a spec with no
    // `onFailure` would have written it.
    const { eq } = await import('drizzle-orm')
    const payload = { ...(d.payload as Record<string, unknown>) }
    delete payload.onFailure
    await dbmod.db.update(schema.effectDirectives).set({ payload }).where(eq(schema.effectDirectives.id, d.id))

    await claim('agent-a')
    const finished = await runs.runFinished({
      now: SOON,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'failure',
      summary: 'broke',
      exitCode: 1,
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    expect(finished.advanced).toBeUndefined()
    expect(finished.notAdvanced).toContain('declares no transition')
    // The run's outcome is still RECORDED - the event landed even though nothing moved.
    expect(
      (await graph.listObjectEvents(undefined, task.id)).some((e) => e.kind === 'run-finished'),
    ).toBe(true)
  })

  it('a refused outcome transition is reported, not swallowed', async () => {
    // The task has already left `dispatched` (somebody cancelled, or a prior report
    // moved it), so the outcome transition is illegal. The run's outcome is still
    // recorded and the refusal is stated - a consequence that evaporated silently is
    // the exact failure this bridge exists to prevent.
    const task = await pendingTask('moved underneath me')
    const { directives } = await approve(task.id)
    const d = directives[0]!
    await claim('agent-a')
    await runs.runFinished({ now: SOON, agent: 'agent-a', directiveId: d.id, outcome: 'success', exitCode: 0 })
    expect((await graph.getObject(undefined, task.id))!.status).toBe('done')

    // Now a contradictory second outcome arrives. Different outcome ⇒ its own event id
    // ⇒ a real row, and the transition is refused because `done` is terminal.
    const conflicting = await runs.runFinished({
      now: LATER,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'failure',
      summary: 'actually it broke',
      exitCode: 1,
    })
    expect(conflicting.ok).toBe(true)
    if (!conflicting.ok) return
    expect(conflicting.replay).toBe(false)
    expect(conflicting.advanced).toBeUndefined()
    expect(conflicting.notAdvanced).toContain('ILLEGAL_FROM_STATE')
    expect((await graph.getObject(undefined, task.id))!.status).toBe('done')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 6 - the lease is the authority
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: only the agent HOLDING the work order may report its run', () => {
  it('refuses an unclaimed work order, a stranger, and a zombie', async () => {
    const task = await pendingTask('who holds this')
    const { directives } = await approve(task.id)
    const d = directives[0]!

    // Nobody holds it yet.
    const unclaimed = await runs.runFinished({
      now: NOW,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'success',
      exitCode: 0,
    })
    expect(unclaimed.ok).toBe(false)
    expect(!unclaimed.ok && unclaimed.code).toBe('LEASE_LOST')
    expect((await graph.getObject(undefined, task.id))!.status).toBe('dispatched')

    // agent-a holds it; agent-b may not speak for it.
    await claim('agent-a')
    const stranger = await runs.runStarted({ now: NOW, agent: 'agent-b', directiveId: d.id })
    expect(stranger.ok).toBe(false)
    expect(!stranger.ok && stranger.code).toBe('LEASE_LOST')

    // A ZOMBIE: agent-a's lease expires, agent-b picks the row up, and agent-a wakes
    // to report. Its report must not advance a task its successor now owns.
    await claim('agent-b', LATER)
    const zombie = await runs.runFinished({
      now: LATER,
      agent: 'agent-a',
      directiveId: d.id,
      outcome: 'success',
      exitCode: 0,
    })
    expect(zombie.ok).toBe(false)
    expect(!zombie.ok && zombie.code).toBe('LEASE_LOST')
    expect((await graph.getObject(undefined, task.id))!.status).toBe('dispatched')
  })

  it('refuses a lifecycle report against a work order that is not a run', async () => {
    const unknown = await runs.runStarted({ now: NOW, agent: 'agent-a', directiveId: 'no-such-directive' })
    expect(!unknown.ok && unknown.code).toBe('UNKNOWN_DIRECTIVE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 7 - the ceiling: what this build refuses to dispatch at all
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an undispatchable declaration surfaces instead of vanishing', () => {
  it('dead-letters a declaration with no intent', async () => {
    const task = await pendingTask('malformed')
    const carrier = 'ev-runs-malformed'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      objectId: task.id,
      kind: 'status-changed',
      origin: 'organic',
      transition: 'approve',
      diff: { status: { old: 'awaiting-dispatch', new: 'dispatched' } },
      entrance: 'human',
      actorId: USER,
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: task.id,
      // No `intent`: a spec bug. Inventing one would be worse than refusing.
      actions: [{ kind: 'dispatch-outward-run', payload: { label: 'nothing to do' }, approvalEvent: carrier }],
      now: NOW,
    })
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.lastError).toContain('no `intent`')
    expect(await graph.getDirective(undefined, action!.id)).toBeUndefined()
    // Visible, with the reason on it.
    expect((await attention.attentionView(TEAM)).items.some((i) => i.ref === action!.id)).toBe(true)
  })

  it('the R2 `dispatch-run` has no delivery shape at all', async () => {
    // Captain decision 12 routes runs through the APPROVED door only: a run is a
    // command on somebody's machine, and nothing on the server can verify that a
    // given script is "machine-local only". So the unapproved kind dead-letters.
    const { effectKindOf } = await import('../effects/directive.js')
    expect(effectKindOf('dispatch-outward-run')).toBe('run-task')
    expect(effectKindOf('dispatch-run')).toBeUndefined()
    const { handledKinds } = await import('../outbox/handlers.js')
    expect(handledKinds()).toContain('dispatch-outward-run')
    expect(handledKinds()).not.toContain('dispatch-run')
  })

  it('never builds a work order from a non-human approval', async () => {
    // The outward ceiling, on the runs channel. A rule cannot approve its own
    // dispatch, and the executor re-checks the resolved event before any work order
    // is written.
    const task = await pendingTask('rule tried to approve itself')
    const carrier = 'ev-runs-rule-approval'
    await graph.appendEvent(undefined, {
      id: carrier,
      teamId: TEAM,
      objectId: task.id,
      kind: 'rule-decision',
      origin: 'organic',
      entrance: 'rule',
      actorId: 'rule-probe',
      ts: NOW,
    })
    const [action] = await graph.enqueueActions(undefined, {
      eventId: carrier,
      teamId: TEAM,
      objectId: task.id,
      actions: [{ kind: 'dispatch-outward-run', payload: { intent: 'do something' }, approvalEvent: carrier }],
      now: NOW,
    })
    await exec.runOnce({ now: NOW, teamId: TEAM })
    const row = (await graph.getAction(undefined, action!.id))!
    expect(row.state).toBe('dead-letter')
    expect(row.refusalCode).toBe('APPROVAL_NOT_HUMAN')
    expect(await graph.getDirective(undefined, action!.id)).toBeUndefined()
  })
})
