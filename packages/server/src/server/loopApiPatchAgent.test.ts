import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { CODING_AGENTS, coerceCodingAgent } from '../types.js'
import type { JobPayload } from '../types.js'
import type { NewLoop } from '../db/schema.js'

/**
 * The shared coding-agent enum validator + the web `patchJob` agent write path.
 *
 * `coerceCodingAgent` is the ONE enum validator both write surfaces read (server
 * `buildEditUpdate` + the web select), so it is exercised directly here.
 *
 * `patchJob` is a thin `createServerFn` wrapper; its distinguishing agent logic is
 * the `...(p.agent !== undefined ? { agent: p.agent } : {})` spread into
 * `store.updateLoop`. Following the `teamUrlScope.integration` convention, this
 * mirrors exactly that spread over a real pglite store to prove a `JobPayload`
 * carrying `agent` persists (and that an absent `agent` is untouched).
 */

let tmp: string
let store: typeof import('../db/store.js')

/** patchJob's agent spread, verbatim (the only field this test drives). */
function agentUpdate(p: JobPayload): Partial<NewLoop> {
  return { ...(p.agent !== undefined ? { agent: p.agent } : {}) }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopany-patchagent-'))
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

test('coerceCodingAgent accepts every known enum value and rejects the rest', () => {
  for (const a of CODING_AGENTS) expect(coerceCodingAgent(a)).toBe(a)
  for (const bad of ['emacs', 'CLAUDE-CODE', '', ' codex', 42, null, undefined, {}]) {
    expect(coerceCodingAgent(bad)).toBeNull()
  }
})

test('patchJob agent spread persists a JobPayload agent through store.updateLoop', async () => {
  const created = await store.createLoop({ userId: 'u1', teamId: 't1', machineId: 'm1', name: 'A', cron: '0 6 * * *' })
  // Create default is claude-code (no agent on the create body).
  expect(created.agent).toBe('claude-code')

  const updated = await store.updateLoop(created.id, agentUpdate({ agent: 'codex' }))
  expect(updated!.agent).toBe('codex')

  // An absent agent leaves the recorded value untouched (empty spread → no write).
  const noop = await store.updateLoop(created.id, agentUpdate({ name: 'B' }))
  expect(noop!.agent).toBe('codex')
})
