import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, ModalHead, ModalSection } from './Modal'
import { btn, btnDanger, btnPrimary, ErrorBanner, inputCls, labelCls } from './ui'
import { rel } from '../lib/format'
import {
  listMachines,
  createMachine,
  machineStatus,
  finalizeMachine,
  deleteMachine,
} from '../server/machineFns'
import { getConfig } from '../server/loopApi'
import { isOutdated } from '../lib/semver'
import type { MachineSummary } from '../types'

/** The daemon connect command (origin known client-side; CLI prefix from server
 *  config). Uses the MANAGED `up` form: it spawns a detached daemon that survives
 *  the terminal (the old bare-flags foreground form died with the shell) and
 *  waits for a readiness probe. The device token rides as `--connect-key` — `up`
 *  adopts it as this machine's stored identity on first run. */
function connectCmd(token: string, cli: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3000'
  return `${cli} up --server-url ${origin} --connect-key ${token}`
}

/** The one-liner that updates an outdated daemon (the invoked CLI is the new
 *  version; `update` hands the running daemon over). Same for every machine. */
const UPDATE_CMD = 'npx @crewlet/loopany@latest update'

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={btn}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'Copied ✓' : 'Copy'}
    </button>
  )
}

type Pending = { id: string; token: string }

export function MachinesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [machines, setMachines] = useState<MachineSummary[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [status, setStatus] = useState<MachineSummary | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [cliCmd, setCliCmd] = useState('npx @crewlet/loopany@latest')

  useEffect(() => {
    if (open) void getConfig().then((c) => setCliCmd(c.loopanyCli))
    else setDelErr(null) // don't carry a stale delete error into the next open
  }, [open])

  const load = useCallback(async () => {
    try {
      setMachines(await listMachines())
    } catch {
      /* ignore */
    }
  }, [])

  // Poll the machine list (online dots) while idle.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!open || pending) return
    void load()
    const t = setInterval(() => openRef.current && void load(), 3000)
    return () => clearInterval(t)
  }, [open, pending, load])

  // Poll the pending machine's status while the connect dialog is open.
  useEffect(() => {
    if (!pending) return
    let active = true
    const tick = async () => {
      // A transient server hiccup during the connect-wait must not surface as an
      // unhandled rejection (or wipe the connected state) — skip that tick.
      const s = await machineStatus({ data: pending.id }).catch(() => undefined)
      if (!active || s === undefined) return
      setStatus(s)
      if (s?.online && s.hostname) setName((n) => n || s.hostname || '')
    }
    void tick()
    const t = setInterval(tick, 2000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [pending])

  async function startConnect() {
    setBusy(true)
    setDelErr(null)
    try {
      const r = await createMachine()
      if ('error' in r) {
        setDelErr(r.error)
        return
      }
      setStatus(null)
      setName('')
      setPending(r)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (pending) await deleteMachine({ data: pending.id })
    setPending(null)
    setStatus(null)
    await load()
  }

  async function done() {
    if (pending && name.trim()) await finalizeMachine({ data: { id: pending.id, name: name.trim() } })
    setPending(null)
    setStatus(null)
    await load()
  }

  async function remove(id: string) {
    setDelErr(null)
    const r = await deleteMachine({ data: id })
    if (!r.ok) {
      setDelErr(r.error ?? 'Could not delete this machine.')
      await load() // refresh counts in case they changed under us
      return
    }
    await load()
  }

  const connected = !!status?.online

  // ---- Connect dialog (two acts) ----
  if (pending) {
    return (
      <Modal open={open} onClose={cancel}>
        <ModalHead title={connected ? 'Computer connected' : 'Connect computer'} />
        {!connected ? (
          <>
            <div className="mt-5 text-body font-medium text-display">
              Run this command on your computer to connect:
            </div>
            <div className="mt-2 flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-display p-4 font-mono text-label leading-relaxed text-paper">
                {connectCmd(pending.token, cliCmd)}
              </pre>
              <CopyButton text={connectCmd(pending.token, cliCmd)} />
            </div>
            <div className="mt-4 flex items-center gap-2.5 rounded-control border border-hairline bg-warn-soft px-4 py-3">
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-rubik-orange" />
              <span className="text-[14px] font-medium text-warn">Waiting for computer to connect…</span>
            </div>
          </>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-3 rounded-control border border-hairline bg-success-soft px-4 py-3">
              <span className="text-xl text-success">✓</span>
              <div>
                <div className="text-[15px] font-medium text-display">Computer connected successfully!</div>
                <div className="text-label text-secondary">
                  {status?.hostname ?? 'unknown'}
                  {status?.platform ? ` - ${status.platform} ${status.arch ?? ''}` : ''}
                </div>
              </div>
            </div>
            <div className="mt-5">
              <label className={labelCls}>Computer name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={status?.hostname ?? 'My computer'} />
              <div className="mt-1 text-label text-secondary">A friendly name for this computer.</div>
            </div>
          </>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button className={btn} onClick={() => void cancel()}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={!connected || !name.trim()} onClick={() => void done()}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  // ---- Machine list ----
  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead title="Machines" sub="Each machine runs a loopany daemon that executes your loops via your local coding agent." />

      <ModalSection>Connected machines</ModalSection>
      {delErr && <ErrorBanner message={delErr} onDismiss={() => setDelErr(null)} />}
      {machines.length === 0 && <div className="py-3 text-body text-secondary">No machines yet.</div>}
      <ul className="flex flex-col gap-2">
        {machines.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 rounded-control border border-hairline bg-surface px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${m.online ? 'bg-rubik-green' : 'bg-disabled'}`}
                  title={m.online ? 'online' : 'offline'}
                />
                <span className="text-[15px] font-medium text-display">{m.name}</span>
                <span className="text-label text-secondary">
                  {m.online ? 'online' : m.lastSeen ? `seen ${rel(m.lastSeen)}` : 'offline'}
                  {m.platform ? ` · ${m.platform} ${m.arch ?? ''}` : ''}
                  {m.loopCount > 0 ? ` · ${m.loopCount} loop${m.loopCount === 1 ? '' : 's'}` : ''}
                </span>
              </div>
              <button
                className={btnDanger}
                disabled={m.loopCount > 0}
                title={m.loopCount > 0 ? 'Delete its loops first' : undefined}
                onClick={() => void remove(m.id)}
              >
                Delete
              </button>
            </div>
            {/* Offline → offer the exact command to bring this machine back (same token).
                The token is serialized only to the machine's OWNER (never a teammate),
                so a null token quietly notes where the command lives instead. */}
            {!m.online && !m.token && (
              <div className="text-label text-secondary">Reconnect command available from the machine owner's account.</div>
            )}
            {!m.online && m.token && (
              <details>
                <summary className="cursor-pointer select-none text-label font-medium text-secondary marker:content-[''] hover:text-display">
                  Reconnect command
                </summary>
                <div className="mt-2 flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-display p-3 font-mono text-caption leading-relaxed text-paper">
                    {connectCmd(m.token, cliCmd)}
                  </pre>
                  <CopyButton text={connectCmd(m.token, cliCmd)} />
                </div>
              </details>
            )}
            {/* Outdated-daemon hint: only when both versions are known and the
                daemon is genuinely behind (never on unknown/equal/newer). */}
            {isOutdated(m.daemonVersion, m.latestDaemonVersion) && (
              <div className="flex flex-col gap-1.5">
                <div className="text-label text-secondary">
                  daemon v{m.daemonVersion} · update available (v{m.latestDaemonVersion})
                </div>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-display p-3 font-mono text-caption leading-relaxed text-paper">
                    {UPDATE_CMD}
                  </pre>
                  <CopyButton text={UPDATE_CMD} />
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-6">
        <button className={btnPrimary} disabled={busy} onClick={() => void startConnect()}>
          {busy ? 'Preparing…' : '+ Connect computer'}
        </button>
      </div>
    </Modal>
  )
}
