import { useState } from 'react'
import { btn, btnPrimary, inputCls, labelCls } from './ui'
import { createChannel, listSlackChannels } from '../server/notifyFns'
import type { ChannelConfig, ChannelType } from '../db/schema'
import type { SlackChannelSummary } from '../types'

/**
 * The reusable "add a notification channel" binder — the ONE binding surface,
 * shared by the dashboard's `NotificationsModal` and the onboarding wizard's
 * "Get notified" step, so the two can never drift. It owns the type picker, the
 * per-type fields (declarative `FORMS`), the stateful Slack load-then-pick flow,
 * and the `createChannel` write; it hands the created channel back via `onCreated`.
 *
 * Secrets stay client→server only (the same `createChannel`/`listSlackChannels`
 * server fns as before); nothing new is invented here.
 */

/** Slack app-manifest prefill link: opens api.slack.com's "Create an app" dialog
 *  with the bot user + scopes already configured. */
const SLACK_MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify({
    display_information: { name: 'Loopany', description: 'Run notifications from your Loopany agent loops' },
    features: { bot_user: { display_name: 'Loopany' } },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'chat:write.public',
          'channels:read',
          'groups:read',
          'im:read',
          'mpim:read',
          'users:read',
          'files:read',
          'files:write',
          'reactions:read',
          'reactions:write',
          'channels:history',
          'groups:history',
          'im:history',
          'mpim:history',
          'app_mentions:read',
        ],
      },
    },
  }),
)}`

type FormField = {
  key: keyof ChannelConfig
  label: string
  ph: string
  optional?: boolean
  help?: string[]
  requires?: keyof ChannelConfig
}

export const FORMS: Record<string, { label: string; help: string; fields: FormField[]; action?: { label: string; href: string } }> = {
  telegram: {
    label: 'Telegram',
    help: 'Create a bot with @BotFather, then DM it once so it can message you.',
    fields: [
      { key: 'botToken', label: 'Bot token', ph: '123456:ABC-DEF…' },
      { key: 'chatId', label: 'Chat id', ph: 'e.g. 87654321 (message @userinfobot to get yours)' },
    ],
  },
  feishu: {
    label: 'Feishu',
    help: 'In a Feishu group: 设置 → 机器人 → 添加自定义机器人. Pick a security setting (signing recommended; paste the secret below if you enabled 签名校验).',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', ph: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
      { key: 'secret', label: 'Signing secret (optional)', ph: 'only if you enabled 签名校验', optional: true },
    ],
  },
  slack: {
    label: 'Slack',
    help: 'Public channels work right away; for a private channel, /invite the bot first.',
    action: { label: 'Create the Slack app (pre-filled)', href: SLACK_MANIFEST_URL },
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        ph: 'xoxb-…',
        help: [
          'Click "Create the Slack app" above — it opens Slack with everything pre-configured. Pick your workspace and hit Create.',
          'On the app page, click "Install to Workspace" and allow it.',
          'Open OAuth & Permissions and copy the Bot User OAuth Token (xoxb-…) — not the App-Level Token (xapp-…).',
        ],
      },
      { key: 'channel', label: 'Channel', ph: 'C0123456789 or #alerts', requires: 'token' },
    ],
  },
}

export const ADDABLE: ChannelType[] = ['slack', 'telegram', 'feishu']

export function typeLabel(type: string): string {
  return FORMS[type]?.label ?? type
}

export function ChannelAddForm({
  onCreated,
  addLabelPrefix = '+ Add ',
}: {
  onCreated: (channel: { id: string; name: string; type: ChannelType }) => void | Promise<void>
  /** The "+ Add X" button prefix (the wizard uses a plainer "X"). */
  addLabelPrefix?: string
}) {
  const [adding, setAdding] = useState<ChannelType | null>(null)
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Slack-only load-then-pick channel picker.
  const [slackChannels, setSlackChannels] = useState<SlackChannelSummary[] | null>(null)
  const [slackLoading, setSlackLoading] = useState(false)
  const [slackErr, setSlackErr] = useState<string | null>(null)
  const [slackManual, setSlackManual] = useState(true)

  function startAdd(type: ChannelType) {
    setName('')
    setFields({})
    setErr(null)
    setAdding(type)
    setSlackChannels(null)
    setSlackLoading(false)
    setSlackErr(null)
    setSlackManual(true)
  }

  const spec = adding ? FORMS[adding] : null
  const filled = !!name.trim() && !!spec && spec.fields.every((f) => f.optional || fields[f.key]?.trim())

  async function loadSlackChannels() {
    const token = fields.token?.trim()
    if (!token) return
    setSlackLoading(true)
    setSlackErr(null)
    try {
      const r = await listSlackChannels({ data: { token } })
      if (!r.ok) {
        setSlackErr(r.error ?? 'Could not load channels.')
        setSlackChannels(null)
        return
      }
      setSlackChannels(r.channels ?? [])
      setSlackManual(false)
    } finally {
      setSlackLoading(false)
    }
  }

  async function add() {
    if (!adding || !spec) return
    setErr(null)
    setBusy(true)
    try {
      const config: ChannelConfig = Object.fromEntries(
        spec.fields.filter((f) => fields[f.key]?.trim()).map((f) => [f.key, fields[f.key]!.trim()]),
      )
      const r = await createChannel({ data: { type: adding, name: name.trim(), config } })
      if (!r.ok || !r.id) {
        setErr(r.error ?? 'Could not save this channel.')
        return
      }
      const created = { id: r.id, name: name.trim(), type: adding }
      setAdding(null)
      await onCreated(created)
    } finally {
      setBusy(false)
    }
  }

  if (!adding || !spec) {
    return (
      <div className="flex flex-wrap gap-2">
        {ADDABLE.map((type) => (
          <button key={type} className={btnPrimary} onClick={() => startAdd(type)}>
            {addLabelPrefix}
            {typeLabel(type)}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="rounded-control border border-hairline bg-raised px-4 py-3">
      <div className="text-label font-semibold text-display">New {spec.label} channel</div>
      {err && <div className="mt-2 text-label text-accent">{err}</div>}
      {spec.action && (
        <a className={`${btn} mb-1 mt-2 inline-flex`} href={spec.action.href} target="_blank" rel="noreferrer">
          {spec.action.label} ↗
        </a>
      )}
      <label className={labelCls} htmlFor="channel-add-name">
        Name
      </label>
      <input
        id="channel-add-name"
        className={inputCls}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. My alerts"
      />
      {spec.fields.map((f) => {
        if (f.requires && !fields[f.requires]?.trim()) return null
        const isSlackChannel = adding === 'slack' && f.key === 'channel'
        const picked = isSlackChannel ? slackChannels?.find((c) => c.id === fields.channel) : undefined
        return (
          <div key={f.key}>
            <label className={labelCls}>{f.label}</label>
            {isSlackChannel && !slackManual && slackChannels ? (
              <>
                <select
                  className={inputCls}
                  value={fields.channel ?? ''}
                  onChange={(e) => setFields((s) => ({ ...s, channel: e.target.value }))}
                >
                  <option value="">— pick a channel —</option>
                  {slackChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.isPrivate ? '🔒 ' : ''}#{c.name}
                      {!c.isMember && c.isPrivate ? ' — bot not in this channel' : ''}
                    </option>
                  ))}
                </select>
                {picked?.isPrivate && !picked.isMember && (
                  <div className="mt-1 text-label text-secondary">invite the bot with /invite before testing</div>
                )}
                <button type="button" className={`${btn} mt-1`} onClick={() => setSlackManual(true)}>
                  type it manually
                </button>
              </>
            ) : (
              <>
                <input
                  className={`${inputCls} font-mono`}
                  value={fields[f.key] ?? ''}
                  onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.ph}
                />
                {isSlackChannel && fields.token?.trim() && (
                  <div className="mt-1 flex items-center gap-2">
                    <button type="button" className={btn} disabled={slackLoading} onClick={() => void loadSlackChannels()}>
                      {slackLoading ? 'Loading…' : 'Load channels'}
                    </button>
                    {slackChannels && (
                      <button type="button" className={btn} onClick={() => setSlackManual(false)}>
                        pick from list
                      </button>
                    )}
                  </div>
                )}
                {isSlackChannel && slackErr && <div className="mt-1 text-label text-accent">{slackErr}</div>}
              </>
            )}
            {f.help && (
              <ol className="mb-2 mt-1.5 list-decimal space-y-1 pl-5 text-label text-secondary">
                {f.help.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
          </div>
        )
      })}
      <div className="mt-1 text-label text-secondary">{spec.help}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn} onClick={() => setAdding(null)}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={busy || !filled} onClick={() => void add()}>
          {busy ? 'Saving…' : 'Save channel'}
        </button>
      </div>
    </div>
  )
}
