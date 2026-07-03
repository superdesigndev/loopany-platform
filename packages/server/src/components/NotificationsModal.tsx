import { useCallback, useEffect, useState } from 'react'
import { Modal, ModalHead, ModalSection } from './Modal'
import { btn, btnDanger, btnPrimary, ErrorBanner, inputCls, labelCls } from './ui'
import { listChannels, createChannel, deleteChannel, testChannel } from '../server/notifyFns'
import type { ChannelConfig, ChannelType } from '../db/schema'
import type { ChannelSummary } from '../types'

/** Per-type add-form descriptor — one entry adds a channel type to the picker. */
type FormField = { key: keyof ChannelConfig; label: string; ph: string; optional?: boolean }
const FORMS: Record<string, { label: string; help: string; fields: FormField[] }> = {
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
}

const ADDABLE: ChannelType[] = ['telegram', 'feishu']

function typeLabel(type: string): string {
  return FORMS[type]?.label ?? (type === 'slack' ? 'Slack' : type)
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
  }

  const spec = adding ? FORMS[adding] : null
  const filled = !!name.trim() && !!spec && spec.fields.every((f) => f.optional || fields[f.key]?.trim())

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
          <label className={labelCls}>Name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My alerts" />
          {spec.fields.map((f) => (
            <div key={f.key}>
              <label className={labelCls}>{f.label}</label>
              <input
                className={`${inputCls} font-mono`}
                value={fields[f.key] ?? ''}
                onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
                placeholder={f.ph}
              />
            </div>
          ))}
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
