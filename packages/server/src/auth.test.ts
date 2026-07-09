import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `requestScope`'s explicit-team resolution (Phase 2 of the team-URL work). The
 * `/t/<teamId>` route hands requestScope an EXPLICIT team that must take precedence
 * over the last-used cookie yet still be membership-validated — never trusted blind.
 * A rejected explicit team falls through to the personal team exactly like a stale
 * cookie, which is how `canViewTeam` detects "no access" without leaking that the
 * team exists.
 *
 * requestScope needs the Start request runtime (cookie header) + a Better Auth
 * session, so we mock `getRequest` (cookie source) and spy on `auth.api.getSession`
 * (the signed-in user) over a real pglite store with seeded teams/memberships.
 */

// Mutable request stub — currentUser()/selectedTeam() both read getRequest().headers.
const reqHolder = { headers: new Headers() }
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => ({ headers: reqHolder.headers }),
}))

let tmp: string
let db: typeof import('./db/index.js')
let store: typeof import('./db/store.js')
let authMod: typeof import('./auth.js')

const MEMBER = 'u_member'
let TEAM_PERSONAL: string // MEMBER's own team (owner)
const TEAM_B = 'team-b' // MEMBER is a member (not owner)
const TEAM_C = 'team-c' // MEMBER is NOT a member

/** Point the mocked session at a user (id + email). */
function signInAs(id: string | null, email: string | null) {
  vi.spyOn(authMod.auth.api, 'getSession').mockResolvedValue(
    id ? ({ user: { id, email } } as unknown as Awaited<ReturnType<typeof authMod.auth.api.getSession>>) : null,
  )
}

/** Set (or clear) the adscaile.team cookie the request carries. */
function setCookie(teamId: string | null) {
  reqHolder.headers = new Headers(teamId ? { cookie: `adscaile.team=${teamId}` } : {})
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adscaile-auth-'))
  process.env.ADSCAILE_DATA_DIR = tmp
  process.env.ADSCAILE_DB_PATH = path.join(tmp, 'test.db')
  process.env.ADSCAILE_LOG_LEVEL = 'silent'
  // Turn the gate ON (enforce), read at module load.
  process.env.GITHUB_CLIENT_ID = 'gh-id'
  process.env.GITHUB_CLIENT_SECRET = 'gh-secret'
  process.env.ADSCAILE_AUTH_SECRET = 'test-secret'

  db = await import('./db/index.js')
  await db.runMigrations()
  store = await import('./db/store.js')
  authMod = await import('./auth.js')

  TEAM_PERSONAL = store.teamIdForUser(MEMBER)
  await store.ensureTeam(TEAM_PERSONAL, "Member's Team", MEMBER) // MEMBER owns it
  await store.ensureTeam(TEAM_B, 'Team B', 'u_other') // owned by someone else…
  await db.db.insert(db.teamMembers).values({
    id: `${TEAM_B}:${MEMBER}`,
    teamId: TEAM_B,
    userId: MEMBER,
    role: 'member',
    createdAt: new Date(0).toISOString(),
  }) // …MEMBER joined as a plain member
  await store.ensureTeam(TEAM_C, 'Team C', 'u_stranger') // MEMBER never joins
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  vi.restoreAllMocks()
  setCookie(null)
})

describe('requestScope explicit team (the /t/<teamId> route)', () => {
  it('the gate is enforced in this suite', () => {
    expect(authMod.authEnabled).toBe(true)
  })

  it('an explicit member team wins over a different cookie', async () => {
    signInAs(MEMBER, 'member@example.com')
    setCookie(TEAM_PERSONAL) // last-used cookie points elsewhere
    const scope = await authMod.requestScope(TEAM_B)
    expect(scope.teamId).toBe(TEAM_B)
  })

  it('an explicit team the user is NOT in falls back to the personal team (no leak)', async () => {
    signInAs(MEMBER, 'member@example.com')
    setCookie(TEAM_B)
    const scope = await authMod.requestScope(TEAM_C)
    // Rejected ⇒ personal team, NOT the requested one and NOT the cookie's.
    expect(scope.teamId).toBe(TEAM_PERSONAL)
  })

  it('no explicit team ⇒ the cookie still resolves (last-used default)', async () => {
    signInAs(MEMBER, 'member@example.com')
    setCookie(TEAM_B)
    const scope = await authMod.requestScope()
    expect(scope.teamId).toBe(TEAM_B)
  })

  it("an explicit personal team is honored (matches canViewTeam's fast path)", async () => {
    signInAs(MEMBER, 'member@example.com')
    const scope = await authMod.requestScope(TEAM_PERSONAL)
    expect(scope.teamId).toBe(TEAM_PERSONAL)
  })
})
