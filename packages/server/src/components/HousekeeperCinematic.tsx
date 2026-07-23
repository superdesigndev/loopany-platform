import { useEffect, useState } from 'react'

/**
 * The "Meet Housekeeper" cinematic — a tiny auto-playing three-act storyboard that
 * SHOWS what Housekeeper does instead of only telling. All in-house (CSS/SVG/JS, no
 * video, no deps), themed with loopany's own tokens:
 *   Act 1  the quiet morning — a black frame, "8:00 AM" (it wakes; you don't have to).
 *   Act 2  a PR, handled clean — a stylized (NOT GitHub) pull-request mock: a ~100-line
 *          cleanup merged cleanly (+2 / −102, dead code + stale files removed).
 *   Act 3  30 days later — a code-cleanliness score counting 30 → 80 on a filling arc.
 *
 * Motion mode auto-advances (~2.6s/act, crossfade) and RESTS on the final act with a
 * Replay affordance — it never loops noisily. `prefers-reduced-motion` renders the
 * three acts as static stills (no auto-play, score pinned at its final value). The
 * animation is purely decorative and never gates the wizard's Continue.
 */
const ACTS = 3
const ACT_MS = 2600
const SCORE_FROM = 30
const SCORE_TO = 80

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
  const [act, setAct] = useState(0)
  const [score, setScore] = useState(SCORE_FROM)
  // Bumped by Replay to restart the timers (a dependency the effects key on).
  const [runId, setRunId] = useState(0)

  // Auto-advance through the acts, then rest on the last one (motion only).
  useEffect(() => {
    if (reduced || act >= ACTS - 1) return
    const t = setTimeout(() => setAct((a) => Math.min(a + 1, ACTS - 1)), ACT_MS)
    return () => clearTimeout(t)
  }, [act, reduced, runId])

  // Count the cleanliness score up once Act 3 lands. Reduced motion pins it at the
  // final value; before Act 3 it rests at the starting value.
  useEffect(() => {
    if (reduced) {
      setScore(SCORE_TO)
      return
    }
    if (act !== 2) {
      setScore(SCORE_FROM)
      return
    }
    let v = SCORE_FROM
    const id = setInterval(() => {
      v = Math.min(SCORE_TO, v + 2)
      setScore(v)
      if (v >= SCORE_TO) clearInterval(id)
    }, 40)
    return () => clearInterval(id)
  }, [act, reduced, runId])

  const replay = () => {
    setScore(SCORE_FROM)
    setAct(0)
    setRunId((r) => r + 1)
  }

  const acts = [<ActMorning key="a0" />, <ActPr key="a1" />, <ActScore key="a2" score={score} />]

  // Reduced motion: three static stills, stacked and labelled. No auto-play.
  if (reduced) {
    return (
      <div data-testid="hk-cinematic" data-act="stills" className="flex flex-col gap-3">
        {acts.map((node, i) => (
          <div key={i} className="relative h-56 overflow-hidden rounded-card border border-hairline">
            <span className="absolute left-3 top-3 z-10 rounded-full bg-black/45 px-2 py-0.5 text-micro font-medium text-white">
              {i + 1} / {ACTS}
            </span>
            {node}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div data-testid="hk-cinematic" data-act={String(act)}>
      {/* Fixed frame; acts crossfade inside it so the box never jumps. */}
      <div className="relative h-64 overflow-hidden rounded-card border border-hairline shadow-card">
        {acts.map((node, i) => (
          <div
            key={i}
            aria-hidden={i !== act}
            className={`absolute inset-0 transition-opacity duration-700 ease-out ${
              i === act ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {node}
          </div>
        ))}
      </div>
      {/* Act dots + a Replay affordance once the story has rested on the last act. */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: ACTS }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === act ? 'w-5 bg-display' : 'w-1.5 bg-hairline'}`}
            />
          ))}
        </div>
        {act === ACTS - 1 && (
          <button
            onClick={replay}
            className="cursor-pointer text-label font-medium text-secondary transition-colors hover:text-display"
          >
            ↺ Replay
          </button>
        )}
      </div>
    </div>
  )
}

/** Act 1 — the quiet morning: a black frame, the wake-up time, minimal. */
function ActMorning() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-black text-center">
      <div className="font-pixel text-[clamp(34px,7vw,54px)] leading-none tracking-tight text-white">8:00 AM</div>
      <div className="mt-3 text-label text-white/45">Housekeeper wakes up. You don&apos;t have to.</div>
    </div>
  )
}

/** Act 2 — a stylized (non-GitHub) pull-request mock: a ~100-line cleanup, merged clean. */
function ActPr() {
  return (
    <div className="flex h-full items-center justify-center bg-raised p-4">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-hairline bg-paper shadow-card">
        {/* Header: generic merge glyph + branch line + a Merged pill (our own styling). */}
        <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
          <MergeGlyph />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">
            housekeeper/cleanup → main
          </span>
          <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success">
            ✓ Merged
          </span>
        </div>
        <div className="px-3.5 py-3">
          <div className="text-label font-semibold text-display">Remove dead code and two stale files</div>
          {/* Diff stat + a mostly-red additions/deletions bar. */}
          <div className="mt-2 flex items-center gap-2">
            <span className="font-mono text-caption font-semibold text-success">+2</span>
            <span className="font-mono text-caption font-semibold text-accent">−102</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-hairline">
              <span className="w-[3%] bg-rubik-green" />
              <span className="w-[97%] bg-rubik-red" />
            </span>
          </div>
          {/* Removed / trimmed files. */}
          <div className="mt-2.5 flex flex-col gap-1 font-mono text-caption">
            <FileRow mark="−" markCls="text-accent" path="src/legacy/priceUtils.ts" note="102 lines, unreferenced" />
            <FileRow mark="−" markCls="text-accent" path="docs/ARCHITECTURE_OLD.md" note="superseded" />
            <FileRow mark="~" markCls="text-secondary" path="src/format.ts" note="drop unused import" />
          </div>
          {/* Green checks — proven safe before merge. */}
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-hairline pt-2.5 text-caption text-success">
            <span>✓ build</span>
            <span>✓ tests</span>
            <span>✓ runtime checks</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function FileRow({ mark, markCls, path, note }: { mark: string; markCls: string; path: string; note: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 shrink-0 text-center font-semibold ${markCls}`}>{mark}</span>
      <span className="min-w-0 truncate text-primary">{path}</span>
      <span className="shrink-0 text-disabled">· {note}</span>
    </div>
  )
}

/** A tiny generic branch-merge glyph — deliberately NOT any code host's real icon. */
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

/** Act 3 — 30 days later: the cleanliness score on a filling arc. */
function ActScore({ score }: { score: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface text-center">
      <div className="text-micro font-semibold uppercase tracking-[0.12em] text-secondary">30 days later</div>
      <div className="mt-3">
        <ScoreGauge score={score} />
      </div>
      <div className="mt-3 text-label text-secondary">
        Cleanliness score · <span className="font-medium text-success">+{SCORE_TO - SCORE_FROM}</span> over 30 tidy PRs
      </div>
    </div>
  )
}

/** A calm circular gauge: a track + a green arc filled to `score`/100, number centred. */
function ScoreGauge({ score }: { score: number }) {
  const size = 128
  const stroke = 11
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.min(100, Math.max(0, score)) / 100)
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-hairline)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-rubik-green)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-100 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-pixel text-[34px] leading-none text-display" data-testid="hk-score">
          {Math.round(score)}
        </span>
        <span className="mt-0.5 text-micro text-disabled">/ 100</span>
      </div>
    </div>
  )
}
