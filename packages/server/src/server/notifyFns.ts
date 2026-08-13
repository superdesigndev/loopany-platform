/**
 * Notification-channel server functions. Channels belong to the signed-in User
 * and follow them across teams. Secrets are never returned to the client.
 *
 * Per-type behavior (validate / hint / send) lives in `CHANNELS` (gateway/notify);
 * this module just wires it to auth + storage.
 */
import { createServerFn } from '@tanstack/react-start'

import * as store from '../db/store.js'
import type { ChannelConfig, ChannelType, NotificationChannel } from '../db/schema.js'
import { requestScope } from '../auth.js'
import { ensureServer } from './boot.js'
import { CHANNELS, fetchSlackChannels } from '../gateway/notify.js'
import type { ChannelSummary, SlackChannelSummary } from '../types'

function toSummary(c: NotificationChannel, active: boolean): ChannelSummary {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    hint: CHANNELS[c.type]?.hint(c.config) ?? '—',
    active,
  }
}

/** Resolve a channel and authorize it by its canonical User owner. */
async function ownedChannel(id: string): Promise<NotificationChannel | undefined> {
  const ch = await store.getChannel(id)
  if (!ch) return undefined
  const { userId } = await requestScope()
  if (!userId || ch.userId !== userId) return undefined
  return ch
}

/** GET — this User's destinations, newest/active first. */
export const listChannels = createServerFn({ method: 'GET' }).handler(async (): Promise<ChannelSummary[]> => {
  await ensureServer()
  const { userId } = await requestScope()
  if (!userId) return []
  return (await store.listChannels(userId)).map((channel, index) => toSummary(channel, index === 0))
})

/** POST — create a personal destination. Session identity is the sole owner. */
export const createChannel = createServerFn({ method: 'POST' })
  .validator((d: { type: ChannelType; name: string; config: ChannelConfig }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    await ensureServer()
    const { userId } = await requestScope()
    if (!userId) return { ok: false, error: 'not signed in' }
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
    // Per-type destination validation (e.g. the Feishu webhook allowlist) — reject
    // an off-allowlist / non-HTTPS target before it is ever stored or fired.
    const invalid = kind.validate?.(config)
    if (invalid) return { ok: false, error: invalid }
    const ch = await store.createChannel({ userId, type: data.type, name, config })
    return { ok: true, id: ch.id }
  })

/** POST — delete a channel (loops pointing at it fall back to dashboard-only). */
export const deleteChannel = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    await ensureServer()
    if (!(await ownedChannel(id))) return { ok: false, error: 'channel not found' }
    return { ok: await store.deleteChannel(id) }
  })

/** POST — list the channels a pasted Slack bot token can see, for the Slack
 *  add-channel picker (`NotificationsModal`). Takes the raw token straight from
 *  the add form, not a stored channel — the channel doesn't exist yet at this
 *  point, so there is no team-owned row to scope this to. Thin passthrough to
 *  `fetchSlackChannels` (gateway/notify), which never throws / never logs the
 *  token. */
export const listSlackChannels = createServerFn({ method: 'POST' })
  .validator((d: { token: string }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; channels?: SlackChannelSummary[]; error?: string }> => {
    await ensureServer()
    const { userId } = await requestScope()
    if (!userId) return { ok: false, error: 'not signed in' }
    const token = data.token?.trim()
    if (!token) return { ok: false, error: 'token required' }
    return fetchSlackChannels(token)
  })

/** POST — send a test message through a saved channel (verifies the secrets). */
export const testChannel = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<{ ok: boolean; error?: string }> => {
    await ensureServer()
    const ch = await ownedChannel(id)
    if (!ch) return { ok: false, error: 'channel not found' }
    return CHANNELS[ch.type].send(ch.config, ch.name, 'Loopany test message — this channel is wired up. ✓')
  })
