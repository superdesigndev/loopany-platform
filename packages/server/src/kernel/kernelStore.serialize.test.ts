import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Serialization-mechanism proof for `applyChangesetForTeam` (M5 fix): the apply
 * transaction MUST take a per-team `pg_advisory_xact_lock` as its FIRST statement
 * so read-validate-write is atomic under READ COMMITTED (the hosted postgres pool
 * tier). pglite is SINGLE-CONNECTION, so a true two-connection lost-update race
 * cannot be reproduced here (recorded debt — needs real postgres). What we CAN
 * pin deterministically: (1) the advisory-lock statement is issued, keyed on the
 * team, before the snapshot read; (2) it is transaction-scoped (auto-released);
 * (3) applies for the SAME team acquire the SAME lock key and DIFFERENT teams
 * acquire DIFFERENT keys; and (4) the lock does not break a normal apply.
 */

let tmp: string
let db: typeof import('../db/index.js')
let kstore: typeof import('./store.js')

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-kstore-serialize-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_DB_PATH = path.join(tmp, 'test.db')
  process.env.LOOPANY_LOG_LEVEL = 'silent'

  db = await import('../db/index.js')
  await db.runMigrations()
  kstore = await import('./store.js')
})

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

async function buildCreateChangeset(teamId: string, title: string) {
  const { decide } = await import('@loopany/kernel')
  const decision = decide(
    { op: 'create', title },
    await kstore.readSnapshot(teamId),
    { entrance: 'human', actorId: 'u_serialize' },
    new Date().toISOString(),
  )
  if (!decision.ok) throw new Error('decide should succeed')
  return decision.changeset
}

describe('applyChangesetForTeam serialization', () => {
  it('takes a transaction-scoped advisory lock keyed on the team, first, before any read', async () => {
    // Spy on the transaction executor so we can observe the ORDER and CONTENT of
    // the statements the apply runs. We wrap db.transaction to capture the tx.
    const executed: string[] = []
    const real = db.db.transaction.bind(db.db)
    const spy = vi.spyOn(db.db, 'transaction').mockImplementation(((cb: any, ...rest: any[]) =>
      real((tx: any) => {
        const origExecute = tx.execute.bind(tx)
        tx.execute = (q: any) => {
          // Drizzle's SQL carries the raw fragments; record enough to assert on.
          const text = JSON.stringify(q?.queryChunks ?? q)
          executed.push(text)
          return origExecute(q)
        }
        return cb(tx)
      }, ...rest)) as any)

    try {
      const cs = await buildCreateChangeset('team-serialize-1', 'lock probe')
      const res = await kstore.applyChangesetForTeam('team-serialize-1', cs)
      expect(res.ok).toBe(true)
    } finally {
      spy.mockRestore()
    }

    // The FIRST explicit tx.execute is the advisory lock, keyed on the team, and
    // transaction-scoped (xact => auto-release at commit/rollback).
    expect(executed.length).toBeGreaterThan(0)
    const first = executed[0]
    expect(first).toContain('pg_advisory_xact_lock')
    expect(first).toContain('hashtextextended')
    expect(first).toContain('kernel:apply:team-serialize-1')
  })

  it('serializes on the SAME key for the same team and DIFFERENT keys across teams', async () => {
    // hashtextextended is deterministic, so same-team applies contend on one key
    // and cross-team applies never do. Prove the key derivation via the DB itself.
    const [same1, same2, other] = await Promise.all([
      db.db.execute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import('drizzle-orm')).sql`select hashtextextended(${'kernel:apply:team-A'}, 0) as k`,
      ),
      db.db.execute((await import('drizzle-orm')).sql`select hashtextextended(${'kernel:apply:team-A'}, 0) as k`),
      db.db.execute((await import('drizzle-orm')).sql`select hashtextextended(${'kernel:apply:team-B'}, 0) as k`),
    ])
    const k = (r: any) => (r.rows ? r.rows[0].k : r[0].k)
    expect(String(k(same1))).toBe(String(k(same2)))
    expect(String(k(same1))).not.toBe(String(k(other)))
  })

  it('a normal apply still succeeds and persists under the lock', async () => {
    const cs = await buildCreateChangeset('team-serialize-2', 'under lock')
    const res = await kstore.applyChangesetForTeam('team-serialize-2', cs)
    expect(res.ok).toBe(true)
    const snap = await kstore.readSnapshot('team-serialize-2')
    expect(Object.values(snap.objects).some((o) => o.archetype === 'task')).toBe(true)
  })
})
