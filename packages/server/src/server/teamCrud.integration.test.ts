import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * End-to-end proof of the Team CRUD lifecycle at the data boundary, over a REAL
 * pglite store. Drives `teamAdmin` directly (the ONE authorization + rules
 * chokepoint the thin `teamFns` server fns delegate to), with real `user` rows
 * seeded for the direct-add-by-email + membership joins. Covers every §7 decision
 * and every scope-item-3/4 scenario: create/rename/delete lifecycle, the
 * block-delete-with-loops guard, the personal-team rules, the last-owner guard,
 * multi-owner, role authorization (a member can't manage), the invite redeem
 * paths (valid / expired / already-member / single-use / revoke), and explicit-
 * teamId cross-team management (managing team B is unaffected by any other team).
 */

let tmp: string
let db: typeof import('../db/index.js')
let store: typeof import('../db/store.js')
let team: typeof import('./teamAdmin.js')
let userTable: typeof import('../db/auth-schema.js').user

const ALICE = 'u_alice'
const BOB = 'u_bob'
const CAROL = 'u_carol'

async function seedUser(id: string, email: string) {
  const now = new Date(0)
  await db.db
    .insert(userTable)
    .values({ id, name: id, email, emailVerified: true, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
}

async function seedLoop(teamId: string, name: string) {
  await store.createLoop({ userId: ALICE, teamId, machineId: 'm_x', name, cron: '0 6 * * *' })
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adscaile-teamcrud-'))
  process.env.ADSCAILE_DATA_DIR = tmp
  process.env.ADSCAILE_DB_PATH = path.join(tmp, 'test.db')
  process.env.ADSCAILE_LOG_LEVEL = 'silent'

  db = await import('../db/index.js')
  await db.runMigrations()
  store = await import('../db/store.js')
  team = await import('./teamAdmin.js')
  userTable = (await import('../db/auth-schema.js')).user

  await seedUser(ALICE, 'alice@example.com')
  await seedUser(BOB, 'bob@example.com')
  await seedUser(CAROL, 'carol@example.com')
  // Personal teams (the requestScope fallback), so isPersonalTeam is meaningful.
  await store.ensureTeam(store.teamIdForUser(ALICE), "alice's Team", ALICE)
  await store.ensureTeam(store.teamIdForUser(BOB), "bob's Team", BOB)
  await store.ensureTeam(store.teamIdForUser(CAROL), "carol's Team", CAROL)
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A fresh non-personal team owned by Alice, for tests that mutate membership. */
async function freshTeam(name = 'Growth Squad'): Promise<string> {
  const r = await team.createTeam(ALICE, name)
  expect(r.ok).toBe(true)
  return (r as { ok: true; id: string }).id
}

describe('create / rename / delete lifecycle', () => {
  it('createTeam makes the creator an owner and lists it', async () => {
    const id = await freshTeam('Alpha Co')
    const detail = await team.getTeamDetail(ALICE, id)
    expect(detail?.name).toBe('Alpha Co')
    expect(detail?.role).toBe('owner')
    expect(detail?.personal).toBe(false)
    expect(detail?.members.map((m) => m.userId)).toEqual([ALICE])

    const mine = await team.listManagedTeams(ALICE)
    const row = mine.find((t) => t.id === id)
    expect(row).toMatchObject({ role: 'owner', memberCount: 1, personal: false })
    console.log('\n=== createTeam ===')
    console.log(`  ${ALICE} created "${row?.name}" (${id}) as ${row?.role}, ${row?.memberCount} member`)
  })

  it('an owner renames; a member cannot', async () => {
    const id = await freshTeam()
    await store.addTeamMember(id, BOB, 'member')

    const asMember = await team.renameTeam(BOB, id, 'Hijacked')
    expect(asMember).toEqual({ ok: false, error: 'Only a team owner can manage this team.' })

    const asOwner = await team.renameTeam(ALICE, id, 'Renamed Squad')
    expect(asOwner.ok).toBe(true)
    expect((await team.getTeamDetail(ALICE, id))?.name).toBe('Renamed Squad')
  })

  it('delete is blocked while the team owns loops, then succeeds after cleanup', async () => {
    const id = await freshTeam('Doomed')
    await seedLoop(id, 'a loop')
    const blocked = await team.deleteTeam(ALICE, id)
    expect(blocked.ok).toBe(false)
    expect((blocked as { error: string }).error).toMatch(/still owns 1 loop/)
    console.log('\n=== delete blocked-by-loops (decision 1) ===')
    console.log(`  deleteTeam -> ${(blocked as { error: string }).error}`)

    // Move/delete the loop, then delete succeeds.
    const loops = await store.listLoops(id)
    await store.deleteLoop(loops[0]!.id)
    const ok = await team.deleteTeam(ALICE, id)
    expect(ok.ok).toBe(true)
    expect(await store.getTeam(id)).toBeUndefined()
  })

  it('deleteTeam cascades channels, members, and invites but leaves other teams', async () => {
    const id = await freshTeam('Cascade')
    await store.addTeamMember(id, BOB, 'member')
    await store.createChannel({ teamId: id, type: 'telegram', name: 'ch', config: { botToken: 'x', chatId: 'y' } })
    await team.createInvite(ALICE, id, 'member', Date.now())
    expect((await store.listChannels(id)).length).toBe(1)

    await team.deleteTeam(ALICE, id)
    expect((await store.listChannels(id)).length).toBe(0)
    expect(await store.getTeamMember(id, BOB)).toBeUndefined()
    expect((await store.listPendingInvites(id)).length).toBe(0)
    // Bob's own personal team is untouched.
    expect(await store.getTeam(store.teamIdForUser(BOB))).toBeDefined()
  })
})

describe('personal-team rules (decision 5)', () => {
  it('the personal team is renamable but not deletable and not leavable', async () => {
    const personal = store.teamIdForUser(ALICE)
    const renamed = await team.renameTeam(ALICE, personal, 'My Space')
    expect(renamed.ok).toBe(true)
    expect((await store.getTeam(personal))?.name).toBe('My Space')

    const del = await team.deleteTeam(ALICE, personal)
    expect(del).toEqual({ ok: false, error: "Your personal team can't be deleted." })

    const leave = await team.leaveTeam(ALICE, personal)
    expect(leave).toEqual({ ok: false, error: "You can't leave your personal team." })
  })

  it('the renamed personal team name is NOT reverted by ensureTeam (no force-sync)', async () => {
    const personal = store.teamIdForUser(ALICE)
    // Simulate a subsequent request re-ensuring the personal team with the old
    // email-derived name — the insert-only ensureTeam must NOT overwrite.
    await store.ensureTeam(personal, "alice's Team", ALICE)
    expect((await store.getTeam(personal))?.name).toBe('My Space')
  })
})

describe('last-owner guard + multi-owner (decision 6)', () => {
  it('the sole owner cannot be demoted, removed, or leave — until a second owner exists', async () => {
    const id = await freshTeam('Owners')
    await store.addTeamMember(id, BOB, 'member')

    expect(await team.setMemberRole(ALICE, id, ALICE, 'member')).toMatchObject({ ok: false })
    expect(await team.leaveTeam(ALICE, id)).toMatchObject({ ok: false })

    // Promote Bob to owner → now multi-owner, so Alice may leave.
    expect((await team.setMemberRole(ALICE, id, BOB, 'owner')).ok).toBe(true)
    expect(await store.countTeamOwners(id)).toBe(2)
    expect((await team.leaveTeam(ALICE, id)).ok).toBe(true)
    expect(await store.getTeamMember(id, ALICE)).toBeUndefined()
    // Bob is now the last owner and is protected again.
    expect(await team.leaveTeam(BOB, id)).toMatchObject({ ok: false })
  })

  it('removeMember refuses self (use leave) and refuses the last owner', async () => {
    const id = await freshTeam('Remove')
    await store.addTeamMember(id, BOB, 'member')
    expect(await team.removeMember(ALICE, id, ALICE)).toMatchObject({ ok: false, error: expect.stringMatching(/Leave team/) })
    expect((await team.removeMember(ALICE, id, BOB)).ok).toBe(true)
    expect(await store.getTeamMember(id, BOB)).toBeUndefined()
  })
})

describe('member management authorization (decision 4 — owner-only)', () => {
  it('a plain member cannot add, set roles, remove, invite, or delete', async () => {
    const id = await freshTeam('Locked')
    await store.addTeamMember(id, BOB, 'member')
    const denied = /Only a team owner can manage this team\./
    expect((await team.addMemberByEmail(BOB, id, 'carol@example.com', 'member')).ok).toBe(false)
    expect((await team.setMemberRole(BOB, id, ALICE, 'member') as { error: string }).error).toMatch(denied)
    expect((await team.removeMember(BOB, id, ALICE) as { error: string }).error).toMatch(denied)
    expect((await team.createInvite(BOB, id, 'member', Date.now()) as { error: string }).error).toMatch(denied)
    expect((await team.deleteTeam(BOB, id) as { error: string }).error).toMatch(denied)
    // A non-member gets the enumeration-safe not-found, not the owner message.
    expect((await team.renameTeam(CAROL, id, 'x') as { error: string }).error).toMatch(/do not have access/)
  })
})

describe('add-by-email fast path (decision 2 option A)', () => {
  it('adds an existing account; rejects unknown email and double-add', async () => {
    const id = await freshTeam('Emails')
    const ok = await team.addMemberByEmail(ALICE, id, 'BOB@example.com', 'member') // case-insensitive
    expect(ok.ok).toBe(true)
    expect(await store.getTeamMember(id, BOB)).toBeDefined()

    const dupe = await team.addMemberByEmail(ALICE, id, 'bob@example.com', 'member')
    expect(dupe).toMatchObject({ ok: false })
    expect((dupe as { error: string }).error).toMatch(/already a member/)

    const unknown = await team.addMemberByEmail(ALICE, id, 'nobody@example.com', 'member')
    expect(unknown).toMatchObject({ ok: false })
    expect((unknown as { error: string }).error).toMatch(/invite link/)
  })
})

describe('invite links (decision 2 option B)', () => {
  it('valid redeem grants membership at the invite role; single-use burns the link', async () => {
    const id = await freshTeam('Invite')
    const minted = await team.createInvite(ALICE, id, 'owner', Date.now())
    expect(minted.ok).toBe(true)
    const token = (minted as { ok: true; token: string }).token
    console.log('\n=== invite link redeem ===')
    console.log(`  minted owner-invite ${token.slice(0, 16)}… for ${id}`)

    const redeemed = await team.redeemInvite(CAROL, token, Date.now())
    expect(redeemed).toMatchObject({ ok: true, teamId: id, alreadyMember: false })
    expect((await store.getTeamMember(id, CAROL))?.role).toBe('owner')

    // Single-use: a second redeem (even by a different user) is refused.
    const reuse = await team.redeemInvite(BOB, token, Date.now())
    expect(reuse).toEqual({ ok: false, error: 'This invite link has already been used.' })
    expect(await store.getTeamMember(id, BOB)).toBeUndefined()
  })

  it('an expired invite is refused', async () => {
    const id = await freshTeam('Expired')
    const now = Date.now()
    const minted = await team.createInvite(ALICE, id, 'member', now)
    const token = (minted as { ok: true; token: string }).token
    const redeemed = await team.redeemInvite(CAROL, token, now + team.INVITE_TTL_MS + 1)
    expect(redeemed).toEqual({ ok: false, error: 'This invite link has expired.' })
    expect(await store.getTeamMember(id, CAROL)).toBeUndefined()
  })

  it('redeeming as an already-member succeeds without a duplicate and still burns the link', async () => {
    const id = await freshTeam('AlreadyMember')
    await store.addTeamMember(id, CAROL, 'member')
    const minted = await team.createInvite(ALICE, id, 'owner', Date.now())
    const token = (minted as { ok: true; token: string }).token
    const redeemed = await team.redeemInvite(CAROL, token, Date.now())
    expect(redeemed).toMatchObject({ ok: true, alreadyMember: true })
    // Role is NOT escalated by an already-member redeem.
    expect((await store.getTeamMember(id, CAROL))?.role).toBe('member')
    // Link is spent.
    expect((await store.getInvite(token))?.redeemedAt).toBeTruthy()
  })

  it('an invalid token is refused; an owner can revoke a pending invite', async () => {
    const id = await freshTeam('Revoke')
    expect(await team.redeemInvite(CAROL, 'inv_bogus', Date.now())).toEqual({
      ok: false,
      error: 'This invite link is invalid.',
    })
    const minted = await team.createInvite(ALICE, id, 'member', Date.now())
    const token = (minted as { ok: true; token: string }).token
    expect((await store.listPendingInvites(id)).length).toBe(1)
    expect((await team.revokeInvite(ALICE, id, token)).ok).toBe(true)
    expect((await store.listPendingInvites(id)).length).toBe(0)
    // A revoked (deleted) invite no longer redeems.
    expect(await team.redeemInvite(CAROL, token, Date.now())).toMatchObject({ ok: false })
  })
})

describe('explicit-teamId cross-team management', () => {
  it('managing team B is authorized by role in B alone, independent of any other team', async () => {
    // Alice owns A and B; Bob is only a member of A. Bob managing B must fail on
    // B's role, never leak from his A membership.
    const teamA = await freshTeam('Team A')
    const teamB = await freshTeam('Team B')
    await store.addTeamMember(teamA, BOB, 'member')

    // Bob is a member of A but NOT in B → not-found on B (enumeration-safe).
    expect((await team.getTeamDetail(BOB, teamB))).toBeNull()
    expect((await team.renameTeam(BOB, teamB, 'x') as { error: string }).error).toMatch(/do not have access/)

    // Alice owns both and can manage B while "browsing" A — teamAdmin only ever
    // consults the EXPLICIT teamId's membership.
    expect((await team.renameTeam(ALICE, teamB, 'Team B Renamed')).ok).toBe(true)
    expect((await team.getTeamDetail(ALICE, teamB))?.name).toBe('Team B Renamed')
    // A is unaffected.
    expect((await team.getTeamDetail(ALICE, teamA))?.name).toBe('Team A')
  })
})
