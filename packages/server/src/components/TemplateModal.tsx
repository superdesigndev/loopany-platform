import { useEffect, useRef, useState } from 'react'
import type { CodingAgent, TemplateInfo, TemplateSlot } from '../types'
import { claimStatus, getConfig, mintClaim } from '../server/loopApi'
import { Modal, ModalHead } from './Modal'
import { btn, btnPrimary, btnSm, inputCls, labelCls } from './ui'

// How long to wait on a silent paste before nudging the user to check things.
const SLOW_WAIT_MS = 100_000

const AGENT_LABEL: Record<CodingAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

// The one human-readable instruction the template snippet carries. `/api/template/<name>`
// serves the setup doc (the recipe the agent follows); the snippet just points at it —
// mirrors ComposeModal's `/api/bootstrap` bootstrap line, but for a pre-baked template.
const instructionFor = (origin: string, name: string) =>
  `Fetch ${origin}/api/template/${name} and help me set it up.`

/**
 * Template market entry — sits beside "New Loop" on the dashboard. Three light steps:
 *   1. `select`  — pick a template (cards: label / desc / tags).
 *   2. `slots`   — fill the OPTIONAL slots (all defaulted; nothing required).
 *   3. `snippet` — mint a claim (same connect-key machinery as ComposeModal) and show
 *                  the copyable one-liner + config + chosen slot values, then wait for
 *                  the agent to create the loop.
 * The blank-loop ComposeModal is untouched; this is the template-only flow.
 */
export function TemplateModal({
  open,
  templates,
  onClose,
  onCreated,
}: {
  open: boolean
  templates: TemplateInfo[]
  onClose: () => void
  onCreated: () => void
}) {
  const [picked, setPicked] = useState<TemplateInfo | null>(null)
  const [step, setStep] = useState<'select' | 'slots' | 'snippet'>('select')
  // Slot values keyed by slot name, seeded from each slot's default.
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  const [token, setToken] = useState<string | null>(null)
  const [config, setConfig] = useState<{ loopanyCli: string; customCli: boolean } | null>(null)
  const [created, setCreated] = useState<{ id: string; name: string; agent: CodingAgent } | null>(null)
  const [copied, setCopied] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  // Reset to the chooser each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setPicked(null)
    setStep('select')
    setSlotValues({})
    setToken(null)
    setConfig(null)
    setCreated(null)
    setCopied(false)
    setSlow(false)
    setError(null)
  }, [open])

  // Mint a claim + load config once the user lands on the snippet step.
  useEffect(() => {
    if (!open || step !== 'snippet' || token) return
    void getConfig().then(setConfig)
    void mintClaim()
      .then((r) => ('token' in r ? setToken(r.token) : setError(r.error)))
      .catch(() => setError('could not mint a connect key'))
  }, [open, step, token])

  // Wait on the claim: the agent POSTs the loop with this token as `claim`.
  useEffect(() => {
    if (!open || step !== 'snippet' || created || !token) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      void claimStatus({ data: token })
        .then((s) => {
          if (s.done && s.id) {
            if (pollRef.current) clearInterval(pollRef.current)
            setCreated({ id: s.id, name: s.name ?? 'loop', agent: s.agent ?? 'claude-code' })
            onCreatedRef.current()
          }
        })
        .catch(() => {})
    }, 2500)
    const slowTimer = setTimeout(() => setSlow(true), SLOW_WAIT_MS)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearTimeout(slowTimer)
    }
  }, [open, step, created, token])

  const instruction = picked ? instructionFor(origin, picked.name) : ''
  // Fixed machine config + the chosen slot values as plain `name: value` lines. A
  // slot with an empty value is dropped (all are optional).
  const configLines = token
    ? [
        `server-url: ${origin}`,
        `connect-key: ${token}`,
        ...(config?.customCli ? [`loopany-cli: ${config.loopanyCli}`] : []),
        ...(picked?.slots ?? [])
          .map((s) => [s.name, (slotValues[s.name] ?? s.default ?? '').trim()] as const)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`),
      ].join('\n')
    : ''
  const snippet = token ? [instruction, '', configLines].join('\n') : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('could not copy — select the text and copy manually')
    }
  }

  function choose(t: TemplateInfo) {
    setPicked(t)
    setSlotValues(Object.fromEntries((t.slots ?? []).map((s) => [s.name, s.default ?? ''])))
    // Skip straight to the snippet when a template has no slots to fill.
    setStep((t.slots ?? []).length ? 'slots' : 'snippet')
  }

  // Confirmation — the agent created the loop.
  if (created) {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title="Loop created" sub={`${AGENT_LABEL[created.agent]} set it up from the template.`} />
        <div className="mt-5 rounded-xl border border-wire bg-surface p-5">
          <div className="text-[17px] font-medium text-display">✓ {created.name}</div>
          <div className="mt-1 text-[13px] text-secondary">It’s scheduled now and will run on the machine.</div>
        </div>
        <div className="mt-4">
          <button className={btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  // Step 1 — template cards.
  if (step === 'select') {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title="Templates" sub="Start from a pre-baked loop instead of a blank one." />
        {templates.length ? (
          <div className="mt-5 grid gap-3">
            {templates.map((t) => (
              <button
                key={t.name}
                onClick={() => choose(t)}
                className="min-w-0 cursor-pointer rounded-xl border border-wire bg-surface p-4 text-left transition-colors hover:border-display hover:bg-raised"
              >
                <div className="text-[15px] font-medium text-display">{t.label}</div>
                <div className="mt-1.5 text-[13px] leading-snug text-secondary">{t.desc}</div>
                {t.tags?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {t.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-hairline px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-secondary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-wire bg-surface p-5 text-[13px] text-secondary">
            No templates available yet.
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <button className={btn} onClick={onClose}>
            Cancel
          </button>
        </div>
      </Modal>
    )
  }

  // Step 2 — optional slots (nothing required; all defaulted).
  if (step === 'slots' && picked) {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title={picked.label} sub="Adjust the options, or keep the defaults." />
        <div className="mt-5 grid gap-3">
          {picked.slots.map((s: TemplateSlot) => (
            <div key={s.name}>
              <label className={labelCls} htmlFor={`slot-${s.name}`}>
                {s.prompt}
              </label>
              <input
                id={`slot-${s.name}`}
                type={s.kind === 'cron' ? 'time' : 'text'}
                className={inputCls}
                value={slotValues[s.name] ?? ''}
                onChange={(e) => setSlotValues((v) => ({ ...v, [s.name]: e.target.value }))}
                placeholder={s.default}
              />
            </div>
          ))}
        </div>
        <div className="mt-6 flex justify-between gap-2.5">
          <button className={btn} onClick={() => setStep('select')}>
            Back
          </button>
          <button className={btnPrimary} onClick={() => setStep('snippet')}>
            Continue
          </button>
        </div>
      </Modal>
    )
  }

  // Step 3 — snippet + connect-key, then wait for the agent.
  const wait = slow
    ? {
        dot: 'bg-[color:var(--color-secondary)]',
        text: 'Still waiting — check your coding agent is running in the right project, then paste again.',
      }
    : { dot: 'animate-pulse bg-[color:var(--color-display)]', text: 'Waiting for your coding agent…' }

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead title={picked?.label ?? 'Template'} sub="Paste this into your coding agent, in the project you want to guard." />
      <div className="mt-5 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-[11px] tracking-[0.08em] text-display">PASTE TO SET IT UP</h3>
          {snippet && (
            <button className={btnSm} onClick={() => void copy()}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}
        </div>
        <div className="mt-2 overflow-hidden rounded-lg border border-wire bg-raised p-3 font-mono text-[12px] text-primary">
          <p className="leading-relaxed">{instruction}</p>
          {configLines ? (
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-hairline pt-3 leading-relaxed text-secondary">
              {configLines}
            </pre>
          ) : (
            <div className="mt-3 border-t border-hairline pt-3 leading-relaxed text-secondary">
              minting a connect key…
            </div>
          )}
        </div>
        <p className="mt-2 text-[13px] leading-snug text-secondary">
          Your agent will verify the project, then build and register the loop automatically.
        </p>
      </div>

      {error && <div className="mt-3 font-mono text-[13px] text-accent">[ ERROR ] {error}</div>}

      <div className="mt-6 flex items-start gap-3">
        <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${wait.dot}`} />
        <span className="font-mono text-[12px] leading-relaxed tracking-[0.02em] text-secondary">
          {wait.text}
        </span>
        <button
          className={`${btn} ml-auto shrink-0`}
          onClick={() => setStep(picked && picked.slots.length ? 'slots' : 'select')}
        >
          Back
        </button>
      </div>
    </Modal>
  )
}
