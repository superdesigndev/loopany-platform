import { useCallback, useEffect, useState } from 'react'
import type { TemplateInfo } from '../types'
import { createMachine, finalizeMachine, machineStatus } from '../server/machineFns'
import { claimStatus, getConfig, mintClaim } from '../server/loopApi'
import { simulateLoopCreated, simulateMachineConnect } from '../server/onboardingSim'
import {
  clearPersisted,
  loadPersisted,
  markOnboardingDismissed,
  NUMBERED,
  prevNumbered,
  savePersisted,
  STEP_LABEL,
  type Persisted,
  type Step,
} from '../lib/onboardingState'
import { HousekeeperCinematic } from './HousekeeperCinematic'
import { LoopLogo } from './LoopLogo'
import { btnPrimary, btnPrimaryPill, btnSm } from './ui'

/**
 * First-run onboarding: from a fresh login to a live Housekeeper loop, in four
 * guided steps. Each step advances on DETECTED reality, never a claimed Next:
 *   - the machine step completes when a daemon actually polls (`machineStatus.online`)
 *   - the loop step completes when a real loop record lands (`claimStatus.done`)
 * so the flow mirrors exactly how a loop is really born (connect a machine, paste
 * the bootstrap + template prompt into your coding agent).
 *
 * Resumable: the minted machine/claim tokens and the current step persist to
 * localStorage (per team), so leaving mid-way and coming back picks up where you
 * left off. Dismissible via a quiet "skip for now".
 *
 * DEV DEMO: when `getConfig().onboardingSim` is true (dev build + the
 * `LOOPANY_ONBOARDING_SIM` opt-in) each waiting step shows a "simulate" button that
 * fires the real store write a daemon would — so the whole flow is clickable
 * locally without a second machine. The buttons never render in a production build.
 */
export function OnboardingWizard({
  teamId,
  housekeeper,
  onExit,
}: {
  teamId?: string
  /** The Housekeeper template meta (its `description` is the paste-prompt). Null if
   *  the registry somehow lacks it — the flow still works, just without the intent. */
  housekeeper: TemplateInfo | null
  /** Leave the wizard (skip or finish) — the route navigates back to the dashboard. */
  onExit: () => void
}) {
  const teamKey = teamId ?? 'open'
  const [persisted, setPersisted] = useState<Persisted>(() => loadPersisted(teamKey))
  const { step, machineId, machineToken, claimToken } = persisted
  const [machineOnline, setMachineOnline] = useState(false)
  const [config, setConfig] = useState<{ loopanyCli: string; customCli: boolean; onboardingSim: boolean } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [simBusy, setSimBusy] = useState(false)

  const patch = useCallback((p: Partial<Persisted>) => setPersisted((prev) => ({ ...prev, ...p })), [])
  const goStep = useCallback((s: Step) => patch({ step: s }), [patch])

  // Persist every change so a mid-flow reload resumes exactly here.
  useEffect(() => savePersisted(teamKey, persisted), [teamKey, persisted])

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const cli = config?.loopanyCli ?? 'npx @crewlet/loopany@latest'

  // Client config (CLI prefix + the dev-sim flag) once.
  useEffect(() => {
    void getConfig().then(setConfig)
  }, [])

  // Step "machine" — mint a device token + pending machine row once we arrive.
  useEffect(() => {
    if (step !== 'machine' || machineId) return
    let cancelled = false
    void createMachine({ data: teamId })
      .then((r) => {
        if (cancelled) return
        if ('error' in r) setError(r.error)
        else patch({ machineId: r.id, machineToken: r.token })
      })
      .catch(() => !cancelled && setError('could not prepare a connect command'))
    return () => {
      cancelled = true
    }
  }, [step, machineId, teamId, patch])

  // Step "machine" — poll until the daemon actually connects (detected reality),
  // then silently name it so it lands in the machine list + online count.
  useEffect(() => {
    if (step !== 'machine' || !machineId || machineOnline) return
    const tick = async () => {
      const s = await machineStatus({ data: machineId }).catch(() => undefined)
      if (s?.online) {
        setMachineOnline(true)
        void finalizeMachine({ data: { id: machineId, name: s.hostname || 'My machine' } }).catch(() => {})
      }
    }
    void tick()
    const t = setInterval(tick, 2000)
    return () => clearInterval(t)
  }, [step, machineId, machineOnline])

  // Step "prompt" — mint the claim token that correlates the created loop back here.
  useEffect(() => {
    if (step !== 'prompt' || claimToken) return
    let cancelled = false
    void mintClaim({ data: teamId })
      .then((r) => {
        if (cancelled) return
        if ('token' in r) patch({ claimToken: r.token })
        else setError(r.error)
      })
      .catch(() => !cancelled && setError('could not mint a connect key'))
    return () => {
      cancelled = true
    }
  }, [step, claimToken, teamId, patch])

  // Step "prompt" — poll until the loop record actually lands (detected reality),
  // then advance to the celebration.
  useEffect(() => {
    if (step !== 'prompt' || !claimToken) return
    const tick = async () => {
      const s = await claimStatus({ data: claimToken }).catch(() => undefined)
      if (s?.done && s.id) goStep('done')
    }
    void tick()
    const t = setInterval(tick, 2500)
    return () => clearInterval(t)
  }, [step, claimToken, goStep])

  const connectCommand = machineToken ? `${cli} up --server-url ${origin} --connect-key ${machineToken}` : ''
  const instruction = `Fetch ${origin}/api/bootstrap and help me build a loop.`
  const configLines = claimToken
    ? [`server-url: ${origin}`, `connect-key: ${claimToken}`, ...(config?.customCli ? [`loopany-cli: ${cli}`] : [])].join('\n')
    : ''
  const description = housekeeper?.description?.trim() ?? ''
  const snippet = claimToken ? [instruction, '', configLines, ...(description ? ['', description] : [])].join('\n') : ''

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500)
    } catch {
      setError('could not copy - select the text and copy manually')
    }
  }

  async function simConnect() {
    if (!machineId) return
    setSimBusy(true)
    const r = await simulateMachineConnect({ data: machineId }).catch(() => ({ ok: false, error: 'simulation failed' }))
    if (!r.ok) setError(r.error ?? 'simulation failed')
    setSimBusy(false)
  }

  async function simLoop() {
    if (!machineToken || !claimToken) return
    setSimBusy(true)
    const r = await simulateLoopCreated({ data: { token: machineToken, claim: claimToken } }).catch(() => ({
      ok: false,
      error: 'simulation failed',
    }))
    if (!r.ok) setError(r.error ?? 'simulation failed')
    setSimBusy(false)
  }

  function finish() {
    markOnboardingDismissed(teamKey)
    clearPersisted(teamKey)
    onExit()
  }

  function skip() {
    // Keep progress (resumable) but stop the homepage auto-starting it again.
    markOnboardingDismissed(teamKey)
    onExit()
  }

  const back = () => {
    const prev = prevNumbered(step)
    if (prev) goStep(prev)
  }

  const currentIndex = step === 'done' ? NUMBERED.length : NUMBERED.indexOf(step)

  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col px-6 py-8">
        {/* Brand + quiet skip */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LoopLogo size={26} />
            <span className="text-[16px] font-semibold tracking-[-0.015em] text-display">Loopany</span>
          </div>
          {step !== 'done' && (
            <button onClick={skip} className="cursor-pointer text-label text-secondary transition-colors hover:text-display">
              Skip for now
            </button>
          )}
        </div>

        {/* Progress rail */}
        {step !== 'done' && (
          <div className="mt-8 flex items-center gap-2" aria-label={`Step ${currentIndex + 1} of ${NUMBERED.length}`}>
            {NUMBERED.map((s, i) => (
              <div key={s} className="flex flex-1 flex-col gap-1.5">
                <div className={`h-1 rounded-full transition-colors ${i <= currentIndex ? 'bg-display' : 'bg-hairline'}`} />
                <span className={`text-micro font-medium ${i === currentIndex ? 'text-display' : 'text-disabled'}`}>{STEP_LABEL[s]}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-1 flex-col justify-center py-10">
          {step === 'welcome' && (
            <Section>
              <h1 className="font-pixel text-[clamp(24px,5vw,32px)] leading-[1.15] text-display">Your first loop</h1>
              <p className="mt-4 text-body leading-relaxed text-secondary">
                A loop is a small task your coding agent repeats on a schedule - on your own machine, with your own keys and
                tools. The server never runs an LLM; it just schedules and remembers.
              </p>
              <p className="mt-3 text-body leading-relaxed text-secondary">
                Let&apos;s set up your first one - <span className="font-medium text-display">Housekeeper</span>, a daily tidy-up
                for your codebase - in three quick steps.
              </p>
              <div className="mt-8">
                <button className={btnPrimary} onClick={() => goStep('machine')}>
                  Get started →
                </button>
              </div>
            </Section>
          )}

          {step === 'machine' && (
            <Section>
              <h1 className="text-[22px] font-semibold text-display">Get your machine online</h1>
              <p className="mt-3 text-body leading-relaxed text-secondary">
                Loops run on your computer through your coding agent. Run this once in a terminal to connect it - it starts a
                small background daemon and adopts this connect key.
              </p>

              <div className="mt-5 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-display p-4 font-mono text-label leading-relaxed text-paper">
                  {connectCommand || 'preparing your connect command…'}
                </pre>
                <button className={btnSm} disabled={!connectCommand} onClick={() => void copy(connectCommand, 'cmd')}>
                  {copied === 'cmd' ? '✓' : 'Copy'}
                </button>
              </div>

              <div className="mt-5">
                {machineOnline ? (
                  <div className="flex items-center gap-2.5 rounded-control border border-hairline bg-success-soft px-4 py-3">
                    <span className="text-lg text-success">✓</span>
                    <span className="text-body font-medium text-display">Machine connected.</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5 rounded-control border border-hairline bg-warn-soft px-4 py-3">
                    <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-rubik-orange" />
                    <span className="text-body font-medium text-warn">Waiting for your machine to connect…</span>
                  </div>
                )}
              </div>

              {config?.onboardingSim && !machineOnline && (
                <SimButton busy={simBusy} onClick={() => void simConnect()} label="Simulate connection" />
              )}

              <StepFooter onBack={back} canBack>
                <button className={btnPrimary} disabled={!machineOnline} onClick={() => goStep('meet')}>
                  Continue →
                </button>
              </StepFooter>
            </Section>
          )}

          {step === 'meet' && (
            <Section>
              <h1 className="text-[22px] font-semibold text-display">Meet Housekeeper</h1>
              <p className="mt-3 text-body leading-relaxed text-secondary">
                Every morning it lands <span className="font-medium text-display">one</span> small, provably safe cleanup -
                dead code, a stale file, an unused dependency - as a tidy pull request. Here&apos;s a month in fast-forward.
              </p>

              <div className="mt-5">
                <HousekeeperCinematic />
              </div>

              <StepFooter onBack={back} canBack>
                <button className={btnPrimary} onClick={() => goStep('prompt')}>
                  Set it up →
                </button>
              </StepFooter>
            </Section>
          )}

          {step === 'prompt' && (
            <Section>
              <h1 className="text-[22px] font-semibold text-display">Copy the prompt</h1>
              <p className="mt-3 text-body leading-relaxed text-secondary">
                Paste this into your coding agent, in the project you want kept tidy. It sets Housekeeper up for you - schedule,
                task file, and dashboard - then registers it here.
              </p>

              <div className="mt-5 flex items-start gap-2">
                <div className="min-w-0 flex-1 rounded-control border border-hairline bg-raised p-3 font-mono text-label text-primary">
                  <p className="leading-relaxed">{instruction}</p>
                  {configLines ? (
                    <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-hairline pt-3 leading-relaxed text-secondary">
                      {configLines}
                    </pre>
                  ) : (
                    <div className="mt-3 border-t border-hairline pt-3 text-secondary">minting a connect key…</div>
                  )}
                  {description && configLines && (
                    <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-hairline pt-3 leading-relaxed text-primary">
                      {description}
                    </p>
                  )}
                </div>
                <button className={btnSm} disabled={!snippet} onClick={() => void copy(snippet, 'snippet')}>
                  {copied === 'snippet' ? '✓' : 'Copy'}
                </button>
              </div>

              <div className="mt-5 flex items-center gap-3">
                <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-rubik-orange" />
                <span className="text-label leading-relaxed text-secondary">Waiting for your coding agent to build the loop…</span>
                <button className={`${btnPrimaryPill} ml-auto`} disabled={!snippet} onClick={() => void copy(snippet, 'snippet')}>
                  {copied === 'snippet' ? '✓ Copied' : 'Copy prompt'}
                </button>
              </div>

              {config?.onboardingSim && (
                <SimButton busy={simBusy} onClick={() => void simLoop()} label="Simulate loop created" />
              )}

              <StepFooter onBack={back} canBack />
            </Section>
          )}

          {step === 'done' && (
            <Section>
              <div className="text-center">
                <div className="text-[44px]" aria-hidden>
                  🎉
                </div>
                <h1 className="mt-2 font-pixel text-[clamp(22px,4.5vw,30px)] leading-tight text-display">Housekeeper is live</h1>
                <p className="mt-4 text-body leading-relaxed text-secondary">
                  It&apos;s scheduled and will run on your machine every morning. You&apos;ll find it - and every run it produces
                  - on your dashboard.
                </p>
                <div className="mt-8">
                  <button className={btnPrimary} onClick={finish}>
                    Go to dashboard →
                  </button>
                </div>
              </div>
            </Section>
          )}

          {error && <div className="mt-6 text-center text-body text-accent">Error: {error}</div>}
        </div>
      </div>
    </div>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="animate-[fadeIn_180ms_ease-out]">{children}</div>
}

/** The dev-only "simulate this step" affordance — visually set apart as a debug tool. */
function SimButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-control border border-dashed border-hairline bg-surface px-3 py-2">
      <span className="text-micro font-medium uppercase tracking-wide text-disabled">dev</span>
      <button className={btnSm} disabled={busy} onClick={onClick}>
        {busy ? 'Simulating…' : label}
      </button>
      <span className="text-caption text-disabled">no real machine needed</span>
    </div>
  )
}

/** Back / Continue footer row. `children` is the right-aligned primary action. */
function StepFooter({ onBack, canBack, children }: { onBack: () => void; canBack: boolean; children?: React.ReactNode }) {
  return (
    <div className="mt-9 flex items-center justify-between">
      {canBack ? (
        <button onClick={onBack} className="cursor-pointer text-label text-secondary transition-colors hover:text-display">
          ← Back
        </button>
      ) : (
        <span />
      )}
      {children}
    </div>
  )
}
