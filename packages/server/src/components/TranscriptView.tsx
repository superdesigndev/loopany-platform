import { useMemo } from 'react'
import { groupTranscript, summarizeTool, type TranscriptItem } from '../lib/transcript'
import { renderMarkdown } from '../lib/markdown'
import type { TranscriptStep } from '../types'

/** Inputs/outputs longer than this collapse behind a <details> by default. */
const COLLAPSE_OVER = 240

/**
 * Cube/Rubik accent ramp — the SAME `--color-chart-1..5` tokens the dashboard
 * charts (`LoopChart`) cycle. Each turn's marker rides one hue by index, giving
 * the timeline rhythm + scannability while staying inside the flat, quiet system
 * (color is a small icon accent, never a filled block). Mirrors the CubeMark's
 * one sanctioned break from monochrome.
 */
const TURN_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

/** A monospace payload block — scrolls inside its own pane, never widens the page. */
function Payload({ text }: { text: string }) {
  return (
    <pre className="m-0 mt-1.5 max-h-[280px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline bg-raised px-3 py-2 font-mono text-[11.5px] leading-relaxed text-secondary">
      {text}
    </pre>
  )
}

/** Long payloads collapse; short ones render inline (unless `forceCollapse`, used
 *  for a tool's raw input — the one-line summary already carries the gist, so the
 *  JSON stays tucked behind a toggle no matter how short). */
function Collapsible({ label, text, forceCollapse }: { label: string; text: string; forceCollapse?: boolean }) {
  if (!forceCollapse && text.length <= COLLAPSE_OVER) return <Payload text={text} />
  return (
    <details className="group mt-1.5">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10.5px] tracking-[0.06em] text-disabled marker:content-[''] hover:text-display">
        <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">▸</span>
        {label} · {text.length.toLocaleString()} chars
      </summary>
      <Payload text={text} />
    </details>
  )
}

/** Assistant prose, rendered as (sanitized) markdown so inline bold/code/links/
 *  lists read as a narrative — reuses the shared pipeline + `.taskmd` styles. */
function Prose({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="taskmd min-w-0" dangerouslySetInnerHTML={{ __html: html }} />
}

/** One trace item — a color-cycled marker on the left rail + its content. */
function Item({ item, color }: { item: TranscriptItem; color: string }) {
  const isTool = item.kind === 'tool'
  const summary = isTool ? summarizeTool(item.input) : null
  // Only offer the raw-input expander when it carries more than the inline summary.
  const hasInputDetail = isTool && !!item.input && item.input.trim() !== summary
  return (
    <li className="relative pl-6">
      {/* rail marker — the color accent */}
      <span
        aria-hidden
        className={`absolute left-0 top-1 flex size-3.5 items-center justify-center rounded-[3px] border bg-surface text-[8px] ${
          isTool ? '' : 'bg-raised'
        }`}
        style={{ borderColor: color, color }}
      >
        {isTool ? '⚙' : '¶'}
      </span>
      {isTool ? (
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="inline-flex h-5 shrink-0 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
              {item.name || 'tool'}
            </span>
            {summary && (
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary" title={summary}>
                {summary}
              </span>
            )}
          </div>
          {hasInputDetail && <Collapsible label="input" text={item.input!} forceCollapse />}
          {item.results.map((r, i) => (
            <Collapsible key={i} label="output" text={r} />
          ))}
        </div>
      ) : (
        <div className="min-w-0">
          {item.text && <Prose text={item.text} />}
          {item.results.map((r, i) => (
            <Collapsible key={i} label="output" text={r} />
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * Structured execution trace — renders the flat `TranscriptStep[]` as a vertical
 * timeline: assistant text as markdown prose, tool steps as a compact one-line
 * summary (name + key argument, expandable for the full input), and results
 * attached under their step (collapsed unless short). A left rail (`border-l`) +
 * per-turn color-cycled markers give it rhythm so it reads like an execution
 * timeline, not a wall of text. Long payloads collapse/scroll inside their panes.
 */
export function TranscriptView({ steps }: { steps: TranscriptStep[] }) {
  const items = groupTranscript(steps)
  if (!items.length) return <div className="text-[13px] text-disabled">(no execution trace)</div>
  return (
    <ul className="ml-1.5 space-y-4 border-l border-hairline pl-4">
      {items.map((it, i) => (
        <Item key={i} item={it} color={TURN_COLORS[i % TURN_COLORS.length]!} />
      ))}
    </ul>
  )
}
