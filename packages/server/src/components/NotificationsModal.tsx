import { useCallback, useEffect, useState } from 'react'
import { Modal, ModalHead, ModalSection } from './Modal'
import { btn, btnDanger, btnPrimary, ErrorBanner, inputCls, labelCls } from './ui'
import { listChannels, createChannel, deleteChannel, testChannel, listSlackChannels } from '../server/notifyFns'
import type { ChannelConfig, ChannelType } from '../db/schema'
import type { ChannelSummary, SlackChannelSummary } from '../types'

/**
 * Slack app-manifest prefill link: opens api.slack.com's "Create an app" dialog
 * with the bot user + scopes already configured, so the user only picks a
 * workspace, clicks Create → Install, and copies the token.
 */
const SLACK_MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify({
    display_information: { name: 'Loopany', description: 'Run notifications from your Loopany agent loops' },
    features: { bot_user: { display_name: 'Loopany' } },
    // Scoped for the planned bidirectional gateway (reading channels/history/users,
    // reacting, exchanging files), not just today's one-way push — so a channel
    // created now won't need re-authorizing later. chat:write.public is the one
    // that matters immediately: it lets the bot post to any PUBLIC channel without
    // an /invite first (private channels still need one).
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

/** Per-type add-form descriptor — one entry adds a channel type to the picker.
 *  A field with `help` renders numbered how-to steps under its input; one with
 *  `requires` stays hidden until that other config key is filled in. */
type FormField = {
  key: keyof ChannelConfig
  label: string
  ph: string
  optional?: boolean
  help?: string[]
  requires?: keyof ChannelConfig
}
const FORMS: Record<string, { label: string; help: string; fields: FormField[]; action?: { label: string; href: string } }> = {
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

const ADDABLE: ChannelType[] = ['telegram', 'feishu', 'slack']

function typeLabel(type: string): string {
  return FORMS[type]?.label ?? type
}

export function NotificationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [channels, setChannels] = useState<ChannelSummary[]>([])
  // The type being added, or null when not in the add form.
  const [adding, setAdding] = useState<ChannelType | null>(null)
  const [name, setName] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Per-row transient test result (id → 'sending' | 'ok' | error text).
  const [test, setTest] = useState<Record<string, string>>({})

  // Slack-only channel picker state (lives here rather than the declarative FORMS
  // descriptor — it's a stateful load-then-pick flow specific to one channel type).
  const [slackChannels, setSlackChannels] = useState<SlackChannelSummary[] | null>(null)
  const [slackLoading, setSlackLoading] = useState(false)
  const [slackErr, setSlackErr] = useState<string | null>(null)
  // true = plain text entry (default + the "type it manually" escape hatch);
  // false = the loaded <select> is showing.
  const [slackManual, setSlackManual] = useState(true)

  const load = useCallback(async () => {
    try {
      setChannels(await listChannels())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setErr(null)
      setAdding(null)
      return
    }
    void load()
  }, [open, load])

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
      if (!r.ok) {
        setErr(r.error ?? 'Could not save this channel.')
        return
      }
      setAdding(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setErr(null)
    const r = await deleteChannel({ data: id })
    if (!r.ok) {
      setErr(r.error ?? 'Could not delete this channel.')
      return
    }
    await load()
  }

  async function runTest(id: string) {
    setTest((t) => ({ ...t, [id]: 'sending' }))
    const r = await testChannel({ data: id })
    setTest((t) => ({ ...t, [id]: r.ok ? 'ok' : r.error || 'failed' }))
    setTimeout(() => setTest((t) => ({ ...t, [id]: '' })), 4000)
  }

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead
        title="Notifications"
        sub="Push channels for this team. A loop routes its run messages to the channel you pick on it."
      />

      {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} className="mb-2 mt-3" />}

      <ModalSection>Channels</ModalSection>
      {channels.length === 0 && !adding && <div className="py-3 text-body text-secondary">No channels yet.</div>}
      <ul className="flex flex-col gap-2">
        {channels.map((c) => {
          const t = test[c.id]
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 rounded-control border border-hairline bg-surface px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="text-[15px] font-medium text-display">{c.name}</span>
                <span className="text-label text-secondary">
                  {typeLabel(c.type)} · {c.hint}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {t && t !== 'sending' && (
                  <span
                    className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-caption font-medium ${t === 'ok' ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent'}`}
                    title={t === 'ok' ? undefined : t}
                  >
                    {t === 'ok' ? 'Sent ✓' : 'Failed'}
                  </span>
                )}
                <button className={btn} disabled={t === 'sending'} onClick={() => void runTest(c.id)}>
                  {t === 'sending' ? 'Sending…' : 'Test'}
                </button>
                <button className={btnDanger} onClick={() => void remove(c.id)}>
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {adding && spec ? (
        <div className="mt-4 rounded-control border border-hairline bg-raised px-4 py-3">
          <ModalSection>New {spec.label} channel</ModalSection>
          {spec.action && (
            <a className={`${btn} mb-1 inline-flex`} href={spec.action.href} target="_blank" rel="noreferrer">
              {spec.action.label} ↗
            </a>
          )}
          <label className={labelCls} htmlFor="notif-channel-name">Name</label>
          <input id="notif-channel-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My alerts" />
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
      ) : (
        <div className="mt-6 flex gap-2">
          {ADDABLE.map((type) => (
            <button key={type} className={btnPrimary} onClick={() => startAdd(type)}>
              + Add {FORMS[type]?.label ?? type}
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
