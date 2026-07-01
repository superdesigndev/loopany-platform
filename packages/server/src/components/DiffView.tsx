import { humanBytes } from '../lib/format'
import { diffStat, parseUnifiedDiff, type DiffLine } from '../lib/diff'
import type { RunDiffFile } from '../types'

/** Per-file status word + its ink (reused from the old Changes list). */
const STATUS_LABEL: Record<RunDiffFile['status'], string> = { added: 'added', modified: 'changed', removed: 'removed' }
const STATUS_CLS: Record<RunDiffFile['status'], string> = {
  added: 'text-success',
  modified: 'text-secondary',
  removed: 'text-accent',
}

/** Signed byte delta — "+1.8 KB", "−240 B", "" when unknown/zero. */
function fmtDelta(n: number | null): string {
  if (n == null || n === 0) return ''
  return `${n > 0 ? '+' : '−'}${humanBytes(n)}`
}

/** A diff line's row classes — line-level tint + gutter ink per kind. */
const LINE_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-[color:var(--color-diff-add-bg)] text-primary',
  del: 'bg-[color:var(--color-diff-del-bg)] text-primary',
  hunk: 'bg-[color:var(--color-diff-hunk-bg)] text-disabled',
  meta: 'text-disabled',
  context: 'text-secondary',
}
const GUTTER_CLS: Record<DiffLine['kind'], string> = {
  add: 'text-success',
  del: 'text-accent',
  hunk: 'text-disabled',
  meta: 'text-disabled',
  context: 'text-disabled',
}

/**
 * The colored diff body for one file. Each physical line becomes a row with a
 * `+`/`-`/` ` gutter and a line-level background tint (add=green, del=red, hunk
 * de-emphasized). Long lines DON'T wrap — the pane scrolls them horizontally
 * (`overflow-x-auto min-w-0`) so a wide line never widens the page. Height is
 * capped so a long diff scrolls inside its own box.
 */
function DiffBody({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="min-w-0 max-h-[420px] overflow-auto border-t border-hairline bg-raised font-mono text-[12px] leading-[1.55]">
      <div className="min-w-max">
        {lines.map((l, i) => (
          <div key={i} className={`flex ${LINE_CLS[l.kind]}`}>
            <span aria-hidden className={`w-6 shrink-0 select-none pl-2.5 text-center ${GUTTER_CLS[l.kind]}`}>
              {l.gutter}
            </span>
            <span className="whitespace-pre pr-4">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One file row header — status word, path, size delta, and binary/too-large markers. */
function FileHead({ f, lines }: { f: RunDiffFile; lines: DiffLine[] | null }) {
  const delta = fmtDelta(f.sizeDelta)
  const stat = lines ? diffStat(lines) : null
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[12.5px]">
      <span className={`shrink-0 text-[10px] uppercase tracking-[0.08em] ${STATUS_CLS[f.status]}`}>{STATUS_LABEL[f.status]}</span>
      <span className="min-w-0 break-all text-primary">{f.path}</span>
      {stat && (stat.added > 0 || stat.removed > 0) && (
        <span className="shrink-0 font-mono text-[10.5px] tracking-[0.04em]">
          {stat.added > 0 && <span className="text-success">+{stat.added}</span>}
          {stat.added > 0 && stat.removed > 0 && ' '}
          {stat.removed > 0 && <span className="text-accent">−{stat.removed}</span>}
        </span>
      )}
      {delta && <span className="shrink-0 text-[10.5px] tracking-[0.04em] text-disabled">{delta}</span>}
      {f.binary && <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-secondary">binary</span>}
      {f.tooLarge && <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-secondary">too large to diff</span>}
    </span>
  )
}

/** Small enough to auto-open; larger diffs start collapsed. */
const AUTO_OPEN_LINES = 40

/**
 * The Changes diff view — a list of changed files, each collapsible, its unified
 * diff rendered as colored add/remove/context lines. Files with no inline diff
 * (binary / oversize / too-large) render just the header row. Small diffs default
 * open, large ones collapsed. Built entirely from theme tokens — no external diff
 * library.
 */
export function DiffView({ files }: { files: RunDiffFile[] }) {
  return (
    <div className="space-y-1.5">
      {files.map((f) => {
        if (!f.diff)
          return (
            <div key={f.path} className="rounded-md border border-hairline bg-surface px-3.5 py-2">
              <FileHead f={f} lines={null} />
            </div>
          )
        const lines = parseUnifiedDiff(f.diff)
        const open = lines.length <= AUTO_OPEN_LINES
        return (
          <details key={f.path} open={open} className="group min-w-0 overflow-hidden rounded-md border border-hairline bg-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2 marker:content-['']">
              <span aria-hidden className="shrink-0 text-[10px] text-disabled transition-transform group-open:rotate-90">
                ▸
              </span>
              <FileHead f={f} lines={lines} />
            </summary>
            <DiffBody lines={lines} />
          </details>
        )
      })}
    </div>
  )
}
