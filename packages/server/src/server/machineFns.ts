/**
 * Machine management server functions. Connect flow (two acts):
 *   1. createMachine() → mint a token, create a PENDING (unnamed) row, return
 *      {id, token}. The UI shows the connect command + "waiting…".
 *   2. the daemon connects → poll records online + hostname/platform/arch. The
 *      UI polls machineStatus(id); once connected it shows the name field
 *      (prefilled with the hostname). finalizeMachine({id,name}) names it →
 *      it appears in the list. cancelMachine(id) drops a pending row.
 *
 * Scoping: when the auth gate is on, every fn requires a signed-in user, and a
 * machine is visible/actionable only when the requester owns it, its owner is a
 * member of the active team, or the scope is the admin "All teams" view (the
 * same rule listMachines filters by). The PLAINTEXT device token is serialized
 * ONLY to the machine's owner — it fully impersonates the machine (poll /
 * create-loop / log), so a teammate who can see the row must never exfiltrate
 * it. Open mode (gate off) keeps the shared workspace: everyone sees/manages
 * all machines, tokens included. No workdir jail (fully open) for now.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { Machine } from '../db/schema.js'
import { requestScope, type RequestScope } from '../auth.js'
import { machineIdFromToken, mintDeviceToken, rememberConnectKey, sha256 } from '../gateway/tokens.js'
import { machineInScope, tokenVisibleTo } from './machineScope.js'
import { latestDaemonVersion } from './daemonVersion.js'
import { ensureServer } from './boot.js'
import type { MachineSummary } from '../types'

// The pure scoping decisions live in machineScope.ts (framework/DB-free, unit-
// tested there); re-export for existing importers.
export { machineInScope, tokenVisibleTo }

/** Ids of the machines membership-visible in the scope's active team (the same
 *  set listMachines serves). Empty when the scope needs no team check (open
 *  mode, signed-out, or the admin "All teams" view — machineInScope settles
 *  those before ever invoking its team-set thunk). */
async function teamMachineIds(scope: RequestScope): Promise<ReadonlySet<string>> {
  if (!scope.enforce || !scope.userId || (scope.isAdmin && scope.allTeams)) return new Set()
  return new Set((await store.listMachinesForTeam(scope.teamId)).map((m) => m.id))
}

/**
 * Resolve a machine and authorize it against the request scope (the machine-fn
 * twin of loopApi's `ownedLoop`). `machine` is undefined when it's missing OR
 * out of scope — callers treat both as "not found" so existence never leaks.
 * The scope rides along so callers don't re-run requestScope (a second session
 * decrypt); the team-set thunk keeps the owner fast path query-free.
 */
async function scopedMachine(id: string): Promise<{ scope: RequestScope; machine?: Machine }> {
  const scope = await requestScope()
  const m = await store.getMachine(id)
  // Pre-await the team-id Set so the pure machineInScope keeps its sync thunk
  // contract (the DB join can't live inside a synchronous predicate).
  const teamIds = await teamMachineIds(scope)
  const machine = m && machineInScope(m, scope, () => teamIds) ? m : undefined
  return { scope, machine }
}

async function toSummary(m: Machine, scope: RequestScope): Promise<MachineSummary> {
  return {
    id: m.id,
    name: m.name,
    online: !!m.online,
    lastSeen: m.lastSeen ?? null,
    hostname: m.hostname ?? null,
    platform: m.platform ?? null,
    arch: m.arch ?? null,
    daemonVersion: m.daemonVersion ?? null,
    // Same for every machine (cached npm latest); non-blocking + fail-silent.
    latestDaemonVersion: latestDaemonVersion.get(),
    token: tokenVisibleTo(m, scope) ? (m.token ?? null) : null,
    loopCount: (await store.loopsForMachine(m.id)).length,
  }
}

/** Named machines only (pending/unnamed rows are mid-connect). Scoped to the
 *  given/active team when the gate is on; the full shared list in open mode. An
 *  explicit `teamId` (the `/t/<id>` route) scopes this request independent of the
 *  cookie, so a tab on /t/A and one on /t/B list different machines at once. */
export const listMachines = createServerFn({ method: 'GET' })
  .validator((teamId?: string) => teamId)
  .handler(async ({ data: teamId }) => {
    await ensureServer()
    const scope = await requestScope(teamId)
    const { enforce, userId, teamId: active, allTeams } = scope
    if (enforce && !userId) return []
    // Membership-scoped: a machine shows in every team its owner belongs to (one
    // machine serves many teams, report §2.3). The admin "All teams" view + open
    // mode list everything.
    const list = enforce && !allTeams ? await store.listMachinesForTeam(active) : await store.listMachines()
    return Promise.all(list.filter((m) => m.name.trim()).map((m) => toSummary(m, scope)))
  })

/** Act 1 — create a pending machine + token, owned by the signed-in user's team. */
export const createMachine = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ id: string; token: string } | { error: string }> => {
    await ensureServer()
    const { enforce, userId, teamId } = await requestScope()
    if (enforce && !userId) return { error: 'not signed in' }
    const token = mintDeviceToken()
    const id = machineIdFromToken(token)
    const owner = userId ?? 'shared'
    // Belt-and-braces: the machine row below already carries the owner, but the
    // connect-key binding also covers a daemon that first polls AFTER this row
    // was deleted/recreated (self-register falls back to the key's minter).
    await rememberConnectKey(token, { userId: owner, teamId })
    await store.createMachine({ id, userId: owner, teamId, name: '', tokenHash: sha256(token), token, online: false })
    return { id, token }
  },
)

/** Poll while the connect dialog is open. Scoped like listMachines; the token
 *  rides along only for the machine's owner (the connect dialog's minter). */
export const machineStatus = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<MachineSummary | null> => {
    await ensureServer()
    const { scope, machine } = await scopedMachine(id)
    return machine ? toSummary(machine, scope) : null
  })

/** Act 2 — name the connected machine (it then appears in the list). */
export const finalizeMachine = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await ensureServer()
    const name = data.name?.trim()
    if (!name) return { ok: false }
    const { machine } = await scopedMachine(data.id)
    if (!machine) return { ok: false }
    return { ok: !!(await store.updateMachine(data.id, { name })) }
  })

/**
 * Cancel a pending connect (or delete an existing machine). A machine that still
 * owns loops can't be deleted — the loops execute on it, so they must be removed
 * first (we block rather than cascade, to never silently nuke a loop's history).
 * Pending/unnamed machines have no loops, so the connect-cancel path passes through.
 */
export const deleteMachine = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    await ensureServer()
    const { scope, machine } = await scopedMachine(id)
    // Distinct error shapes on purpose: a signed-out caller is "unauthorized",
    // an out-of-scope/missing machine is "machine not found".
    if (scope.enforce && !scope.userId) return { ok: false, error: 'unauthorized' }
    if (!machine) return { ok: false, error: 'machine not found' }
    const loops = await store.loopsForMachine(id)
    if (loops.length > 0) {
      return {
        ok: false,
        error: `This machine still has ${loops.length} loop${loops.length === 1 ? '' : 's'} — delete ${loops.length === 1 ? 'it' : 'them'} first.`,
      }
    }
    return { ok: await store.deleteMachine(id) }
  })
