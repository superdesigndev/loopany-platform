import { useEffect, useState } from 'react'

/* ─────────────────────────────────────────────────────────────────────────────
 * "MEET HOUSEKEEPER" CINEMATIC — animation storyboard
 *
 * A single `stage` integer drives the whole sequence (ms after mount, below).
 * Motion is real spring physics: overshoot easings, staggered entrances, a stamp,
 * a celebratory flourish — in-house CSS/SVG/JS, no deps. `prefers-reduced-motion`
 * renders dignified static stills. Decorative only — never gates the wizard.
 *
 *     0ms   ACT 1 — black frame blooms; the clock odometer starts rolling
 *  1700ms   clock LANDS on 8:00 with a pulse + flash; caption rises
 *  2700ms   ACT 2 — the PR card swoops up with spring overshoot
 *  3300ms   red deletion lines sweep away (staggered); −102 counts down + pops
 *  5200ms   "Merged" STAMPS down with impact; checks rise in
 *  6600ms   ACT 3 — "30 days later" beat; score odometer runs 30 → 80
 *  8600ms   score LANDS on 80: arc overshoots green, ring + sparks flourish
 *  (rests on Act 3 with a Replay affordance)
 * ───────────────────────────────────────────────────────────────────────────── */

const TIMING = {
  clockLand: 1700, // stage 1 — 8:00 lands
  actTwo: 2700, //    stage 2 — PR card swoops in
  deletions: 3300, //  stage 3 — deletions sweep + −102 rolls
  merged: 5200, //     stage 4 — Merged stamps + checks
  actThree: 6600, //   stage 5 — "30 days later" + score counts
  scoreLand: 8600, //  stage 6 — 80 lands + flourish
}
const STAGES = [TIMING.clockLand, TIMING.actTwo, TIMING.deletions, TIMING.merged, TIMING.actThree, TIMING.scoreLand]
const LAST_STAGE = STAGES.length // 6

/* ACT 1 — the clock. An odometer that rolls the exact per-minute frames up to 8:00
 * (each digit reel always travels downward, so it reads as a real spinning odometer). */
function clockFrames(startMin: number, endMin: number): string[] {
  const out: string[] = []
  for (let m = startMin; m <= endMin; m++) out.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`)
  return out
}
const CLOCK = {
  frames: clockFrames(465, 480), // 7:45 → 8:00 — a long, satisfying spin
  rollMs: 1650, // reel roll duration (decelerates into 8:00, settles just before clockLand)
  digitH: 58, // px per reel row (matches the clock font line)
}

/* ACT 2 — deletion lines that sweep away, and the merged stat. */
const DELETIONS = {
  stagger: 130, // ms between each line sweeping out
  lines: [
    'const legacyPriceTable = {',
    '  usd: 1, eur: 0.92, gbp: 0.79,',
    '}',
    'function formatLegacyPrice(v) { … }',
    '// TODO(2019): remove after migration',
  ],
  removed: 102, // the −N stat that counts down
}

/* ACT 3 — the payoff gauge. */
const SCORE = { from: 30, to: 80, runMs: 1700, sparks: 9 }

// Easings.
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
// amber (dull) → healthy green, by score progress.
const healthColor = (t: number) => {
  const a = [201, 144, 46]
  const b = [46, 160, 67]
  const k = Math.min(1, Math.max(0, t))
  const c = a.map((x, i) => Math.round(x + ((b[i] ?? x) - x) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    // jsdom (tests) has no matchMedia — guard so it degrades to motion-on.
    const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    if (!mq) return
    setReduced(mq.matches)
    const on = () => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/** A timer-tweened number (setInterval so vitest fake timers can drive it), started
 *  when `active` flips true and restarted whenever `runId` changes. */
function useTween(active: boolean, from: number, to: number, duration: number, runId: number): number {
  const [value, setValue] = useState(from)
  useEffect(() => {
    if (!active) {
      setValue(from)
      return
    }
    const start = Date.now()
    setValue(from)
    const id = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / duration)
      setValue(from + (to - from) * easeOutCubic(p))
      if (p >= 1) clearInterval(id)
    }, 1000 / 60)
    return () => clearInterval(id)
  }, [active, from, to, duration, runId])
  return value
}

export function HousekeeperCinematic() {
  const reduced = usePrefersReducedMotion()
  const [stage, setStage] = useState(0)
  const [runId, setRunId] = useState(0)

  // Drive the whole sequence off one stage integer (storyboard pattern).
  useEffect(() => {
    if (reduced) return
    setStage(0)
    const timers = STAGES.map((at, i) => setTimeout(() => setStage(i + 1), at))
    return () => timers.forEach(clearTimeout)
  }, [reduced, runId])

  const replay = () => {
    setStage(0)
    setRunId((r) => r + 1)
  }

  // Which act owns the stage → drives the layer choreography.
  const activeAct = stage >= 5 ? 2 : stage >= 2 ? 1 : 0

  if (reduced) {
    return (
      <div data-testid="hk-cinematic" data-act="stills" className="flex flex-col gap-3">
        {[<StillMorning key="s0" />, <StillPr key="s1" />, <StillScore key="s2" />].map((node, i) => (
          <div key={i} className="relative h-52 overflow-hidden rounded-card border border-hairline">
            <span className="absolute left-3 top-3 z-10 rounded-full bg-black/45 px-2 py-0.5 text-micro font-medium text-white">
              {i + 1} / 3
            </span>
            {node}
          </div>
        ))}
      </div>
    )
  }

  const acts = [
    <ActMorning key="a0" stage={stage} runId={runId} />,
    <ActPr key="a1" stage={stage} runId={runId} />,
    <ActScore key="a2" stage={stage} runId={runId} />,
  ]

  return (
    <div data-testid="hk-cinematic" data-act={String(activeAct)} data-stage={String(stage)}>
      {/* Fixed stage; acts choreograph in/out on a shared spring (continuity). */}
      <div className="relative h-64 overflow-hidden rounded-card border border-hairline shadow-card">
        {acts.map((node, i) => {
          const rel = i - activeAct
          // Choreographed handoff: the outgoing act zooms up and out as the next
          // rushes in from below — elements exit as the next enters (continuity).
          const transform = rel === 0 ? 'translateY(0) scale(1)' : rel < 0 ? 'translateY(-16%) scale(1.09)' : 'translateY(18%) scale(0.9)'
          return (
            <div
              key={i}
              aria-hidden={rel !== 0}
              className="absolute inset-0"
              style={{
                opacity: rel === 0 ? 1 : 0,
                transform,
                transition: 'transform 0.8s var(--hk-spring), opacity 0.5s var(--hk-out)',
                pointerEvents: rel === 0 ? undefined : 'none',
              }}
            >
              {/* Remount inner content when the act becomes active so its entrance
                  animations replay from the top (and on Replay). */}
              <div key={`${rel === 0}-${runId}`} className="h-full">
                {node}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 rounded-full"
              style={{
                width: i === activeAct ? 20 : 6,
                background: i === activeAct ? 'var(--color-display)' : 'var(--color-hairline)',
                transition: 'all 0.4s var(--hk-spring)',
              }}
            />
          ))}
        </div>
        {stage >= LAST_STAGE && (
          <button onClick={replay} className="cursor-pointer text-label font-medium text-secondary transition-colors hover:text-display">
            ↺ Replay
          </button>
        )}
      </div>
    </div>
  )
}

/* ── ACT 1 — the quiet morning ─────────────────────────────────────────────── */
function ActMorning({ stage, runId }: { stage: number; runId: number }) {
  const landed = stage >= 1
  // Roll the reel index 0 → last frame; JS tween so fake timers can drive it.
  const idx = useTween(true, 0, CLOCK.frames.length - 1, CLOCK.rollMs, runId)
  const hours = CLOCK.frames.map((f) => f.charAt(0))
  const tens = CLOCK.frames.map((f) => f.charAt(2))
  const ones = CLOCK.frames.map((f) => f.charAt(3))
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-black text-center">
      {/* The frame blooming to life. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.16), transparent 62%)',
          animation: 'hk-bloom 1.6s var(--hk-out) both',
        }}
      />
      {/* The white flash when 8:00 lands. */}
      {landed && (
        <div
          key={`flash-${runId}`}
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.5), transparent 55%)', animation: 'hk-flash 0.7s var(--hk-out) both' }}
        />
      )}
      <span className="sr-only">8:00 AM</span>
      <div
        aria-hidden
        className="flex items-center font-pixel text-[52px] leading-none text-white"
        style={landed ? { animation: 'hk-clock-land 0.55s var(--hk-spring) both' } : undefined}
      >
        <Reel items={hours} index={idx} />
        <span className="px-0.5 pb-1">:</span>
        <Reel items={tens} index={idx} />
        <Reel items={ones} index={idx} />
      </div>
      {landed && (
        <div key={`cap-${runId}`} className="mt-4 text-label text-white/50" style={{ animation: 'hk-caption-in 0.6s var(--hk-out) 0.1s both' }}>
          Housekeeper wakes up. You don&apos;t have to.
        </div>
      )}
    </div>
  )
}

/** A single odometer digit reel; `index` (fractional) scrolls it smoothly downward. */
function Reel({ items, index }: { items: string[]; index: number }) {
  return (
    <span className="block overflow-hidden" style={{ height: CLOCK.digitH, width: '0.62em' }}>
      <span className="block will-change-transform" style={{ transform: `translateY(${-index * CLOCK.digitH}px)` }}>
        {items.map((c, i) => (
          <span key={i} className="block text-center" style={{ height: CLOCK.digitH, lineHeight: `${CLOCK.digitH}px` }}>
            {c}
          </span>
        ))}
      </span>
    </span>
  )
}

/* ── ACT 2 — a PR, handled clean ───────────────────────────────────────────── */
function ActPr({ stage, runId }: { stage: number; runId: number }) {
  // Start rolling the instant the card lands (stage 2) so the stat never sits at −0.
  const removed = Math.round(useTween(stage >= 2, 0, DELETIONS.removed, 900, runId))
  const removedLanded = removed >= DELETIONS.removed
  return (
    <div className="flex h-full items-center justify-center bg-raised p-4">
      <div
        className="w-full max-w-md overflow-hidden rounded-card border border-hairline bg-paper shadow-card"
        style={{ animation: 'hk-swoop 0.7s var(--hk-spring) both' }}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5" style={{ animation: 'hk-rise-in 0.5s var(--hk-out) 0.12s both' }}>
          <MergeGlyph />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">housekeeper/cleanup → main</span>
          {stage >= 4 && (
            <span
              key={`merged-${runId}`}
              className="relative shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success"
              style={{ animation: 'hk-stamp 0.6s var(--hk-spring-strong) both' }}
            >
              <span className="pointer-events-none absolute inset-0 rounded-full" style={{ boxShadow: '0 0 0 2px var(--color-rubik-green)', animation: 'hk-ring 0.6s var(--hk-out) both' }} />
              ✓ Merged
            </span>
          )}
        </div>
        <div className="px-3.5 py-3">
          <div className="text-label font-semibold text-display" style={{ animation: 'hk-rise-in 0.5s var(--hk-out) 0.18s both' }}>
            Remove dead code and two stale files
          </div>
          <div className="mt-2 flex items-center gap-2" style={{ animation: 'hk-rise-in 0.5s var(--hk-out) 0.24s both' }}>
            <span className="font-mono text-caption font-semibold text-success">+2</span>
            <span
              key={removedLanded ? `pop-${runId}` : 'rolling'}
              className="font-mono text-caption font-semibold text-accent"
              style={removedLanded ? { display: 'inline-block', animation: 'hk-pop 0.5s var(--hk-spring) both' } : undefined}
            >
              −{removed}
            </span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-hairline">
              <span className="bg-rubik-green" style={{ width: '3%' }} />
              <span className="bg-rubik-red" style={{ width: '97%' }} />
            </span>
          </div>
          {/* The deletion snippet — red lines that sweep away, line by line. */}
          <div
            className="mt-2.5 overflow-hidden rounded-control border border-hairline px-2.5 py-2 font-mono text-micro leading-relaxed"
            style={{ backgroundColor: 'color-mix(in srgb, var(--color-rubik-red) 7%, transparent)' }}
          >
            {DELETIONS.lines.map((line, i) => (
              <div
                key={i}
                className="flex gap-2 whitespace-pre text-accent"
                style={stage >= 3 ? { animation: `hk-dissolve 0.5s var(--hk-out) ${i * DELETIONS.stagger}ms both` } : undefined}
              >
                <span className="select-none opacity-60">−</span>
                <span className="truncate">{line}</span>
              </div>
            ))}
            {stage >= 3 && (
              <div key={`clean-${runId}`} className="text-caption text-success" style={{ animation: 'hk-caption-in 0.5s var(--hk-out) 0.9s both' }}>
                ✓ all clear
              </div>
            )}
          </div>
          {stage >= 4 && (
            <div
              key={`checks-${runId}`}
              className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-success"
              style={{ animation: 'hk-rise-in 0.5s var(--hk-out) 0.12s both' }}
            >
              <span>✓ build</span>
              <span>✓ tests</span>
              <span>✓ runtime checks</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MergeGlyph() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-success">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5c0 4-4 3.5-6.5 5.5" />
    </svg>
  )
}

/* ── ACT 3 — 30 days later ─────────────────────────────────────────────────── */
function ActScore({ stage, runId }: { stage: number; runId: number }) {
  const active = stage >= 5
  const score = useTween(active, SCORE.from, SCORE.to, SCORE.runMs, runId)
  const landed = stage >= LAST_STAGE
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-surface text-center">
      <div className="text-micro font-semibold uppercase text-secondary" style={{ animation: 'hk-beat-in 0.6s var(--hk-out) both' }}>
        30 days later
      </div>
      <div className="relative mt-3">
        <ScoreGauge score={score} active={active} runId={runId} />
        {landed && <Flourish runId={runId} />}
      </div>
      <div className="mt-3 text-label text-secondary" style={active ? { animation: 'hk-caption-in 0.6s var(--hk-out) 0.9s both' } : { opacity: 0 }}>
        Cleanliness score · <span className="font-medium text-success">+{SCORE.to - SCORE.from}</span> over 30 tidy PRs
      </div>
    </div>
  )
}

/** The gauge: a track + a green arc that overshoots to `score` (CSS spring), number centred. */
function ScoreGauge({ score, active, runId }: { score: number; active: boolean; runId?: number }) {
  const size = 132
  const stroke = 11
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const target = active ? SCORE.to : SCORE.from
  const offset = c * (1 - target / 100)
  const t = (score - SCORE.from) / (SCORE.to - SCORE.from)
  const color = healthColor(t)
  const landed = Math.round(score) >= SCORE.to
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-hairline)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1.6s var(--hk-spring)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          key={active && landed ? `land-${runId}` : 'run'}
          className="font-pixel text-[36px] leading-none"
          style={{ color, ...(active && landed ? { animation: 'hk-pop 0.5s var(--hk-spring) both' } : {}) }}
          data-testid="hk-score"
        >
          {Math.round(score)}
        </span>
        <span className="mt-0.5 text-micro text-disabled">/ 100</span>
      </div>
    </div>
  )
}

/** A calm celebratory burst — an expanding ring + a ring of sparks — once 80 lands. */
function Flourish({ runId }: { runId: number }) {
  return (
    <div key={`flourish-${runId}`} className="pointer-events-none absolute inset-0">
      <span className="absolute inset-0 rounded-full" style={{ boxShadow: '0 0 0 2px var(--color-rubik-green)', animation: 'hk-ring 0.7s var(--hk-out) both' }} />
      {Array.from({ length: SCORE.sparks }).map((_, i) => {
        const angle = (i / SCORE.sparks) * Math.PI * 2
        const dist = 62
        return (
          <span
            key={i}
            className="absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full bg-rubik-green"
            style={
              {
                '--hk-dx': `${Math.cos(angle) * dist}px`,
                '--hk-dy': `${Math.sin(angle) * dist}px`,
                animation: `hk-spark 0.7s var(--hk-out) ${0.05 + (i % 3) * 0.04}s both`,
              } as React.CSSProperties
            }
          />
        )
      })}
    </div>
  )
}

/* ── Reduced-motion static stills (final resting states) ───────────────────── */
function StillMorning() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-black text-center">
      <div className="font-pixel text-[46px] leading-none text-white">8:00 AM</div>
      <div className="mt-3 text-label text-white/50">Housekeeper wakes up. You don&apos;t have to.</div>
    </div>
  )
}
function StillPr() {
  return (
    <div className="flex h-full items-center justify-center bg-raised p-4">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-hairline bg-paper shadow-card">
        <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
          <MergeGlyph />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">housekeeper/cleanup → main</span>
          <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success">✓ Merged</span>
        </div>
        <div className="px-3.5 py-3">
          <div className="text-label font-semibold text-display">Remove dead code and two stale files</div>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-caption font-semibold text-success">+2</span>
            <span className="font-mono text-caption font-semibold text-accent">−102</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-hairline">
              <span className="bg-rubik-green" style={{ width: '3%' }} />
              <span className="bg-rubik-red" style={{ width: '97%' }} />
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-success">
            <span>✓ build</span>
            <span>✓ tests</span>
            <span>✓ runtime checks</span>
          </div>
        </div>
      </div>
    </div>
  )
}
function StillScore() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface text-center">
      <div className="text-micro font-semibold uppercase tracking-[0.12em] text-secondary">30 days later</div>
      <div className="mt-2">
        <ScoreGauge score={SCORE.to} active />
      </div>
      <div className="mt-2 text-label text-secondary">
        Cleanliness score · <span className="font-medium text-success">+{SCORE.to - SCORE.from}</span> over 30 tidy PRs
      </div>
    </div>
  )
}
