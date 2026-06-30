/**
 * Machine management server functions. Connect flow (two acts):
 *   1. createMachine() → mint a token, create a PENDING (unnamed) row, return
 *      {id, token}. The UI shows the connect command + "waiting…".
 *   2. the daemon connects → poll records online + hostname/platform/arch. The
 *      UI polls machineStatus(id); once connected it shows the name field
 *      (prefilled with the hostname). finalizeMachine({id,name}) names it →
 *      it appears in the list. cancelMachine(id) drops a pending row.
 *
 * Shared workspace (v1): everyone sees/manages all machines. No workdir jail
 * (fully open) for now.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { Machine } from '../db/schema.js'
import { requestScope } from '../auth.js'
import { machineIdFromToken, mintDeviceToken, setDeviceOwner, sha256 } from '../gateway/tokens.js'
import { ensureServer } from './boot.js'
import type { MachineSummary } from '../types'

function toSummary(m: Machine): MachineSummary {
  return {
    id: m.id,
    name: m.name,
    online: !!m.online,
    lastSeen: m.lastSeen ?? null,
    hostname: m.hostname ?? null,
    platform: m.platform ?? null,
    arch: m.arch ?? null,
    token: m.token ?? null,
    loopCount: store.loopsForMachine(m.id).length,
  }
}

/** Named machines only (pending/unnamed rows are mid-connect). Scoped to the
 *  signed-in owner when the gate is on; the full shared list in open mode. */
export const listMachines = createServerFn({ method: 'GET' }).handler(async () => {
  ensureServer()
  const { enforce, userId, teamId, allTeams } = await requestScope()
  if (enforce && !userId) return []
  // Membership-scoped: a machine shows in every team its owner belongs to (one
  // machine serves many teams, report §2.3). The admin "All teams" view + open
  // mode list everything.
  const list = enforce && !allTeams ? store.listMachinesForTeam(teamId) : store.listMachines()
  return list.filter((m) => m.name.trim()).map(toSummary)
})

/** Act 1 — create a pending machine + token, owned by the signed-in user's team. */
export const createMachine = createServerFn({ method: 'POST' }).handler(async (): Promise<{ id: string; token: string }> => {
  ensureServer()
  const { userId, teamId } = await requestScope()
  const token = mintDeviceToken()
  const id = machineIdFromToken(token)
  const owner = userId ?? 'shared'
  setDeviceOwner(id, owner)
  store.createMachine({ id, userId: owner, teamId, name: '', tokenHash: sha256(token), token, online: false })
  return { id, token }
})

/** Poll while the connect dialog is open. */
export const machineStatus = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ data: id }): MachineSummary | null => {
    ensureServer()
    const m = store.getMachine(id)
    return m ? toSummary(m) : null
  })

/** Act 2 — name the connected machine (it then appears in the list). */
export const finalizeMachine = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => d)
  .handler(({ data }): { ok: boolean } => {
    ensureServer()
    const name = data.name?.trim()
    if (!name) return { ok: false }
    return { ok: !!store.updateMachine(data.id, { name }) }
  })

/**
 * Cancel a pending connect (or delete an existing machine). A machine that still
 * owns loops can't be deleted — the loops execute on it, so they must be removed
 * first (we block rather than cascade, to never silently nuke a loop's history).
 * Pending/unnamed machines have no loops, so the connect-cancel path passes through.
 */
export const deleteMachine = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(({ data: id }): { ok: boolean; error?: string } => {
    ensureServer()
    const loops = store.loopsForMachine(id)
    if (loops.length > 0) {
      return {
        ok: false,
        error: `This machine still has ${loops.length} loop${loops.length === 1 ? '' : 's'} — delete ${loops.length === 1 ? 'it' : 'them'} first.`,
      }
    }
    return { ok: store.deleteMachine(id) }
  })
