/**
 * Pure machine-scoping decisions — the authorization logic behind the machine
 * server fns (machineStatus / finalizeMachine / deleteMachine visibility and
 * toSummary's plaintext-token exposure). Framework-free (type-only imports, no
 * store/DB), mirroring lib/fileEntries.ts, so the rules are unit-testable
 * without a request, a session, or a SQLite handle.
 */
import type { Machine } from '../db/schema.js'
import type { RequestScope } from '../auth.js'

/**
 * Whether a machine is visible/actionable in the request scope. Mirrors
 * listMachines: open mode sees everything; otherwise the requester must own the
 * machine or share the active team with its owner. `teamMachineIds` is a THUNK
 * (the team set needs a DB join) invoked only after the owner check misses — the
 * hot path (machineStatus polls every ~2.5s while the connect dialog is open,
 * usually by the owner) pays no query.
 */
export function machineInScope(
  m: Pick<Machine, 'id' | 'userId'>,
  scope: Pick<RequestScope, 'enforce' | 'userId'>,
  teamMachineIds: () => ReadonlySet<string>,
): boolean {
  if (!scope.enforce) return true
  if (!scope.userId) return false
  if (m.userId === scope.userId) return true
  return teamMachineIds().has(m.id)
}

/**
 * Whether the machine's PLAINTEXT device token may be serialized to this
 * requester. Owner-only under the gate — the token fully impersonates the
 * machine, so even a teammate/admin who may see (or delete) the row gets
 * `token: null`. Open mode keeps the v1 behavior (token shown, e.g. for the
 * reconnect command).
 */
export function tokenVisibleTo(
  m: Pick<Machine, 'userId'>,
  scope: Pick<RequestScope, 'enforce' | 'userId'>,
): boolean {
  return !scope.enforce || m.userId === scope.userId
}
