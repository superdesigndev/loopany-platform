/**
 * Display helpers + the run-status palette, ported 1:1 from the original
 * self-contained UI page (src/scheduler/ui.ts). The six status colors encode
 * meaning and are reused by the timeline, chart, and A/B panel.
 */
import type { JobSummary, RunSummary } from '../types'

export const fmt = (t: string | null | undefined): string =>
  t ? new Date(t).toLocaleString() : '—'

export const rel = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.now() - Date.parse(t)) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Humanize common crontab patterns ("m h dom mon dow") into a readable phrase —
 * "every 3h", "every 15m", "hourly :07", "daily 07:00", "Mon 09:00". Anything
 * outside these common shapes falls back to the raw expression (shown verbatim,
 * with the literal cron always available on hover at the call site).
 */
export function cronText(cron: string): string {
  const p = (cron || '').trim().split(/\s+/)
  if (p.length !== 5) return cron
  const [mi, ho, dom, mon, dow] = p as [string, string, string, string, string]
  const dateWild = dom === '*' && mon === '*'
  const everyH = ho.match(/^\*\/(\d+)$/)
  if (everyH && dateWild && dow === '*') return `every ${everyH[1]}h`
  const everyM = mi.match(/^\*\/(\d+)$/)
  if (everyM && ho === '*' && dateWild && dow === '*') return `every ${everyM[1]}m`
  if (ho === '*' && /^\d+$/.test(mi) && dateWild && dow === '*')
    return `hourly :${mi.padStart(2, '0')}`
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dateWild) {
    const hhmm = `${ho.padStart(2, '0')}:${mi.padStart(2, '0')}`
    if (dow === '*') return `daily ${hhmm}`
    if (/^[0-6]$/.test(dow)) return `${DOW[Number(dow)]} ${hhmm}`
  }
  return cron
}

/** Compact time-until-future: "due" / "in 50m" / "in 2h" / "in 3d". */
export const until = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.parse(t) - Date.now()) / 1000)
  if (s <= 0) return 'due'
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

export const md = (t: string | number): string => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Compact run-log timestamp: "MM/DD HH:mm" (24h, zero-padded, local). */
export const tsShort = (t: string | null | undefined): string => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const fnum = (n: number): string =>
  Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n * 100) / 100}`

/** Duration in ms → "Ns" (empty for null/0). */
export const dur = (ms: number | null | undefined): string => (ms ? `${Math.round(ms / 1000)}s` : '')

/** Run cost in USD → "$1.24" (sub-cent values keep a meaningful figure: "$0.004";
 *  empty for null/undefined — a zero-cost run still reads "$0.00"). */
export const money = (usd: number | null | undefined): string => {
  if (usd == null) return ''
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Magnitude-formatted byte count — "240 B", "1.8 KB", "3.4 MB" (1024 thresholds). */
export function humanBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${abs} B`
  if (abs < 1024 * 1024) return `${(abs / 1024).toFixed(1)} KB`
  return `${(abs / (1024 * 1024)).toFixed(1)} MB`
}

export interface StatusMeta {
  c: string
  label: string
}

/**
 * status key → color + label. Colors are CSS theme vars (Nothing semantic
 * palette, light/dark aware) — mostly monochrome, with green/amber/red reserved
 * for meaning. Mirrored by the --color-run-* tokens used in Tailwind classes.
 */
export const ST = {
  'nothing-new': { c: 'var(--color-secondary)', label: 'No update' },
  new: { c: 'var(--color-display)', label: 'New' },
  resolved: { c: 'var(--color-success)', label: 'Resolved' },
  error: { c: 'var(--color-accent)', label: 'Error' },
  silent: { c: 'var(--color-disabled)', label: 'Silent' },
  evolve: { c: 'var(--color-interactive)', label: 'Evolved' },
} satisfies Record<string, StatusMeta>

const lookup = (k: string | null | undefined): StatusMeta | undefined =>
  k ? (ST as Record<string, StatusMeta>)[k] : undefined

/**
 * Human labels for the *delivery outcome* of a run that carries no richer status.
 * These describe how a run finished — `direct`/`agent` mean a report reached the
 * user (verbatim vs relayed), `exec` means a normal run completed. We show the
 * user-facing meaning, not the internal enum, so "DIRECT" never leaks into the UI.
 */
const OUTCOME_LABEL: Record<string, string> = {
  direct: 'Reported',
  agent: 'Reported',
  exec: 'Ran',
}

/** Safety net for any unmapped status/outcome string — Title-case, never raw. */
const titleCase = (s: string): string =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s

export function dotColor(r: RunSummary): string {
  // An in-flight evolve pass pulses in its own blue; other runs pulse display ink.
  if (r.running) return r.role === 'evolve' ? ST.evolve.c : ST.new.c
  if (r.canceled) return ST.silent.c
  if (r.outcome === 'error') return ST.error.c
  if (r.outcome === 'evolve') return ST.evolve.c
  if (r.outcome === 'silent') return ST.silent.c
  return (lookup(r.status) ?? ST['nothing-new']).c
}

export function dotLabel(r: RunSummary): string {
  if (r.running) return r.role === 'evolve' ? 'Evolving…' : 'Running…'
  // A deferred run retired without executing (machine offline at fire time) -
  // it rides phase `canceled`, so this check must come first for the honest label.
  if (r.outcome === 'skipped') return 'Skipped'
  if (r.canceled) return 'Canceled'
  if (r.outcome === 'error') return ST.error.label
  if (r.outcome === 'evolve') return ST.evolve.label
  if (r.outcome === 'silent') return ST.silent.label
  // Prefer the run's status (No update / New / Resolved …); otherwise map the
  // delivery outcome to a human label so internal enums never reach the UI.
  return lookup(r.status)?.label ?? OUTCOME_LABEL[r.outcome] ?? titleCase(r.outcome)
}

export const lastRunOf = (j: JobSummary): RunSummary | null => {
  const a = j.runs ?? []
  return a.length ? a[a.length - 1]! : null
}

/**
 * Completed = the loop reached its goal and was stamped terminal (`completedAt`
 * set by `adscaile finish`). This is now an explicit loop state, NOT the old
 * disabled+resolved heuristic — a merely paused loop (no completedAt) stays in
 * the active section with a "Paused" badge.
 */
export function isCompleted(j: JobSummary): boolean {
  return j.completedAt != null
}

/**
 * A CLOSED loop is one carrying a goal (setpoint). "Active closed" = closed but
 * not yet completed — the state that surfaces the quiet "Goal" chip + goal line.
 */
export function isClosed(j: JobSummary): boolean {
  return j.goal != null && j.goal !== ''
}
