import { useCallback, useEffect, useState } from 'react'
import { Modal, ModalHead, ModalSection } from './Modal'
import { btn, btnDanger, ErrorBanner } from './ui'
import { listChannels, deleteChannel, testChannel } from '../server/notifyFns'
import { ChannelAddForm, typeLabel } from './ChannelAddForm'
import type { ChannelSummary } from '../types'

/**
 * The dashboard's notification-channel manager. The add-a-channel binder is the
 * shared `ChannelAddForm` (also used by the onboarding "Get notified" step), so the
 * two binding surfaces can never drift. This modal owns the list + per-row test/delete.
 */
export function NotificationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [channels, setChannels] = useState<ChannelSummary[]>([])
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
      return
    }
    void load()
  }, [open, load])

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
      {channels.length === 0 && <div className="py-3 text-body text-secondary">No channels yet.</div>}
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

      <div className="mt-6">
        <ChannelAddForm onCreated={() => load()} />
      </div>
    </Modal>
  )
}
