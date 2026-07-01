import { groupTranscript, type TranscriptItem } from '../lib/transcript'
import type { TranscriptStep } from '../types'

/** Inputs/outputs longer than this collapse behind a <details> by default. */
const COLLAPSE_OVER = 240

/** A monospace payload block — scrolls inside its own pane, never widens the page. */
function Payload({ text }: { text: string }) {
  return (
    <pre className="m-0 mt-1.5 max-h-[280px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline bg-raised px-3 py-2 font-mono text-[11.5px] leading-relaxed text-secondary">
      {text}
    </pre>
  )
}

/** Long payloads collapse; short ones render inline. */
function Collapsible({ label, text }: { label: string; text: string }) {
  if (text.length <= COLLAPSE_OVER) return <Payload text={text} />
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

/** One trace item — a marker on the left rail + its content (text / tool + I/O). */
function Item({ item }: { item: TranscriptItem }) {
  const isTool = item.kind === 'tool'
  return (
    <li className="relative pl-6">
      {/* rail marker */}
      <span
        aria-hidden
        className={`absolute left-0 top-1 flex size-3.5 items-center justify-center rounded-[3px] border text-[8px] ${
          isTool ? 'border-wire bg-surface text-secondary' : 'border-hairline bg-raised text-disabled'
        }`}
      >
        {isTool ? '⚙' : '¶'}
      </span>
      {isTool ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="inline-flex h-5 items-center rounded border border-wire px-2 font-mono text-[10.5px] tracking-[0.06em] text-display">
              {item.name || 'tool'}
            </span>
          </div>
          {item.input != null && item.input !== '' && <Collapsible label="input" text={item.input} />}
          {item.results.map((r, i) => (
            <div key={i} className="mt-1.5">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-disabled">result</div>
              <Collapsible label="result" text={r} />
            </div>
          ))}
        </div>
      ) : (
        <div className="min-w-0">
          {item.text && (
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-primary">{item.text}</div>
          )}
          {item.results.map((r, i) => (
            <div key={i} className="mt-1.5">
              <Collapsible label="result" text={r} />
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * Structured execution trace — renders the flat `TranscriptStep[]` as a vertical
 * timeline: text steps as prose, tool steps as a labeled row with a collapsible
 * monospace input, and result steps attached under the step they belong to. A
 * left rail (`border-l`) + per-item markers give it hierarchy so it reads like an
 * execution timeline, not a wall of text. Long payloads collapse/scroll inside
 * their own panes.
 */
export function TranscriptView({ steps }: { steps: TranscriptStep[] }) {
  const items = groupTranscript(steps)
  if (!items.length) return <div className="text-[13px] text-disabled">(no execution trace)</div>
  return (
    <ul className="ml-1.5 space-y-4 border-l border-hairline pl-4">
      {items.map((it, i) => (
        <Item key={i} item={it} />
      ))}
    </ul>
  )
}
