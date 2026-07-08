import { useEffect, useRef, useState } from 'react'
import type { CodingAgent, TemplateInfo } from '../types'
import { claimStatus, getConfig, mintClaim } from '../server/loopApi'
import { Modal, ModalHead } from './Modal'
import { LoopFlow, hasLoopFlow } from './LoopFlow'
import { btn, btnPrimary, btnPrimaryPill, btnSm } from './ui'

// How long to wait on a silent paste before nudging the user to check things.
const SLOW_WAIT_MS = 100_000

// Display label for the coding agent the daemon MEASURED on the host and the
// server recorded on the loop. There is no manual picker: `loopany new` resolves
// the agent from the host env fingerprint (Claude Code vs Codex), so the dialog
// only ever displays the recorded value — it never declares one.
const AGENT_LABEL: Record<CodingAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

// The two coding agents loopany supports today, shown as brand marks on the
// Copy-prompt button (the prompt runs in whichever you use). LobeHub icon set,
// decorative (aria-hidden) — the button text is the accessible name.
function ClaudeCodeMark({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="#D97757" fillRule="evenodd" className="shrink-0" xmlns="http://www.w3.org/2000/svg">
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  )
}

/** Codex color mark (LobeHub icon set) — verbatim: white app tile + gradient glyph. */
function CodexMark({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff" />
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill="url(#lobe-icons-codex-grad)"
      />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-grad" x1="12" x2="12" y1="3" y2="21">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

// The one human-readable instruction the snippet carries. `/api/bootstrap` serves the
// BOOTSTRAP doc (skill/bootstrap.md) — it owns ALL first-capture intelligence: it
// interprets the pasted values, connects the machine, reads the session to decide
// what loop to build (turn a just-done task into a loop, else brainstorm loops for
// this project), and routes into the create/update/evolve references. So the snippet
// is just a bootstrap: fetch it and ask to build a loop. A template appends its canned
// task description below (the INTENT); the create flow still confirms cadence/config.
const instructionFor = (origin: string) => `Fetch ${origin}/api/bootstrap and help me build a loop.`

/**
 * New loop = capture-from-Claude-Code (paste-forward, no machine picker). The web
 * mints a claim token, shows ONE instruction block, and waits. The user pastes it
 * into their own Claude Code session (where they just did the task); Claude
 * follows /api/bootstrap — ensures a daemon is running (the token authorizes a new
 * machine, or the machine's stored token reuses an existing one) and POSTs the
 * loop to /api/machine/loop with this token as `claim`. We poll the claim until
 * the loop lands, then close. No machine selection: the binding is decided on the
 * machine, the claim just correlates the result back to this dialog.
 *
 * A `template` (a canned loop intent picked from the dashboard cards) reuses this exact
 * machinery: it skips the host chooser, goes straight to the snippet, and appends the
 * template's `description` under the config lines — bootstrap.md + create.md then handle
 * cadence/config the same way. The blank-loop flow is unchanged when `template` is null.
 */
export function ComposeModal({
  open,
  onClose,
  onCreated,
  template = null,
  teamId,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  template?: TemplateInfo | null
  /** The dashboard's explicit team (the `/t/<id>` route) so a captured loop binds
   *  to the tab's team, not the shared last-used cookie. Undefined in open mode. */
  teamId?: string
}) {
  // Step 1 picks where the loop runs. null = chooser screen; 'local' advances to
  // the capture-from-Claude-Code paste flow. A template skips the chooser (host is
  // pre-set to 'local'). 'hosted' (run on Loopany) is not yet available.
  const [host, setHost] = useState<'local' | null>(null)
  const [picked, setPicked] = useState<'local'>('local') // step-1 selection (local pre-selected; hosted is disabled)
  const [token, setToken] = useState<string | null>(null)
  const [config, setConfig] = useState<{ loopanyCli: string; customCli: boolean } | null>(null)
  // Carries the MEASURED agent (`loops.agent`, from the daemon's env fingerprint)
  // back from `claimStatus`, so the confirmation shows what actually ran, not a pick.
  const [created, setCreated] = useState<{ id: string; name: string; agent: CodingAgent } | null>(null)
  const [copied, setCopied] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Hold the callback in a ref so the poll effect doesn't re-subscribe (and
  // restart the slow-wait timer) every time the parent passes a fresh onCreated.
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  // The single bootstrap instruction. The same string renders in the snippet box
  // and goes on the clipboard, so the two can't desync.
  const instruction = instructionFor(origin)

  // The machine config lines stay fixed and read-only — never user-editable. No
  // `agent:` line: `loopany new` resolves the agent from the host env fingerprint
  // (Claude Code vs Codex), so the snippet never declares one to override it.
  const configLines = token
    ? [
        `server-url: ${origin}`,
        `connect-key: ${token}`,
        ...(config?.customCli ? [`loopany-cli: ${config.loopanyCli}`] : []),
      ].join('\n')
    : ''

  // A template appends its canned task description under the config (the INTENT).
  const description = template?.description?.trim() ?? ''
  const snippet = token
    ? [instruction, '', configLines, ...(description ? ['', description] : [])].join('\n')
    : ''

  // Reset each time the dialog opens. A template goes straight to the local paste
  // flow (skip the chooser); a blank loop starts at the chooser.
  useEffect(() => {
    if (!open) return
    setHost(template ? 'local' : null)
    setPicked('local')
    setToken(null)
    setCreated(null)
    setError(null)
    setCopied(false)
    setSlow(false)
  }, [open, template])

  // Mint a claim + load config once the user picks the local agent.
  useEffect(() => {
    if (!open || host !== 'local') return
    void getConfig().then(setConfig)
    void mintClaim({ data: teamId })
      .then((r) => ('token' in r ? setToken(r.token) : setError(r.error)))
      .catch(() => setError('could not mint a connect key'))
  }, [open, host, teamId])

  // Wait on the claim: Claude Code POSTs the loop with this token as `claim`.
  // If nothing lands within SLOW_WAIT_MS the paste likely didn't reach us
  // (wrong project, daemon down) — flip `slow` to surface a troubleshoot nudge.
  useEffect(() => {
    if (!open || host !== 'local' || created || !token) return
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      void claimStatus({ data: token })
        .then((s) => {
          if (s.done && s.id) {
            if (pollRef.current) clearInterval(pollRef.current)
            // The agent is the daemon's measured value; default only guards an older
            // server that doesn't yet return it on the claim.
            setCreated({ id: s.id, name: s.name ?? 'loop', agent: s.agent ?? 'claude-code' })
            onCreatedRef.current()
          }
        })
        // A transient server blip mustn't surface an unhandled rejection every
        // tick — swallow it; the next tick retries.
        .catch(() => {})
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
      setError('could not copy - select the text and copy manually')
    }
  }

  // The snippet box — shared by the blank-loop step 2 and the template screen. Copy
  // takes the full `snippet` string (instruction + config + any description), so the
  // rendered pieces below can't desync from the clipboard.
  const snippetBox = (showInlineCopy = true) => (
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-label font-semibold text-display">Paste to capture it</h3>
        {showInlineCopy && snippet && (
          <button className={btnSm} onClick={() => void copy()}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        )}
      </div>
      <div className="mt-2 overflow-hidden rounded-control border border-hairline bg-raised p-3 font-mono text-label text-primary">
        {/* Instruction line - a single fixed bootstrap line; the skill (not the
            snippet) collects the task, cadence, and output format. */}
        <p className="leading-relaxed">{instruction}</p>
        {/* Machine config - fixed, read-only. */}
        {configLines ? (
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-hairline pt-3 leading-relaxed text-secondary">
            {configLines}
          </pre>
        ) : (
          <div className="mt-3 border-t border-hairline pt-3 leading-relaxed text-secondary">
            minting a connect key…
          </div>
        )}
        {/* Template intent - the canned task description, appended below the config. */}
        {description && configLines && (
          <p className="mt-3 whitespace-pre-wrap border-t border-hairline pt-3 leading-relaxed text-primary">
            {description}
          </p>
        )}
      </div>
      <p className="mt-2 text-body leading-snug text-secondary">
        Paste it in that same session - reuses this machine automatically. Your agent will{' '}
        {template ? 'set the loop up from here.' : 'ask what the loop should do.'}
      </p>
    </div>
  )

  const wait = slow
    ? {
        dot: 'bg-secondary',
        text: 'Still waiting - check your coding agent is running in the right project, then paste again.',
      }
    : { dot: 'animate-pulse bg-rubik-orange', text: 'Waiting for your coding agent…' }

  // The primary CTA, shared by both compose modals: copies the full snippet, with
  // the supported-agent marks. Sits flush-right in the waiting row.
  const copyPromptButton = (
    <button className={`${btnPrimaryPill} ml-auto`} onClick={() => void copy()} disabled={!snippet}>
      <span className="inline-flex items-center gap-0.5">
        <ClaudeCodeMark />
        <CodexMark />
      </span>
      {copied ? '✓ Copied' : 'Copy prompt'}
    </button>
  )

  if (created) {
    return (
      <Modal open={open} onClose={onClose}>
        <ModalHead title="Loop created" sub={`${AGENT_LABEL[created.agent]} built and registered it.`} />
        <div className="mt-5 rounded-card border border-hairline bg-surface p-5 shadow-card">
          <div className="text-[17px] font-medium text-display">✓ {created.name}</div>
          <div className="mt-1 text-body text-secondary">It’s scheduled now and will run on the machine.</div>
        </div>
        <div className="mt-4">
          <button className={btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  // Template screen — straight to the snippet (no host chooser, no two-step rail).
  // Templates with a workflow diagram open a wider, two-column modal: the paste
  // prompt on the left, the loop visualization on the right. Templates without one
  // keep the plain single-column screen.
  if (template) {
    const showFlow = hasLoopFlow(template.name)
    const promptCol = (
      <div className="min-w-0">
        {snippetBox(false)}
        {error && <div className="mt-3 text-body text-accent">Error: {error}</div>}
        <div className="mt-6 flex items-start gap-3">
          <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${wait.dot}`} />
          <span className="text-label leading-relaxed text-secondary">{wait.text}</span>
          {copyPromptButton}
        </div>
      </div>
    )
    return (
      <Modal open={open} onClose={onClose} wide={showFlow}>
        <ModalHead title={template.label} sub="Paste this into your coding agent, in the project you want the loop for." />
        {showFlow ? (
          <div className="mt-5 grid gap-8 md:grid-cols-[minmax(0,1fr)_400px]">
            {promptCol}
            <div className="min-w-0 md:border-l md:border-hairline md:pl-8">
              <LoopFlow template={template} />
            </div>
          </div>
        ) : (
          <div className="mt-6">{promptCol}</div>
        )}
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
            className={`group relative flex cursor-pointer flex-col rounded-card border bg-surface p-4 text-left shadow-card transition-colors hover:bg-raised ${
              picked === 'local' ? 'border-display' : 'border-hairline'
            }`}
          >
            <span className="absolute right-3 top-3 rounded-full bg-display px-2 py-0.5 text-micro font-medium text-paper">
              Recommended
            </span>
            <div className="text-[15px] font-medium text-display">Your local agent</div>
            <div className="mt-1.5 text-body leading-snug text-secondary">
              Runs on your own machine via your coding agent. Your keys, your code,
              your compute - the server never runs an LLM.
            </div>
            <div className="mt-3 inline-flex items-center gap-1.5 text-caption font-medium text-secondary">
              {picked === 'local' && <span aria-hidden className="text-[color:var(--color-display)]">✓</span>}
              Auto-detects your coding agent
            </div>
          </button>

          <div
            aria-disabled
            className="relative flex cursor-not-allowed flex-col rounded-card border border-hairline bg-surface p-4 text-left opacity-55 shadow-card"
          >
            <span className="absolute right-3 top-3 rounded-full bg-raised px-2 py-0.5 text-micro font-medium text-disabled">
              Coming soon
            </span>
            <div className="text-[15px] font-medium text-disabled">Hosted on Loopany</div>
            <div className="mt-1.5 text-body leading-snug text-disabled">
              We run the agent for you in the cloud. No machine to keep online - not
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

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHead title="New loop" />

      {/* Two ordered steps. The snippet just bootstraps the skill ("fetch … and
          help me build a loop") - the skill asks for the task, cadence, and output
          format, so it handles both a real task done above AND an empty session.
          Doing the task once first is recommended (better loop), not required. A
          numbered rail (echoing the Timeline's connector motif) keeps do-then-
          capture explicit; step 2 carries the snippet as the visual anchor. */}
      <div className="mt-6">
        {/* Step 1 - do the task. No box; the rail carries the weight. */}
        <div className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-display text-micro font-medium leading-none text-display">
              1
            </span>
            <span className="mt-1 w-px flex-1 bg-hairline" />
          </div>
          <div className="pb-6">
            <h3 className="text-label font-semibold text-display">
              Do it once in your coding agent
            </h3>
            <p className="mt-1.5 text-body leading-snug text-secondary">
              Run the task yourself first, to a real result you’re happy with.
            </p>
          </div>
        </div>

        {/* Step 2 - paste to capture it. The snippet + Copy is the anchor. */}
        <div className="flex gap-3.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-display text-micro font-medium leading-none text-display">
            2
          </span>
          {snippetBox(false)}
        </div>
      </div>

      {error && <div className="mt-3 text-body text-accent">Error: {error}</div>}

      <div className="mt-6 flex items-start gap-3">
        <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${wait.dot}`} />
        <span className="text-label leading-relaxed text-secondary">
          {wait.text}
        </span>
        {copyPromptButton}
      </div>
    </Modal>
  )
}
