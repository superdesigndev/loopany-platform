import { useEffect, useRef, useState } from 'react'
import { claimStatus, getConfig, mintClaim } from '../server/loopApi'
import { Modal, ModalHead } from './Modal'
import { btn, btnPrimary, btnSm } from './ui'

// How long to wait on a silent paste before nudging the user to check things.
const SLOW_WAIT_MS = 100_000

// The two click-to-edit slots in the capture instruction. Defaults double as the
// placeholder (shown when a slot is cleared) AND the fallback baked into the
// copied text, so the instruction never reads broken even with an empty field.
const SCHEDULE_DEFAULT = 'every day at 9am'
const ACTION_DEFAULT = 'write an article'

/**
 * An inline, click-to-edit chip that flows inside the instruction prose. It is an
 * UNCONTROLLED contentEditable span (managed via ref) so React re-renders never
 * reset the caret; the latest text is mirrored up via `onChange` purely to
 * recompose the copied snippet. Single logical line (Enter commits/blurs, pasted
 * newlines collapse to spaces) but it still wraps visually like any word. We only
 * ever read `textContent` — never set user content as HTML — so there's no XSS
 * surface. When emptied, CSS `:empty::before` shows `placeholder` muted.
 */
function EditableChip({
  initialValue,
  placeholder,
  ariaLabel,
  onChange,
}: {
  initialValue: string
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  const ref = useRef<HTMLSpanElement>(null)

  // Seed the field once on mount (uncontrolled — never re-write content on
  // re-render, which would fight the cursor). `initialValue` is the live state
  // value, so edits survive a Back→Continue round-trip without React re-setting it.
  // Mount-only: intentionally not keyed on initialValue — re-seeding on every
  // render would clobber the caret. `initialValue` is the live state at mount.
  useEffect(() => {
    if (ref.current) ref.current.textContent = initialValue
  }, [])

  return (
    <span
      ref={ref}
      role="textbox"
      aria-label={ariaLabel}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      className="lp-chip"
      onInput={(e) => {
        const el = e.currentTarget
        const text = el.textContent ?? ''
        // Collapse a stray <br> the browser may leave behind so :empty matches
        // and the placeholder shows once the field is truly cleared.
        if (text === '' && el.innerHTML !== '') el.innerHTML = ''
        onChange(text)
      }}
      onKeyDown={(e) => {
        // Enter commits (blur) instead of inserting a newline — single-line field.
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      onPaste={(e) => {
        // Plain text only — strip rich HTML and flatten any newlines to spaces.
        e.preventDefault()
        const text = (e.clipboardData.getData('text/plain') || '').replace(/[\r\n]+/g, ' ')
        document.execCommand('insertText', false, text)
      }}
    />
  )
}

/**
 * New loop = capture-from-Claude-Code (paste-forward, no machine picker). The web
 * mints a claim token, shows ONE instruction block, and waits. The user pastes it
 * into their own Claude Code session (where they just did the task); Claude
 * follows /api/skill — ensures a daemon is running (the token authorizes a new
 * machine, or the machine's stored token reuses an existing one) and POSTs the
 * loop to /api/machine/loop with this token as `claim`. We poll the claim until
 * the loop lands, then close. No machine selection: the binding is decided on the
 * machine, the claim just correlates the result back to this dialog.
 */
export function ComposeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  // Step 1 picks where the loop runs. null = chooser screen; 'local' advances to
  // the capture-from-Claude-Code paste flow. 'hosted' (run on Loopany) is not yet
  // available — the tile is disabled, so the value never lands here.
  const [host, setHost] = useState<'local' | null>(null)
  const [picked, setPicked] = useState<'local'>('local') // step-1 selection (local pre-selected; hosted is disabled)
  const [token, setToken] = useState<string | null>(null)
  const [config, setConfig] = useState<{ loopanyCli: string; customCli: boolean } | null>(null)
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The two editable slots in the instruction line. Held as state so editing a
  // chip changes exactly what Copy puts on the clipboard. Empty falls back to
  // the default so the composed text is never broken.
  const [schedule, setSchedule] = useState(SCHEDULE_DEFAULT)
  const [action, setAction] = useState(ACTION_DEFAULT)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Hold the callback in a ref so the poll effect doesn't re-subscribe (and
  // restart the slow-wait timer) every time the parent passes a fresh onCreated.
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  // Resolve each slot to its committed value or the default fallback, then build
  // the natural-language instruction. This is the single source the chips edit
  // and Copy reads — keep it in lockstep with the rendered template below.
  const scheduleText = schedule.trim() || SCHEDULE_DEFAULT
  const actionText = action.trim() || ACTION_DEFAULT
  const instruction =
    `Follow ${origin}/api/skill and build a loop for the thing you did above. ` +
    `Run it ${scheduleText}, and ${actionText} each time.`

  // The machine config lines stay fixed and read-only — never user-editable.
  const configLines = token
    ? [
        `server-url: ${origin}`,
        `connect-key: ${token}`,
        ...(config?.customCli ? [`loopany-cli: ${config.loopanyCli}`] : []),
      ].join('\n')
    : ''

  const snippet = token ? [instruction, '', configLines].join('\n') : ''

  // Reset to the chooser screen each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setHost(null)
    setPicked('local')
    setToken(null)
    setCreated(null)
    setError(null)
    setCopied(false)
    setSlow(false)
    setSchedule(SCHEDULE_DEFAULT)
    setAction(ACTION_DEFAULT)
  }, [open])

  // Mint a claim + load config once the user picks the local agent.
  useEffect(() => {
    if (!open || host !== 'local') return
    void getConfig().then(setConfig)
    void mintClaim().then((r) => setToken(r.token)).catch(() => setError('could not mint a connect key'))
  }, [open, host])

  // Wait on the claim: Claude Code POSTs the loop with this token as `claim`.
  // If nothing lands within SLOW_WAIT_MS the paste likely didn't reach us
  // (wrong project, daemon down) — flip `slow` to surface a troubleshoot nudge.
  useEffect(() => {
    if (!open || host !== 'local' || created || !token) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const s = await claimStatus({ data: token })
      if (s.done && s.id) {
        if (pollRef.current) clearInterval(pollRef.current)
        setCreated({ id: s.id, name: s.name ?? 'loop' })
        onCreatedRef.current()
      }
    }, 2500)
    const slowTimer = setTimeout(() => setSlow(true), SLOW_WAIT_MS)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearTimeout(slowTimer)
    }
  }, [open, host, created, token])

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('could not copy — select the text and copy manually')
    }
  }

  if (created) {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title="Loop created" sub="Claude Code built and registered it." />
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

  // Step 1 — where does the loop run? Local agent (recommended) vs hosted (soon).
  if (!host) {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title="New loop" sub="Where should this loop run?" />
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            onClick={() => setPicked('local')}
            aria-pressed={picked === 'local'}
            className={`group relative flex cursor-pointer flex-col rounded-xl border bg-surface p-4 text-left transition-colors hover:bg-raised ${
              picked === 'local' ? 'border-display' : 'border-wire'
            }`}
          >
            <span className="absolute right-3 top-3 rounded-full bg-display px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] text-paper">
              Recommended
            </span>
            <div className="text-[15px] font-medium text-display">Your local agent</div>
            <div className="mt-1.5 text-[13px] leading-snug text-secondary">
              Runs on your own machine via Claude Code. Your keys, your code, your
              compute — the server never runs an LLM.
            </div>
            <div className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-secondary">
              {picked === 'local' && <span aria-hidden className="text-[color:var(--color-display)]">✓</span>}
              Claude Code
            </div>
          </button>

          <div
            aria-disabled
            className="relative flex cursor-not-allowed flex-col rounded-xl border border-wire bg-surface p-4 text-left opacity-55"
          >
            <span className="absolute right-3 top-3 rounded-full border border-wire px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] text-disabled">
              Coming soon
            </span>
            <div className="text-[15px] font-medium text-disabled">Hosted on Loopany</div>
            <div className="mt-1.5 text-[13px] leading-snug text-disabled">
              We run the agent for you in the cloud. No machine to keep online — not
              available yet.
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2.5">
          <button className={btn} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} onClick={() => setHost(picked)}>
            Continue
          </button>
        </div>
      </Modal>
    )
  }

  const wait = slow
    ? {
        dot: 'bg-[color:var(--color-secondary)]',
        text: 'Still waiting — check Claude Code is running in the right project, then paste again.',
      }
    : { dot: 'animate-pulse bg-[color:var(--color-display)]', text: 'Waiting for Claude Code…' }

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead title="New loop" />

      {/* Two ordered steps. The snippet builds a loop from "the thing you did
          above", so the task must already exist in the session — the sequence is
          the point. A numbered rail (echoing the Timeline's connector motif)
          makes do-then-capture explicit; step 1 stays a light one-liner and
          step 2 carries the snippet as the visual anchor. */}
      <div className="mt-6">
        {/* Step 1 — do the task. No box; the rail carries the weight. */}
        <div className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-display font-mono text-[10px] leading-none text-display">
              1
            </span>
            <span className="mt-1 w-px flex-1 bg-wire" />
          </div>
          <div className="pb-6">
            <h3 className="font-mono text-[11px] tracking-[0.08em] text-display">DO IT ONCE IN CLAUDE CODE</h3>
            <p className="mt-1.5 text-[13px] leading-snug text-secondary">
              Run the task yourself first, to a real result you’re happy with.
            </p>
          </div>
        </div>

        {/* Step 2 — paste to capture it. The snippet + Copy is the anchor. */}
        <div className="flex gap-3.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-display font-mono text-[10px] leading-none text-display">
            2
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-mono text-[11px] tracking-[0.08em] text-display">PASTE TO CAPTURE IT</h3>
              {snippet && (
                <button className={btnSm} onClick={() => void copy()}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              )}
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-wire bg-raised p-3 font-mono text-[12px] text-primary">
              {/* Instruction line — an editable template. The /api/skill URL is
                  fixed; the two chips (schedule, action) flow inline and wrap
                  like prose. leading-loose gives the bordered chips vertical room
                  so wrapped lines don't collide. */}
              <p className="leading-loose">
                Follow {origin}/api/skill and build a loop for the thing you did above. Run it{' '}
                <EditableChip
                  initialValue={schedule}
                  placeholder={SCHEDULE_DEFAULT}
                  ariaLabel="schedule — how often the loop runs"
                  onChange={setSchedule}
                />
                , and{' '}
                <EditableChip
                  initialValue={action}
                  placeholder={ACTION_DEFAULT}
                  ariaLabel="action — what the loop does each run"
                  onChange={setAction}
                />{' '}
                each time.
              </p>
              {/* Machine config — fixed, read-only. */}
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
              Tweak the highlighted bits, then paste it in that same session — reuses this machine
              automatically.
            </p>
          </div>
        </div>
      </div>

      {error && <div className="mt-3 font-mono text-[13px] text-accent">[ ERROR ] {error}</div>}

      <div className="mt-6 flex items-start gap-3">
        <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${wait.dot}`} />
        <span className="font-mono text-[12px] leading-relaxed tracking-[0.02em] text-secondary">
          {wait.text}
        </span>
        <button className={`${btn} ml-auto shrink-0`} onClick={() => setHost(null)}>
          Back
        </button>
      </div>
    </Modal>
  )
}
