/**
 * Notification-channel server functions. Channels are per-team push targets a
 * loop can route its run messages to. Secrets (bot token / chat id) live in the
 * channel's `config` and are NEVER returned to the client — list/test surface
 * only a redacted summary. Scoped to the request's team (see requestScope).
 *
 * Per-type behavior (validate / hint / send) lives in `CHANNELS` (gateway/notify);
 * this module just wires it to auth + storage.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { ChannelConfig, ChannelType, NotificationChannel } from '../db/schema.js'
import { requestScope } from '../auth.js'
import { ensureServer } from './boot.js'
import { CHANNELS } from '../gateway/notify.js'
import type { ChannelSummary } from '../types'

function toSummary(c: NotificationChannel): ChannelSummary {
  return { id: c.id, type: c.type, name: c.name, hint: CHANNELS[c.type]?.hint(c.config) ?? '—' }
}

/** Resolve a channel and authorize it against the request's team — undefined when
 *  missing OR (gate on) owned by another team, so existence never leaks. Mirrors
 *  loopApi's ownedLoop for the channel routes. */
async function ownedChannel(id: string): Promise<NotificationChannel | undefined> {
  const ch = store.getChannel(id)
  if (!ch) return undefined
  const { enforce, teamId } = await requestScope()
  if (enforce && ch.teamId !== teamId) return undefined
  return ch
}

/** GET — the team's channels (redacted summaries, newest first). */
export const listChannels = createServerFn({ method: 'GET' }).handler(async (): Promise<ChannelSummary[]> => {
  ensureServer()
  const { enforce, userId, teamId } = await requestScope()
  if (enforce && !userId) return []
  return store.listChannels(teamId).map(toSummary)
})

/** POST — create a channel in the team. Validates per-type required fields. */
export const createChannel = createServerFn({ method: 'POST' })
  .validator((d: { type: ChannelType; name: string; config: ChannelConfig }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    ensureServer()
    const { enforce, userId, teamId } = await requestScope()
    if (enforce && !userId) return { ok: false, error: 'not signed in' }
    const name = data.name?.trim()
    if (!name) return { ok: false, error: 'name required' }
    const kind = CHANNELS[data.type]
    if (!kind) return { ok: false, error: 'unknown channel type' }
    const cfg = data.config ?? {}
    const missing = kind.required.filter((k) => !cfg[k]?.trim())
    if (missing.length) return { ok: false, error: `${data.type} needs: ${missing.join(', ')}` }
    // Keep only this type's keys (required + any provided optional; no cross-type
    // leakage), trimmed.
    const keys = [...kind.required, ...(kind.optional ?? [])]
    const config: ChannelConfig = Object.fromEntries(keys.filter((k) => cfg[k]?.trim()).map((k) => [k, cfg[k]!.trim()]))
    const ch = store.createChannel({ teamId, type: data.type, name, config })
    return { ok: true, id: ch.id }
  })

/** POST — delete a channel (loops pointing at it fall back to dashboard-only). */
export const deleteChannel = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    ensureServer()
    if (!(await ownedChannel(id))) return { ok: false, error: 'channel not found' }
    return { ok: store.deleteChannel(id) }
  })

/** POST — send a test message through a saved channel (verifies the secrets). */
export const testChannel = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    ensureServer()
    const ch = await ownedChannel(id)
    if (!ch) return { ok: false, error: 'channel not found' }
    return CHANNELS[ch.type].send(ch.config, ch.name, 'Loopany test message — this channel is wired up. ✓')
  })
