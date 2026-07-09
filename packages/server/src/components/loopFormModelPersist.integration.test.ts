import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { JobPayload } from '../types.js'
import type { NewLoop } from '../db/schema.js'
import { buildFormExec } from './LoopForm.js'

/**
 * End-to-end proof of the manual-Edit model-persist bug fix, driven against a
 * real pglite store the way patchJob writes it.
 *
 * The bug: a taskFile/workflow-only loop has an EMPTY workdir. The old form
 * `read()` built `exec` only when workdir was non-empty, so a model edit never
 * rode the Save payload and `patchJob` (which writes model ONLY via
 * `p.exec?.model !== undefined`) silently no-op'd. The DB never updated even
 * though the form looked saved. Clearing model was also broken (empty coerced
 * to `undefined`, so the `trim() || null` clear path was never reached).
 *
 * This mirrors patchJob's exec write verbatim over the real store to prove that
 * the fixed form payload actually persists a model change (and a clear) for the
 * common empty-workdir loop.
 */

let tmp: string
let store: typeof import('../db/store.js')

/** patchJob's exec write, verbatim (loopApi.ts). The only slice this test drives. */
function execUpdate(p: JobPayload): Partial<NewLoop> {
  return {
    ...(p.exec?.workdir !== undefined ? { workdir: p.exec.workdir.trim() || null } : {}),
    ...(p.exec?.model !== undefined ? { model: p.exec.model.trim() || null } : {}),
    ...(p.exec?.allowControl !== undefined ? { allowControl: !!p.exec.allowControl } : {}),
  }
}

/** The OLD, buggy form read(): exec only when workdir was non-empty. */
function legacyExec(f: { workdir: string; model: string; allowControl: boolean }) {
  return f.workdir.trim()
    ? { executor: 'claude' as const, workdir: f.workdir.trim(), model: f.model.trim() || undefined, allowControl: f.allowControl }
    : undefined
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-modelpersist-'))
  process.env.LOOPANY_DATA_DIR = tmp
  process.env.LOOPANY_DB_PATH = path.join(tmp, 'test.db')
  process.env.LOOPANY_LOG_LEVEL = 'silent'
  const db = await import('../db/index.js')
  await db.runMigrations()
  store = await import('../db/store.js')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('BASELINE: the old form read() drops the model edit for an empty-workdir loop', async () => {
  const loop = await store.createLoop({
    userId: 'u1', teamId: 't1', machineId: 'm1', name: 'Workflow-only', cron: '0 6 * * *', model: 'claude-sonnet-4-20250514',
  })
  // Owner opens Edit on a taskFile/workflow-only loop (empty workdir) and picks a new model.
  const exec = legacyExec({ workdir: '', model: 'claude-opus-4-20250514', allowControl: true })
  expect(exec).toBeUndefined() // <- the bug: no exec object at all
  const updated = await store.updateLoop(loop.id, execUpdate({ exec }))
  // The model change never reached the DB.
  expect(updated!.model).toBe('claude-sonnet-4-20250514')
})

test('FIXED: a model edit persists for an empty-workdir (workflow-only) loop', async () => {
  const loop = await store.createLoop({
    userId: 'u1', teamId: 't1', machineId: 'm1', name: 'Workflow-only', cron: '0 6 * * *', model: 'claude-sonnet-4-20250514',
  })
  const exec = buildFormExec({ workdir: '', model: 'claude-opus-4-20250514', allowControl: true })
  const updated = await store.updateLoop(loop.id, execUpdate({ exec }))
  // The new model is persisted despite the empty workdir.
  expect(updated!.model).toBe('claude-opus-4-20250514')
  expect(updated!.workdir).toBeNull() // empty workdir stays cleared, not clobbered
})

test('FIXED: clearing the Model field persists as a NULL model', async () => {
  const loop = await store.createLoop({
    userId: 'u1', teamId: 't1', machineId: 'm1', name: 'Pinned model', cron: '0 6 * * *', model: 'claude-opus-4-20250514',
  })
  // Owner blanks the Model field (whitespace only) and Saves.
  const exec = buildFormExec({ workdir: '', model: '   ', allowControl: true })
  const updated = await store.updateLoop(loop.id, execUpdate({ exec }))
  expect(updated!.model).toBeNull() // the clear path (trim() || null) is reached
})

test('FIXED: a model edit persists for a non-empty-workdir loop too (no regression)', async () => {
  const loop = await store.createLoop({
    userId: 'u1', teamId: 't1', machineId: 'm1', name: 'Workdir loop', cron: '0 6 * * *', workdir: '/tmp/old', model: 'claude-sonnet-4-20250514',
  })
  const exec = buildFormExec({ workdir: '/home/me/app', model: 'claude-opus-4-20250514', allowControl: false })
  const updated = await store.updateLoop(loop.id, execUpdate({ exec }))
  expect(updated!.model).toBe('claude-opus-4-20250514')
  expect(updated!.workdir).toBe('/home/me/app')
  expect(updated!.allowControl).toBe(false)
})
