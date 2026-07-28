import { useEffect, useState } from 'react'

/* ─────────────────────────────────────────────────────────────────────────────
 * "MEET HOUSEKEEPER" CINEMATIC — animation storyboard
 *
 * Story: Housekeeper wakes every morning, lands one small cleanup, and the
 * compounding effect makes the codebase healthier — a little better every day.
 *
 * Driven by ONE `elapsed` clock (ms) advanced by a frame ticker that only runs
 * while playing (so hover pauses the whole thing) — every beat is a pure function
 * of `elapsed`. Motion is real spring physics: overshoot easings, staggered
 * entrances, a stamp, a per-day rhythm, a celebratory settle. In-house CSS/SVG/JS,
 * no deps. `prefers-reduced-motion` renders dignified static stills. Decorative
 * only — never gates the wizard; Replay + pause-on-hover throughout.
 *
 *      0ms  ACT 1 — black frame blooms; the clock odometer rolls up…
 *   1700ms  …LANDS on 7:00 with a pulse + flash; caption rises
 *   2700ms  ACT 2 — one clean PR: the card swoops up (spring overshoot)
 *   3300ms  red deletion lines sweep away (staggered); −102 counts down + pops
 *   5200ms  "Merged" STAMPS down with impact; checks rise in
 *   6600ms  ACT 3 — day by day: Day 1 → Day 30, a small PR each day, the arc
 *           filling in STEPS and the score climbing 30 → 80 in daily nudges…
 *  11400ms  …lands on 80 with a pop + ring/sparks flourish
 *  11800ms  ACT 4 — the cadence beat: "Every morning · 07:00", rests here
 * ───────────────────────────────────────────────────────────────────────────── */

const TIMING = {
  clockLand: 1700, //  stage 1 — 7:00 lands
  actTwo: 2700, //     stage 2 — PR card swoops in
  deletions: 3300, //  stage 3 — deletions sweep + −102 rolls
  merged: 5200, //     stage 4 — Merged stamps + checks
  actThree: 6600, //   stage 5 — the day-by-day montage begins
  actFour: 11800, //   stage 6 — the closing cadence beat (rests)
}
const STAGES = [TIMING.clockLand, TIMING.actTwo, TIMING.deletions, TIMING.merged, TIMING.actThree, TIMING.actFour]
const LAST_STAGE = STAGES.length // 6
const END = TIMING.actFour + 500 // cap the clock (rest on the last act)
const FRAME_MS = 1000 / 60

/* ACT 1 — the clock. An odometer that rolls the exact per-minute frames up to 07:00 —
 * the Housekeeper loop's real cadence, matching Act 4's "Every morning · 07:00"
 * (each digit reel always travels downward, so it reads as a real spinning odometer). */
function clockFrames(startMin: number, endMin: number): string[] {
  const out: string[] = []
  for (let m = startMin; m <= endMin; m++) out.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`)
  return out
}
const CLOCK = {
  frames: clockFrames(405, 420), // 6:45 → 7:00 — a long, satisfying spin
  rollMs: 1550, // reel roll duration (decelerates into 7:00, settles just before clockLand)
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
  countMs: 900,
}

/* ACT 3 — the day-by-day compounding montage. */
const MONTAGE = {
  days: 30, //        Day 1 → Day 30
  dur: 4600, //       wall-clock for the whole climb (compact — one act, not a sit)
  from: 30, //        starting cleanliness score
  to: 80, //          the score it lands on
  sparks: 9,
}

// Easings.
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
// amber (dull) → healthy green, by score progress.
const healthColor = (t: number) => {
  const a = [201, 144, 46]
  const b = [46, 160, 67]
  const k = clamp01(t)
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

export function HousekeeperCinematic() {
  const reduced = usePrefersReducedMotion()
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [runId, setRunId] = useState(0)

  // ONE frame ticker drives the whole cinematic; it advances `elapsed` only while
  // playing, so hover pauses everything and Replay (runId) restarts the clock. Once
  // the clock saturates at END the story rests on the last act, so the ticker stops
  // rather than firing 60x/sec forever. `finished` is a boolean (not `elapsed`), so
  // the interval is torn down once — not re-created on every frame.
  const finished = elapsed >= END
  useEffect(() => {
    if (reduced || paused || finished) return
    const id = setInterval(() => setElapsed((e) => Math.min(END, e + FRAME_MS)), FRAME_MS)
    return () => clearInterval(id)
  }, [reduced, paused, runId, finished])

  const replay = () => {
    setElapsed(0)
    setRunId((r) => r + 1)
  }

  // Everything below is a pure function of `elapsed`.
  const stage = STAGES.filter((t) => elapsed >= t).length
  const activeAct = stage >= 6 ? 3 : stage >= 5 ? 2 : stage >= 2 ? 1 : 0

  if (reduced) {
    return (
      <div data-testid="hk-cinematic" data-act="stills" className="flex flex-col gap-3">
        {[<StillMorning key="s0" />, <StillPr key="s1" />, <StillDays key="s2" />, <StillCadence key="s3" />].map((node, i) => (
          <div key={i} className="relative h-48 overflow-hidden rounded-card border border-hairline">
            <span className="absolute left-3 top-3 z-10 rounded-full bg-black/45 px-2 py-0.5 text-micro font-medium text-white">
              {i + 1} / 4
            </span>
            {node}
          </div>
        ))}
      </div>
    )
  }

  const acts = [
    <ActMorning key="a0" elapsed={elapsed} runId={runId} />,
    <ActPr key="a1" elapsed={elapsed} runId={runId} />,
    <ActDays key="a2" elapsed={elapsed} runId={runId} />,
    <ActCadence key="a3" runId={runId} />,
  ]

  return (
    <div
      data-testid="hk-cinematic"
      data-act={String(activeAct)}
      data-stage={String(stage)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
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
          {[0, 1, 2, 3].map((i) => (
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
function ActMorning({ elapsed, runId }: { elapsed: number; runId: number }) {
  const landed = elapsed >= TIMING.clockLand
  // Roll the reel index 0 → last frame, derived from the shared clock (decelerating).
  const idx = easeOutCubic(clamp01(elapsed / CLOCK.rollMs)) * (CLOCK.frames.length - 1)
  const hours = CLOCK.frames.map((f) => f.charAt(0))
  const tens = CLOCK.frames.map((f) => f.charAt(2))
  const ones = CLOCK.frames.map((f) => f.charAt(3))
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-black text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.16), transparent 62%)',
          animation: 'hk-bloom 1.6s var(--hk-out) both',
        }}
      />
      {landed && (
        <div
          key={`flash-${runId}`}
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.5), transparent 55%)', animation: 'hk-flash 0.7s var(--hk-out) both' }}
        />
      )}
      <span className="sr-only">7:00 AM</span>
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
function ActPr({ elapsed, runId }: { elapsed: number; runId: number }) {
  const counting = elapsed >= TIMING.actTwo
  const removed = Math.round(easeOutCubic(clamp01((elapsed - TIMING.actTwo) / DELETIONS.countMs)) * DELETIONS.removed)
  const removedLanded = counting && removed >= DELETIONS.removed
  const sweeping = elapsed >= TIMING.deletions
  const merged = elapsed >= TIMING.merged
  return (
    <div className="flex h-full items-center justify-center bg-raised p-4">
      <div
        className="w-full max-w-md overflow-hidden rounded-card border border-hairline bg-paper shadow-card"
        style={{ animation: 'hk-swoop 0.7s var(--hk-spring) both' }}
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5" style={{ animation: 'hk-rise-in 0.5s var(--hk-out) 0.12s both' }}>
          <MergeGlyph />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">housekeeper/cleanup → main</span>
          {merged && (
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
          <div
            className="mt-2.5 overflow-hidden rounded-control border border-hairline px-2.5 py-2 font-mono text-micro leading-relaxed"
            style={{ backgroundColor: 'color-mix(in srgb, var(--color-rubik-red) 7%, transparent)' }}
          >
            {DELETIONS.lines.map((line, i) => (
              <div
                key={i}
                className="flex gap-2 whitespace-pre text-accent"
                style={sweeping ? { animation: `hk-dissolve 0.5s var(--hk-out) ${i * DELETIONS.stagger}ms both` } : undefined}
              >
                <span className="select-none opacity-60">−</span>
                <span className="truncate">{line}</span>
              </div>
            ))}
            {sweeping && (
              <div key={`clean-${runId}`} className="text-caption text-success" style={{ animation: 'hk-caption-in 0.5s var(--hk-out) 0.9s both' }}>
                ✓ all clear
              </div>
            )}
          </div>
          {merged && (
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

/* ── ACT 3 — day by day (the compounding montage) ──────────────────────────── */
function ActDays({ elapsed, runId }: { elapsed: number; runId: number }) {
  // Discrete daily progress: the day counter ticks Day 1 → Day 30, the score steps
  // up a few points each day (arc fills in STEPS), one grid cell fills per day.
  const dayP = clamp01((elapsed - TIMING.actThree) / MONTAGE.dur)
  const day = dayP <= 0 ? 0 : Math.min(MONTAGE.days, Math.ceil(dayP * MONTAGE.days))
  const score = MONTAGE.from + Math.round((day / MONTAGE.days) * (MONTAGE.to - MONTAGE.from))
  const landed = day >= MONTAGE.days
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-surface px-5 text-center">
      <div className="text-micro font-semibold uppercase tracking-[0.14em] text-secondary" style={{ animation: 'hk-beat-in 0.6s var(--hk-out) both' }}>
        A little better every day
      </div>
      <div className="mt-3 flex items-center gap-6">
        <div className="relative">
          <ScoreGauge score={score} landed={landed} runId={runId} />
          {landed && <Flourish runId={runId} />}
        </div>
        <div className="flex flex-col items-start">
          <div className="font-pixel text-[22px] leading-none text-display" data-testid="hk-day">
            Day {Math.max(1, day)}
          </div>
          <div className="mt-0.5 text-micro text-disabled">of {MONTAGE.days}</div>
          {/* One cell per day — a small cleanup landing, the repo getting cleaner. */}
          <div className="mt-2.5 grid grid-cols-6 gap-1">
            {Array.from({ length: MONTAGE.days }).map((_, i) => {
              const filled = i < day
              return (
                <span
                  key={`${i}-${filled}`}
                  className="size-[9px] rounded-[2px]"
                  style={
                    filled
                      ? { background: 'var(--color-rubik-green)', animation: 'hk-pop 0.4s var(--hk-spring) both' }
                      : { background: 'var(--color-hairline)' }
                  }
                />
              )
            })}
          </div>
        </div>
      </div>
      <div className="mt-3 text-label text-secondary">
        Cleanliness score · <span className="font-medium text-success">+{MONTAGE.to - MONTAGE.from}</span> over {MONTAGE.days} tidy PRs
      </div>
    </div>
  )
}

/** The gauge: a track + a green arc that STEPS to `score` each day, number centred. */
function ScoreGauge({ score, landed, runId }: { score: number; landed: boolean; runId?: number }) {
  const size = 116
  const stroke = 10
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - clamp01(score / 100))
  const t = (score - MONTAGE.from) / (MONTAGE.to - MONTAGE.from)
  const color = healthColor(t)
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
          // Short transition → the arc nudges then holds each day (steps, not a pour).
          style={{ transition: 'stroke-dashoffset 0.16s var(--hk-out), stroke 0.4s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          key={landed ? `land-${runId}` : 'run'}
          className="font-pixel text-[32px] leading-none"
          style={{ color, ...(landed ? { animation: 'hk-pop 0.5s var(--hk-spring) both' } : {}) }}
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
      {Array.from({ length: MONTAGE.sparks }).map((_, i) => {
        const angle = (i / MONTAGE.sparks) * Math.PI * 2
        const dist = 56
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

/* ── ACT 4 — the cadence beat (rests here) ─────────────────────────────────── */
function ActCadence({ runId }: { runId: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-black text-center">
      <div key={`c-loop-${runId}`} aria-hidden style={{ animation: 'hk-pop 0.6s var(--hk-spring) both' }}>
        <LoopMark />
      </div>
      <div className="mt-4 font-pixel text-[26px] leading-none text-white" style={{ animation: 'hk-caption-in 0.6s var(--hk-out) 0.15s both' }}>
        Every morning · 07:00
      </div>
      <div className="mt-3 max-w-xs text-label leading-relaxed text-white/55" style={{ animation: 'hk-caption-in 0.6s var(--hk-out) 0.3s both' }}>
        Housekeeper keeps your codebase a little cleaner, every day.
      </div>
    </div>
  )
}

/** A simple recurring-loop mark (the daily cadence), drawn in the brand green. */
function LoopMark() {
  return (
    <svg aria-hidden width="40" height="40" viewBox="0 0 30 30" fill="none" stroke="var(--color-rubik-green)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M25.5 15a10.5 10.5 0 1 1-3.1-7.4" />
      <path d="M25.5 3.5v5.2h-5.2" />
    </svg>
  )
}

/* ── Reduced-motion static stills (final resting states) ───────────────────── */
function StillMorning() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-black text-center">
      <div className="font-pixel text-[42px] leading-none text-white">7:00 AM</div>
      <div className="mt-3 text-label text-white/50">Housekeeper wakes up. You don&apos;t have to.</div>
    </div>
  )
}
function StillPr() {
  return (
    <div className="flex h-full items-center justify-center bg-raised p-4">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-hairline bg-paper shadow-card">
        <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2">
          <MergeGlyph />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">housekeeper/cleanup → main</span>
          <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success">✓ Merged</span>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="text-label font-semibold text-display">Remove dead code and two stale files</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="font-mono text-caption font-semibold text-success">+2</span>
            <span className="font-mono text-caption font-semibold text-accent">−102</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-hairline">
              <span className="bg-rubik-green" style={{ width: '3%' }} />
              <span className="bg-rubik-red" style={{ width: '97%' }} />
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-caption text-success">
            <span>✓ build</span>
            <span>✓ tests</span>
            <span>✓ runtime checks</span>
          </div>
        </div>
      </div>
    </div>
  )
}
function StillDays() {
  return (
    <div className="flex h-full items-center justify-center gap-6 bg-surface px-5 text-center">
      <ScoreGauge score={MONTAGE.to} landed runId={0} />
      <div className="flex flex-col items-start">
        <div className="font-pixel text-[22px] leading-none text-display">Day 30</div>
        <div className="mt-0.5 text-micro text-disabled">of 30</div>
        <div className="mt-2.5 grid grid-cols-6 gap-1">
          {Array.from({ length: MONTAGE.days }).map((_, i) => (
            <span key={i} className="size-[9px] rounded-[2px]" style={{ background: 'var(--color-rubik-green)' }} />
          ))}
        </div>
        <div className="mt-2 text-label text-secondary">
          Cleanliness score · <span className="font-medium text-success">+{MONTAGE.to - MONTAGE.from}</span> over {MONTAGE.days} tidy PRs
        </div>
      </div>
    </div>
  )
}
function StillCadence() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-black text-center">
      <LoopMark />
      <div className="mt-3 font-pixel text-[24px] leading-none text-white">Every morning · 07:00</div>
      <div className="mt-2 max-w-xs text-label leading-relaxed text-white/55">
        Housekeeper keeps your codebase a little cleaner, every day.
      </div>
    </div>
  )
}
