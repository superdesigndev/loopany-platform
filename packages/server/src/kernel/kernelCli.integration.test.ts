import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end proof of the kernel server host (milestone M5) at the HTTP-seam
 * boundary, over a REAL pglite store. Drives `kernelCli(deviceToken, command)` —
 * the one function the POST /api/kernel/cli route delegates to — with real
 * `machine` rows seeded so the device token resolves to a team scope exactly as
 * production does. Covers: a golden-script-shaped command sequence lands in
 * pglite and reads back; a decide-time Refusal surfaces (422); a persist-time
 * CAS conflict surfaces (409); and cross-team isolation (a second machine/team
 * cannot see the first team's objects — the flat-404 equivalent is structural).
 */

let tmp: string
let db: typeof import('../db/index.js')
let store: typeof import('../db/store.js')
let tokens: typeof import('../gateway/tokens.js')
let gateway: typeof import('./gateway.js')
let kstore: typeof import('./store.js')

// Two machines, each under its own owner/team. Tokens are hand-shaped `dk_` demo
// tokens (legit per isDeviceTokenShape); the machine id derives from the token.
const TOK_A = 'dk_kernel_team_a'
const TOK_B = 'dk_kernel_team_b'

async function seedMachine(token: string, userId: string): Promise<{ machineId: string; teamId: string }> {
  const machineId = tokens.machineIdFromToken(token)
  const teamId = store.teamIdForUser(userId)
  await store.createMachine({
    id: machineId,
    userId,
    teamId,
    name: `m-${userId}`,
    alias: userId === 'u_alice' ? 'alice-mbp' : 'bob-mbp',
    tokenHash: tokens.sha256(token),
    token,
  })
  return { machineId, teamId }
}

let TEAM_A: string
let TEAM_B: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-kernelcli-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_DB_PATH = path.join(tmp, 'test.db')
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  db = await import('../db/index.js')
  await db.runMigrations()
  store = await import('../db/store.js')
  tokens = await import('../gateway/tokens.js')
  gateway = await import('./gateway.js')
  kstore = await import('./store.js')

  TEAM_A = (await seedMachine(TOK_A, 'u_alice')).teamId
  TEAM_B = (await seedMachine(TOK_B, 'u_bob')).teamId
})

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('kernelCli — unauthorized credentials', () => {
  it('rejects a non-device-shaped token (401)', async () => {
    const r = await gateway.kernelCli('not-a-token', { op: 'create', title: 'x' })
    expect(r.status).toBe(401)
    expect(r.body.ok).toBe(false)
    expect(r.body.refusal?.code).toBe('UNAUTHORIZED')
  })

  it('rejects a well-shaped but unregistered machine token (401)', async () => {
    const r = await gateway.kernelCli('dk_unregistered_machine', { op: 'create', title: 'x' })
    expect(r.status).toBe(401)
    expect(r.body.ok).toBe(false)
  })
})

describe('kernelCli — golden-shaped command sequence lands + reads back', () => {
  it('create -> note -> doc-put -> update persists to pglite for the token team', async () => {
    // create a task
    const created = await gateway.kernelCli(TOK_A, {
      op: 'create',
      title: 'ship the kernel host',
      status: 'in-progress',
      assignee: 'mbp/claude',
      body: 'thesis: server backend',
    })
    expect(created.status).toBe(200)
    expect(created.body.ok).toBe(true)
    const taskId = created.body.result?.id
    expect(taskId).toBe('ship-the-kernel-host')

    // note on the task (captures an event on its stream)
    const noted = await gateway.kernelCli(TOK_A, {
      op: 'note',
      id: taskId,
      note: 'started implementation',
    })
    expect(noted.status).toBe(200)

    // a doc upsert
    const doc = await gateway.kernelCli(TOK_A, {
      op: 'doc-put',
      key: 'kernel ledger',
      body: 'step | status\nM5 | in-progress\n',
    })
    expect(doc.status).toBe(200)

    // update the task status -> done, with a note
    const done = await gateway.kernelCli(TOK_A, {
      op: 'update',
      id: taskId,
      patch: { status: 'done' },
      note: 'landed',
    })
    expect(done.status).toBe(200)

    // Read back the snapshot: the task is done, the doc exists, and the event
    // stream carries the create/note/status-changed history.
    const snap = await kstore.readSnapshot(TEAM_A)
    const task = snap.objects[taskId!]
    expect(task?.archetype).toBe('task')
    expect(task?.archetype === 'task' && task.status).toBe('done')
    expect(task?.version).toBe(3) // create (1) -> note (2) -> update (3); note bumps version + updatedAt
    expect(snap.objects['kernel-ledger']?.archetype).toBe('doc')

    const events = await kstore.readEvents(TEAM_A, taskId)
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('created')
    expect(kinds).toContain('note')
    expect(kinds).toContain('status-changed')
    // Every event is attributed to the credential's owner, never the body.
    expect(events.every((e) => e.provenance.entrance === 'human')).toBe(true)
    expect(events.every((e) => e.provenance.actorId === 'u_alice')).toBe(true)
  })

  it('accepts agent audit context but derives the machine alias from the credential', async () => {
    const r = await gateway.kernelCli(TOK_A, {
      command: { op: 'create', id: 'audit-context', title: 'audit context' },
      provenance: { entrance: 'agent', actorId: 'codex', sessionId: 'thread-123' },
    })
    expect(r.status).toBe(200)
    const events = await kstore.readEvents(TEAM_A, 'audit-context')
    expect(events[0]?.provenance).toEqual({
      entrance: 'agent',
      actorId: 'alice-mbp/codex',
      sessionId: 'thread-123',
    })
  })
})

describe('kernelCli — decide-time Refusal (422)', () => {
  it('surfaces an unknown-object update as a typed refusal', async () => {
    const r = await gateway.kernelCli(TOK_A, {
      op: 'update',
      id: 'no-such-task',
      patch: { status: 'done' },
    })
    expect(r.status).toBe(422)
    expect(r.body.ok).toBe(false)
    expect(r.body.refusal?.code).toBe('UNKNOWN_OBJECT')
    expect(r.body.conflict).toBeUndefined()
  })

  it('surfaces a malformed command as UNKNOWN_COMMAND without throwing', async () => {
    const r = await gateway.kernelCli(TOK_A, { op: 'nonsense' })
    expect(r.status).toBe(422)
    expect(r.body.refusal?.code).toBe('UNKNOWN_COMMAND')
  })

  it('teaches archived instead of delete', async () => {
    const r = await gateway.kernelCli(TOK_A, { op: 'delete', id: 'ship-the-kernel-host' })
    expect(r.status).toBe(422)
    expect(r.body.refusal?.code).toBe('DELETE_TAUGHT')
  })
})

describe('kernelCli — persist-time CAS conflict (409)', () => {
  it('an update decided against a stale version loses at apply', async () => {
    // Seed a fresh task.
    const created = await gateway.kernelCli(TOK_A, { op: 'create', title: 'cas race target' })
    const id = created.body.result!.id
    expect(created.status).toBe(200)

    // Decide a changeset against the CURRENT snapshot (version 1), but DON'T apply
    // it yet. Meanwhile another writer advances the version. Then applying the
    // stale changeset must conflict. We reproduce this directly at the store seam:
    // decide once, mutate the row via a second real command, then apply the first.
    const { decide } = await import('@loopany/kernel')
    const snap = await kstore.readSnapshot(TEAM_A)
    const stale = decide(
      { op: 'update', id, patch: { title: 'stale rename' } },
      snap,
      { entrance: 'human', actorId: 'u_alice' },
      new Date().toISOString(),
    )
    expect(stale.ok).toBe(true)

    // A concurrent writer advances the version first (via the real gateway).
    const winner = await gateway.kernelCli(TOK_A, { op: 'update', id, patch: { title: 'winner rename' } })
    expect(winner.status).toBe(200)

    // Now apply the stale changeset — it expected version 1 but the row is 2.
    if (!stale.ok) throw new Error('unreachable')
    const applied = await kstore.applyChangesetForTeam(TEAM_A, stale.changeset)
    expect(applied.ok).toBe(false)
    if (applied.ok) throw new Error('unreachable')
    expect(applied.conflict.kind).toBe('object')
    expect(applied.conflict.id).toBe(id)

    // The winner's write stands.
    const after = await kstore.readSnapshot(TEAM_A)
    const t = after.objects[id]
    expect(t?.archetype === 'task' && t.title).toBe('winner rename')
  })
})

describe('kernelCli — cross-team isolation', () => {
  it("team B's token cannot see team A's objects", async () => {
    // Team A already has objects from the golden test above.
    const aSnap = await kstore.readSnapshot(TEAM_A)
    expect(Object.keys(aSnap.objects).length).toBeGreaterThan(0)

    // Team B creates its own object with the SAME slug id as one of A's.
    const created = await gateway.kernelCli(TOK_B, {
      op: 'create',
      title: 'ship the kernel host',
      body: "team B's own task",
    })
    expect(created.status).toBe(200)
    // Same derived id, different team — no collision (identity is (team,id)).
    expect(created.body.result?.id).toBe('ship-the-kernel-host')

    const bSnap = await kstore.readSnapshot(TEAM_B)
    // B sees exactly its own object, not A's history.
    const bTask = bSnap.objects['ship-the-kernel-host']
    expect(bTask?.archetype === 'task' && bTask.body).toBe("team B's own task")
    // A's version-2 done task is untouched by B's create.
    const aTask = aSnap.objects['ship-the-kernel-host']
    expect(aTask?.archetype === 'task' && aTask.status).toBe('done')

    // B's event stream is its own, single created event — never A's note/status.
    const bEvents = await kstore.readEvents(TEAM_B, 'ship-the-kernel-host')
    expect(bEvents.map((e) => e.kind)).toEqual(['created'])
    expect(bEvents[0]?.provenance.actorId).toBe('u_bob')
  })
})
