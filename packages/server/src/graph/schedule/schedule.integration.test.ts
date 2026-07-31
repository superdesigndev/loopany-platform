import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PROBE SUITE — THE CLOCK SHADOW, over a REAL pglite database (migrations applied
 * in `beforeAll`, so this file is also the proof that migration 0006 applies
 * cleanly on a fresh DB).
 *
 * Each block is one property the unit is built around, written the way a production
 * failure would find it:
 *
 *   1. exactly one fire      a due object fires once; a not-due one is untouched
 *   2. idempotent firing     a crash between the clock event and the cursor advance
 *                            converges to ONE dispatch - no twin directives
 *   3. level-triggered       downtime spanning three intervals owes ONE catch-up fire
 *   4. jitter                two objects on the same cron line fire at different instants
 *   5. not loop-only         a plain Task with a schedule fires exactly like a loop
 *   6. the outward ceiling   an UNARMED schedule's R3 fire is refused, and the miss
 *                            is visible as a `clock-skipped` event, not a log line
 *
 * `now` is passed to every pass - the scheduler proper never reads a clock - so
 * "the server was down for three intervals" is a real assertion and not a sleep.
 *
 * EACH PROBE GETS ITS OWN TEAM. A scheduler pass is scoped by team and otherwise
 * scans everything due, so probes sharing one team would leak into each other's
 * passes (an object fired at 09:00 is due again at 09:02, in somebody else's
 * assertion). One team per probe keeps every pass total meaningful.
 */

let tmp: string
let dbmod: typeof import('../../db/index.js')
let schema: typeof import('../../db/graph-schema.js')
let graph: typeof import('../../db/graphStore.js')
let sched: typeof import('./scheduler.js')
let arm: typeof import('./arm.js')
let cadence: typeof import('./cadence.js')
let exec: typeof import('../outbox/executor.js')

const USER = 'u-clock-captain'
/** Every instant in this suite is explicit and on a two-minute grid, so an
 *  interval cadence's epoch-anchored occurrences are easy to reason about. */
const T0 = '2026-07-30T09:00:00.000Z'
const INTERVAL_MS = 120_000

/**
 * A WATCH type: a plain Task archetype with a clock-enterable transition that
 * dispatches an instruction. This is the closed-loop ruling made concrete - a
 * bounded recurring watch is a Task with a schedule, so the scheduler must carry it
 * with no loop-specific code anywhere.
 */
function watchSpec(): import('../types.js').TypeSpec {
  return {
    states: ['idle', 'running', 'done'],
    initialState: 'idle',
    terminalStates: ['done'],
    transitions: [
      {
        name: 'check',
        from: ['idle'],
        to: 'running',
        entrance: 'clock',
        actions: [
          {
            kind: 'dispatch-outward-run',
            payload: {
              intent: 'Check the thing described in context.object.brief and report.',
              scope: { writes: ['report.md'] },
              onSuccess: 'settle',
              onFailure: 'settle',
              report: true,
            },
          },
        ],
      },
      // A self-transition the clock may also enter. It exists to prove the fire
      // RESOLVER ignores it: a cadence whose fire was a no-op state change would be
      // a schedule that logs and never works.
      { name: 'note', from: ['idle'], to: 'idle', entrance: 'clock' },
      { name: 'settle', from: ['running'], to: 'idle', entrance: ['rule', 'agent-run'] },
    ],
    fields: { brief: 'string' },
  }
}

/** One probe's isolated world: its own team, with the builtin archetypes and the
 *  watch type armed in it. */
async function world(name: string): Promise<string> {
  const teamId = `team-clock-${name}`
  await graph.seedBuiltinTypes(undefined, teamId, T0)
  await graph.proposeTypeVersion(undefined, {
    teamId,
    name: 'watch',
    archetype: 'task',
    version: 1,
    spec: watchSpec(),
    rationale: 'clock probe: a bounded recurring watch is a Task with a schedule',
    now: T0,
  })
  await graph.armTypeVersion(undefined, { teamId, name: 'watch', version: 1, now: T0 })
  return teamId
}

/** A watch object, optionally armed. Unarmed means "cadence configured, cursor
 *  absent" - the state every imported production loop is in. */
async function newWatch(
  teamId: string,
  suffix: string,
  options: { arm?: { interval?: string; cron?: string }; now?: string } = {},
) {
  const object = await graph.createObject(undefined, {
    teamId,
    archetype: 'task',
    type: 'watch',
    status: 'idle',
    title: `watch ${suffix}`,
    payload: { brief: `look at ${suffix}` },
    now: options.now ?? T0,
  })
  if (!options.arm) return object
  const parsed = cadence.parseCadence({
    ...(options.arm.cron ? { cron: options.arm.cron, timezone: 'UTC' } : {}),
    ...(options.arm.interval ? { interval: options.arm.interval } : {}),
  })
  if (!parsed.ok) throw new Error(`probe cadence is unparseable: ${parsed.why}`)
  const armed = await arm.armSchedule({
    objectId: object.id,
    cadence: parsed.spec,
    userId: USER,
    now: options.now ?? T0,
  })
  if (!armed.ok) throw new Error(`probe could not arm ${object.id}: ${armed.code} ${armed.message}`)
  return (await graph.getObject(undefined, object.id))!
}

/** Force the cursor to an exact instant. Arming computes a JITTERED one, which is
 *  correct and inconvenient for a probe that wants to assert on "due at exactly T". */
async function pinCursor(objectId: string, at: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  const { eq } = await import('drizzle-orm')
  await dbmod.db
    .update(schema.objects)
    .set({ nextFire: at, ...extra })
    .where(eq(schema.objects.id, objectId))
}

async function clockEvents(objectId: string) {
  return (await graph.listObjectEvents(undefined, objectId)).filter((e) => e.entrance === 'clock')
}

async function eventsOfKind(objectId: string, kind: string) {
  return (await graph.listObjectEvents(undefined, objectId)).filter((e) => e.kind === kind)
}

async function directivesFor(teamId: string, objectId: string) {
  return (await graph.listDirectives(undefined, teamId, 200)).filter((d) => d.objectId === objectId)
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-clock-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_LOG_LEVEL = 'silent'
  delete process.env.DATABASE_URL

  dbmod = await import('../../db/index.js')
  await dbmod.runMigrations()
  schema = await import('../../db/graph-schema.js')
  graph = await import('../../db/graphStore.js')
  sched = await import('./scheduler.js')
  arm = await import('./arm.js')
  cadence = await import('./cadence.js')
  exec = await import('../outbox/executor.js')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 - a due object fires exactly once; a not-due one is untouched
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: due fires exactly once, not-due is untouched', () => {
  it('fires the due object, advances its cursor, and leaves the other alone', async () => {
    const team = await world('once')
    const due = await newWatch(team, 'due', { arm: { interval: '2m' } })
    const later = await newWatch(team, 'later', { arm: { interval: '1d' } })
    await pinCursor(due.id, T0)
    await pinCursor(later.id, '2026-07-31T09:00:00.000Z')

    const now = '2026-07-30T09:00:05.000Z'
    const pass = await sched.runOnce({ now, teamId: team })
    expect(pass.due).toBe(1)
    expect(pass.fired).toBe(1)
    expect(pass.skipped).toBe(0)

    const fired = (await graph.getObject(undefined, due.id))!
    expect(fired.status).toBe('running')
    expect(fired.lastFiredAt).toBe(now)
    // LEVEL-TRIGGERED: the cursor is strictly ahead of NOW, never left in the past.
    expect(Date.parse(fired.nextFire!)).toBeGreaterThan(Date.parse(now))

    // ONE clock event, carrying real provenance: the SCHEDULE is the actor.
    const fires = await clockEvents(due.id)
    expect(fires).toHaveLength(1)
    expect(fires[0]!.actorId).toBe(sched.scheduleActorId(due.id))
    expect(fires[0]!.transition).toBe('check')
    expect(fires[0]!.origin).toBe('derived')
    expect((fires[0]!.payload as Record<string, unknown>).scheduledFor).toBe(T0)

    // The not-due object has no clock events and its cursor is where it was.
    const untouched = (await graph.getObject(undefined, later.id))!
    expect(untouched.status).toBe('idle')
    expect(untouched.lastFiredAt).toBeNull()
    expect(untouched.nextFire).toBe('2026-07-31T09:00:00.000Z')
    expect(await clockEvents(later.id)).toHaveLength(0)

    // A SECOND pass at the same instant finds nothing: the cursor moved, so the
    // debt is discharged. This is the "exactly once" half.
    expect((await sched.runOnce({ now, teamId: team })).due).toBe(0)
  })

  it('dispatches the fire through the EXISTING directive channel, not a second one', async () => {
    const team = await world('dispatch')
    const watch = await newWatch(team, 'dispatch', { arm: { interval: '2m' } })
    await pinCursor(watch.id, T0)
    await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })

    // The fire enqueued the declared dispatch, approved by the ARMING event.
    const actions = await graph.listPendingActions(undefined, { objectId: watch.id })
    expect(actions.map((a) => a.kind)).toEqual(['dispatch-outward-run'])
    expect(actions[0]!.consequenceClass).toBe('R3')
    const armEvent = (await graph.getObject(undefined, watch.id))!.scheduleArmedByEvent!
    expect(actions[0]!.approvalEvent).toBe(armEvent)
    expect((await graph.getEvent(undefined, armEvent))!.entrance).toBe('human')

    // The executor turns it into ONE run-task work order for a machine agent, and
    // the instruction carries the instance's own brief.
    const drained = await exec.drainOutbox({ now: '2026-07-30T09:00:06.000Z', teamId: team, maxPasses: 4 })
    expect(drained.deadLettered).toBe(0)
    const directives = await directivesFor(team, watch.id)
    expect(directives).toHaveLength(1)
    expect(directives[0]!.kind).toBe('run-task')
    expect(directives[0]!.state).toBe('pending')
    const payload = directives[0]!.payload as { context?: { object?: { brief?: string } } }
    expect(payload.context?.object?.brief).toBe('look at dispatch')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 - a crash between the clock event and the cursor advance
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a fire that crashed before advancing the cursor converges to ONE dispatch', () => {
  it('re-fires as a replay: same event id, no second action, no twin directive', async () => {
    const team = await world('crash')
    const watch = await newWatch(team, 'crash', { arm: { interval: '2m' } })
    await pinCursor(watch.id, T0)

    // Pass one fires and advances. Then we put the cursor BACK - which is exactly
    // the state a crash in the window between the two transactions leaves behind:
    // the clock event and its action are committed, the debt is not yet cleared.
    // There is no production verb for "un-advance a cursor" and there should not be.
    const first = await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })
    expect(first.fired).toBe(1)
    const firstEvent = (await clockEvents(watch.id))[0]!
    await pinCursor(watch.id, T0)

    // The retry happens at a DIFFERENT instant, which is the point: the fire's
    // identity is the SCHEDULED instant, so `now` moving cannot fork it.
    const second = await sched.runOnce({ now: '2026-07-30T09:00:41.000Z', teamId: team })
    expect(second.due).toBe(1)
    expect(second.replayed).toBe(1)
    expect(second.fired).toBe(0)

    // ONE clock event, the same id, and ONE action row.
    const fires = await clockEvents(watch.id)
    expect(fires).toHaveLength(1)
    expect(fires[0]!.id).toBe(firstEvent.id)
    expect(await graph.listActionsForEvent(undefined, firstEvent.id)).toHaveLength(1)

    // And after draining, ONE directive - the identity travelled all the way down
    // (event → `<eventId>-<seq>` action → directive keyed by the action id).
    await exec.drainOutbox({ now: '2026-07-30T09:00:42.000Z', teamId: team, maxPasses: 4 })
    expect(await directivesFor(team, watch.id)).toHaveLength(1)

    // The retry still cleared the debt, and the object is where the first fire put it.
    const after = (await graph.getObject(undefined, watch.id))!
    expect(after.status).toBe('running')
    expect(Date.parse(after.nextFire!)).toBeGreaterThan(Date.parse('2026-07-30T09:00:41.000Z'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 - downtime spanning three intervals owes ONE catch-up fire
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: downtime spanning 3 missed intervals ⇒ exactly ONE catch-up fire', () => {
  it('does not emit a burst of back-fires', async () => {
    const team = await world('catchup')
    const watch = await newWatch(team, 'catchup', { arm: { interval: '2m' } })
    await pinCursor(watch.id, T0)

    // The server was down from 09:00 to 09:07 - three whole intervals missed plus a
    // bit. The first pass after the outage runs at 09:07.
    const wake = '2026-07-30T09:07:00.000Z'
    const pass = await sched.runOnce({ now: wake, teamId: team })
    expect(pass.due).toBe(1)
    expect(pass.fired).toBe(1)

    // ONE clock event, not four.
    expect(await clockEvents(watch.id)).toHaveLength(1)
    // ONE action, and therefore ONE work order when it is drained.
    await exec.drainOutbox({ now: wake, teamId: team, maxPasses: 4 })
    expect(await directivesFor(team, watch.id)).toHaveLength(1)

    // The cursor skipped the missed occurrences instead of queueing them: it is one
    // interval past the WAKE instant, not one interval past the instant that was due.
    const after = (await graph.getObject(undefined, watch.id))!
    expect(Date.parse(after.nextFire!)).toBeGreaterThan(Date.parse(wake))
    expect(Date.parse(after.nextFire!)).toBeLessThanOrEqual(
      Date.parse(wake) + INTERVAL_MS + cadence.JITTER_WINDOW_MS,
    )

    // And an immediate second pass owes nothing - the debt was a level, not a count.
    expect((await sched.runOnce({ now: wake, teamId: team })).due).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 - jitter: identical cron lines do not fire in the same second
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: two objects on the same cron line get different fire instants', () => {
  it('spreads them by a deterministic per-object offset', async () => {
    const team = await world('jitter')
    const a = await newWatch(team, 'cron-a', { arm: { cron: '0 7 * * *' } })
    const b = await newWatch(team, 'cron-b', { arm: { cron: '0 7 * * *' } })
    expect(a.cron).toBe('0 7 * * *')
    expect(a.nextFire).not.toBe(b.nextFire)

    // Same occurrence, different offsets inside the jitter window - so the two are
    // spread rather than merely disagreeing about which day they fire.
    const apart = Math.abs(Date.parse(a.nextFire!) - Date.parse(b.nextFire!))
    expect(apart).toBeGreaterThan(0)
    expect(apart).toBeLessThan(cadence.JITTER_WINDOW_MS)

    // Deterministic: re-arming the same object recomputes the SAME offset.
    const reArmed = await arm.armSchedule({ objectId: a.id, userId: USER, now: T0 })
    expect(reArmed.ok && reArmed.nextFire).toBe(a.nextFire)
  })
})

describe('probe: arming can pull the FIRST fire forward without changing the cadence', () => {
  it('honours an earlier first cursor, and ignores one that is not earlier', async () => {
    const team = await world('firstfire')
    // A daily loop armed at midnight would first prove itself tomorrow. `firstFire`
    // is the "start now, then keep the cadence" lever that makes a deployed arm
    // verifiable the same day.
    const object = await newWatch(team, 'daily', {})
    const parsed = cadence.parseCadence({ cron: '0 6 * * *', timezone: 'UTC' })
    if (!parsed.ok) throw new Error(parsed.why)

    const soon = new Date(Date.parse(T0) + 3 * 60_000).toISOString()
    const armed = await arm.armSchedule({
      objectId: object.id,
      cadence: parsed.spec,
      userId: USER,
      now: T0,
      firstFire: soon,
    })
    expect(armed.ok && armed.nextFire).toBe(soon)
    // The CADENCE is untouched, which is the whole point: after this one fire the
    // scheduler advances by the cron, so nothing has to be restored afterwards.
    const row = (await graph.getObject(undefined, object.id))!
    expect(row.cron).toBe('0 6 * * *')

    // EARLIER ONLY. A request at or past the natural occurrence is ignored, so the
    // lever can never be used to skip a fire.
    const natural = (await arm.armSchedule({ objectId: object.id, cadence: parsed.spec, userId: USER, now: T0 })) as {
      ok: true
      nextFire: string
    }
    const late = new Date(Date.parse(natural.nextFire) + 86_400_000).toISOString()
    const pushed = await arm.armSchedule({
      objectId: object.id,
      cadence: parsed.spec,
      userId: USER,
      now: T0,
      firstFire: late,
    })
    expect(pushed.ok && pushed.nextFire).toBe(natural.nextFire)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 - a schedule is not loop-archetype-exclusive
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: a plain Task with a schedule fires the same way a loop does', () => {
  it('fires the builtin task type through the same pass, with no type-specific path', async () => {
    const team = await world('plain')
    // The BUILTIN `task` type declares no `entrance` restrictions at all, which is
    // what makes an ordinary task schedulable with no spec edit. Its `start` is
    // named explicitly because three of its transitions are clock-enterable and
    // ambiguity is refused rather than resolved by list order (below).
    const task = await graph.createObject(undefined, {
      teamId: team,
      archetype: 'task',
      type: 'task',
      status: 'open',
      title: 'a plain task on a cadence',
      now: T0,
    })
    const armed = await arm.armSchedule({
      objectId: task.id,
      cadence: { intervalMs: INTERVAL_MS },
      fireTransition: 'start',
      userId: USER,
      now: T0,
    })
    expect(armed.ok && armed.fireTransition).toBe('start')
    await pinCursor(task.id, T0)

    const pass = await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })
    expect(pass.fired).toBe(1)
    const after = (await graph.getObject(undefined, task.id))!
    expect(after.status).toBe('in-progress')
    const fires = await clockEvents(task.id)
    expect(fires).toHaveLength(1)
    expect(fires[0]!.transition).toBe('start')
    expect(fires[0]!.actorId).toBe(sched.scheduleActorId(task.id))
    // It declares no actions, so nothing is dispatched - a clock event is a fact
    // about time, and what it causes is the type's business.
    expect(await graph.listPendingActions(undefined, { objectId: task.id })).toHaveLength(0)
  })

  it('refuses to arm an AMBIGUOUS fire rather than picking one by list order', async () => {
    const team = await world('ambiguous')
    const task = await graph.createObject(undefined, {
      teamId: team,
      archetype: 'task',
      type: 'task',
      status: 'open',
      title: 'ambiguous cadence',
      now: T0,
    })
    const armed = await arm.armSchedule({
      objectId: task.id,
      cadence: { intervalMs: INTERVAL_MS },
      userId: USER,
      now: T0,
    })
    expect(armed.ok).toBe(false)
    expect(!armed.ok && armed.code).toBe('NO_FIRE_TRANSITION')
    // Refused means nothing was written: no cursor, no arming event.
    const after = (await graph.getObject(undefined, task.id))!
    expect(after.nextFire).toBeNull()
    expect(after.scheduleArmedByEvent).toBeNull()
  })

  it('refuses to schedule a mirror - an observed fact carries no cadence', async () => {
    const team = await world('mirror')
    const { object: mirror } = await graph.getOrCreateMirror(undefined, {
      teamId: team,
      externalSource: 'github',
      externalId: 'owner/repo/pull/7',
      now: T0,
    })
    const armed = await arm.armSchedule({
      objectId: mirror.id,
      cadence: { intervalMs: INTERVAL_MS },
      userId: USER,
      now: T0,
    })
    expect(!armed.ok && armed.code).toBe('NOT_SCHEDULABLE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 6 - the outward ceiling still holds under a clock
// ─────────────────────────────────────────────────────────────────────────────

describe('probe: an UNARMED cadence cannot dispatch, and the miss is visible', () => {
  it('refuses the fire for want of a human approval and records a clock-skipped event', async () => {
    const team = await world('unarmed')
    // Cadence CONFIGURED and a cursor forced on - the shape an imported production
    // loop would have if something set its cursor without an arming act. There is
    // no approving human event, so the R3 dispatch has nothing to rest on.
    const watch = await newWatch(team, 'unarmed')
    await pinCursor(watch.id, T0, { intervalMs: INTERVAL_MS })

    const now = '2026-07-30T09:00:05.000Z'
    const pass = await sched.runOnce({ now, teamId: team })
    expect(pass.skipped).toBe(1)
    expect(pass.fired).toBe(0)
    expect(pass.outcomes[0]!.detail).toContain('APPROVAL_REQUIRED')

    // Nothing moved and nothing was enqueued: fail-closed, at the seam.
    const after = (await graph.getObject(undefined, watch.id))!
    expect(after.status).toBe('idle')
    expect(await graph.listPendingActions(undefined, { objectId: watch.id })).toHaveLength(0)
    expect(await directivesFor(team, watch.id)).toHaveLength(0)

    // The miss is a ROW, not a log line - one per missed instant, derived, so a
    // retry does not flood the Timeline.
    const skipped = await eventsOfKind(watch.id, sched.CLOCK_SKIPPED_EVENT)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.entrance).toBe('clock')
    expect(skipped[0]!.actorId).toBe(sched.scheduleActorId(watch.id))
    expect((skipped[0]!.payload as Record<string, unknown>).code).toBe('APPROVAL_REQUIRED')

    // The cursor still advanced, so the scheduler does not re-refuse it every tick.
    expect(Date.parse(after.nextFire!)).toBeGreaterThan(Date.parse(now))
  })

  it('skips (and records) a fire that lands while the object is still running', async () => {
    const team = await world('busy')
    const watch = await newWatch(team, 'busy', { arm: { interval: '2m' } })
    await pinCursor(watch.id, T0)
    await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })
    expect((await graph.getObject(undefined, watch.id))!.status).toBe('running')

    // The next occurrence arrives with the previous run still in flight. Ordinary,
    // not an incident - but it must be visible and must not wedge the cursor.
    await pinCursor(watch.id, '2026-07-30T09:02:00.000Z')
    const pass = await sched.runOnce({ now: '2026-07-30T09:02:05.000Z', teamId: team })
    expect(pass.skipped).toBe(1)
    // A MISS DOES NOT COUNT AS A FIRE. The cursor moves, but "last fired" still
    // names the fire that actually ran - a column that recorded the miss would make
    // a stopped cadence look like a working one.
    expect((await graph.getObject(undefined, watch.id))!.lastFiredAt).toBe('2026-07-30T09:00:05.000Z')
    const skipped = await eventsOfKind(watch.id, sched.CLOCK_SKIPPED_EVENT)
    expect(skipped).toHaveLength(1)
    expect((skipped[0]!.payload as Record<string, unknown>).code).toBe('ILLEGAL_FROM_STATE')
    const after = (await graph.getObject(undefined, watch.id))!
    expect(Date.parse(after.nextFire!)).toBeGreaterThan(Date.parse('2026-07-30T09:02:05.000Z'))
    // Still exactly one dispatch: a skipped fire enqueues nothing.
    await exec.drainOutbox({ now: '2026-07-30T09:02:06.000Z', teamId: team, maxPasses: 4 })
    expect(await directivesFor(team, watch.id)).toHaveLength(1)
  })

  it('retires the cursor of a schedule whose fire transition no longer resolves', async () => {
    const team = await world('unfireable')
    const object = await graph.createObject(undefined, {
      teamId: team,
      archetype: 'task',
      type: 'watch',
      status: 'idle',
      title: 'pointed at nothing',
      // A fire transition that does not exist. Arming would have refused this, so
      // the only way here is a hand-edited row - which is exactly the case where a
      // scheduler must not spin.
      payload: { fireTransition: 'no-such-transition' },
      now: T0,
    })
    await pinCursor(object.id, T0, { intervalMs: INTERVAL_MS })

    const pass = await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })
    expect(pass.outcomes.find((o) => o.objectId === object.id)!.state).toBe('unfireable')
    const after = (await graph.getObject(undefined, object.id))!
    expect(after.nextFire).toBeNull()
    expect(await eventsOfKind(object.id, sched.CLOCK_SKIPPED_EVENT)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the read model
// ─────────────────────────────────────────────────────────────────────────────

describe('the Schedule view reports what the columns say', () => {
  it('separates armed from merely configured, and counts fires and misses from events', async () => {
    const read = await import('../workspace/read.js')
    const team = await world('read')
    const live = await newWatch(team, 'live', { arm: { interval: '2m' } })
    const configured = await newWatch(team, 'configured')
    // Cadence written, cursor left null - "configured, not armed".
    await pinCursor(configured.id, null, { intervalMs: INTERVAL_MS })
    await pinCursor(live.id, T0)
    await sched.runOnce({ now: '2026-07-30T09:00:05.000Z', teamId: team })

    const view = await read.scheduleView(team)
    expect(view.items).toHaveLength(2)
    expect(view.armed).toBe(1)

    const armedRow = view.items.find((i) => i.objectId === live.id)!
    expect(armedRow.armed).toBe(true)
    expect(armedRow.cadence).toBe('every 2m')
    expect(armedRow.fireTransition).toBe('check')
    expect(armedRow.fires).toBe(1)
    expect(armedRow.misses).toBe(0)
    expect(armedRow.armedByEvent).toBeTruthy()
    expect(armedRow.lastFiredAt).toBe('2026-07-30T09:00:05.000Z')

    const configuredRow = view.items.find((i) => i.objectId === configured.id)!
    expect(configuredRow.armed).toBe(false)
    expect(configuredRow.nextFire).toBeUndefined()
    expect(configuredRow.cadence).toBe('every 2m')
    expect(configuredRow.armedByEvent).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// disarm
// ─────────────────────────────────────────────────────────────────────────────

describe('disarm', () => {
  it('drops the cursor and the standing approval, and keeps the cadence', async () => {
    const team = await world('disarm')
    const watch = await newWatch(team, 'disarm', { arm: { interval: '2m' } })
    expect(watch.nextFire).not.toBeNull()
    const out = await arm.disarmSchedule({ objectId: watch.id, userId: USER, now: T0 })
    expect(out.ok).toBe(true)
    const after = (await graph.getObject(undefined, watch.id))!
    expect(after.nextFire).toBeNull()
    // The standing approval does not outlive the schedule it authorized.
    expect(after.scheduleArmedByEvent).toBeNull()
    // The cadence stays: it is configuration, and a person may want it back.
    expect(after.intervalMs).toBe(INTERVAL_MS)
    expect(await eventsOfKind(watch.id, sched.SCHEDULE_DISARMED_EVENT)).toHaveLength(1)
    // And nothing is due any more, however far the clock is wound forward.
    expect((await sched.runOnce({ now: '2026-08-30T09:00:00.000Z', teamId: team })).due).toBe(0)
  })
})
