import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end proof of the Phase-2 team-URL intent at the data boundary the
 * dashboard tabs render: for ONE signed-in member of teams A and B, the
 * explicit-`teamId` resolution returns DIFFERENT, correctly-scoped loop sets for
 * `/t/A` vs `/t/B` SIMULTANEOUSLY — the explicit route team beats the last-used
 * cookie, and a non-member team is rejected enumeration-safe (indistinguishable
 * from a missing loop).
 *
 * The `/t/<id>` server fns (`listJobs`/`canViewTeam`/`getDefaultTeam`) are thin
 * `createServerFn` wrappers around exactly this composition — `requestScope(teamId)`
 * then a `store` read — so this drives the SAME code path they run, over a real
 * pglite store with the Better Auth session + cookie mocked (the auth.test.ts
 * harness). Each block is annotated with the wrapper it mirrors.
 */

const reqHolder = { headers: new Headers() }
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => ({ headers: reqHolder.headers }),
}))

let tmp: string
let db: typeof import('../db/index.js')
let store: typeof import('../db/store.js')
let authMod: typeof import('../auth.js')

const MEMBER = 'u_member'
let TEAM_A = '' // MEMBER's personal team (owner)
const TEAM_B = 'team-b' // MEMBER joined as a plain member
const TEAM_C = 'team-c' // MEMBER is NOT a member

function signInAs(id: string | null, email: string | null) {
  vi.spyOn(authMod.auth.api, 'getSession').mockResolvedValue(
    id ? ({ user: { id, email } } as unknown as Awaited<ReturnType<typeof authMod.auth.api.getSession>>) : null,
  )
}

function setCookie(teamId: string | null) {
  reqHolder.headers = new Headers(teamId ? { cookie: `adscaile.team=${teamId}` } : {})
}

/** Seed a loop into a team so the two tabs have distinguishable content. */
async function seedLoop(teamId: string, name: string) {
  await store.createLoop({ userId: MEMBER, teamId, machineId: 'm_x', name, cron: '0 6 * * *' })
}

/** listJobs' body, verbatim: resolve the explicit team, then list that team's
 *  loops. Returns loop names for readable evidence. */
async function listJobsFor(explicitTeam?: string): Promise<string[]> {
  const { enforce, userId, teamId: active } = await authMod.requestScope(explicitTeam)
  if (enforce && !userId) return []
  const loops = await store.listLoops(enforce ? active : undefined)
  return loops.map((l) => l.name ?? '(unnamed)').sort()
}

/** canViewTeam's body, verbatim: the `/t/<id>` loader membership gate. */
async function canViewTeam(explicitTeam: string): Promise<boolean> {
  const scope = await authMod.requestScope(explicitTeam)
  if (!scope.enforce) return true
  if (!scope.userId) return false
  return scope.teamId === explicitTeam
}

/** getDefaultTeam's body, verbatim: the bare-"/" redirect target. */
async function getDefaultTeam(): Promise<string> {
  const scope = await authMod.requestScope()
  return scope.teamId
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adscaile-teamurl-'))
  process.env.ADSCAILE_DATA_DIR = tmp
  process.env.ADSCAILE_DB_PATH = path.join(tmp, 'test.db')
  process.env.ADSCAILE_LOG_LEVEL = 'silent'
  process.env.GITHUB_CLIENT_ID = 'gh-id'
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret'
  process.env.ADSCAILE_AUTH_SECRET = 'test-secret'

  db = await import('../db/index.js')
  await db.runMigrations()
  store = await import('../db/store.js')
  authMod = await import('../auth.js')

  TEAM_A = store.teamIdForUser(MEMBER)
  await store.ensureTeam(TEAM_A, "Member's Team", MEMBER)
  await store.ensureTeam(TEAM_B, 'Team B', 'u_other')
  await db.db.insert(db.teamMembers).values({
    id: `${TEAM_B}:${MEMBER}`,
    teamId: TEAM_B,
    userId: MEMBER,
    role: 'member',
    createdAt: new Date(0).toISOString(),
  })
  await store.ensureTeam(TEAM_C, 'Team C', 'u_stranger')

  await seedLoop(TEAM_A, 'Alpha loop (team A)')
  await seedLoop(TEAM_B, 'Bravo loop (team B)')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
  setCookie(null)
})

describe('two tabs on /t/A and /t/B render different teams at once (explicit teamId)', () => {
  it('listJobs is scoped by the explicit route team, independent of the cookie', async () => {
    signInAs(MEMBER, 'member@example.com')
    // The last-used cookie points at team A, but the /t/B tab passes B explicitly.
    setCookie(TEAM_A)

    const namesA = await listJobsFor(TEAM_A)
    const namesB = await listJobsFor(TEAM_B)

    console.log('\n=== /t/<team> dashboard payloads (one signed-in member, two tabs) ===')
    console.log('  cookie last-used = team A')
    console.log(`  GET listJobs(teamId="${TEAM_A}")  ->`, namesA)
    console.log(`  GET listJobs(teamId="${TEAM_B}")  ->`, namesB)

    expect(namesA).toEqual(['Alpha loop (team A)'])
    expect(namesB).toEqual(['Bravo loop (team B)']) // cookie=A did NOT leak into the /t/B tab
  })

  it('canViewTeam gates the /t/<id> loader: member ok, non-member rejected (no leak)', async () => {
    signInAs(MEMBER, 'member@example.com')
    const okA = await canViewTeam(TEAM_A)
    const okB = await canViewTeam(TEAM_B)
    const okC = await canViewTeam(TEAM_C) // never joined

    console.log('\n=== canViewTeam (the /t/<id> membership gate) ===')
    console.log(`  canViewTeam("${TEAM_A}") ->`, okA)
    console.log(`  canViewTeam("${TEAM_B}") ->`, okB)
    console.log(`  canViewTeam("${TEAM_C}") ->`, okC, '(non-member => generic not-found)')

    expect(okA).toBe(true)
    expect(okB).toBe(true)
    expect(okC).toBe(false)
  })

  it('getDefaultTeam backs the bare-/ redirect (last-used cookie, validated)', async () => {
    signInAs(MEMBER, 'member@example.com')
    setCookie(TEAM_B) // last used team B
    const target = await getDefaultTeam()
    console.log('\n=== bare "/" redirect target (getDefaultTeam) ===')
    console.log(`  cookie adscaile.team=${TEAM_B} -> redirect /t/${target}`)
    expect(target).toBe(TEAM_B)
  })
})
