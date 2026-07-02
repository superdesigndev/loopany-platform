/**
 * Group a flat `TranscriptStep[]` into a structured trace for the run-detail
 * Execution timeline. The raw stream is a flat list where a `result` step
 * belongs to the tool/text step immediately before it; here we attach each
 * `result` to its owner so the view can render it as that step's output rather
 * than a free-floating line. Pure + framework-free so it's unit-testable.
 */
import type { TranscriptStep } from '../types'

export interface TranscriptItem {
  kind: 'text' | 'tool'
  /** text step body (kind==='text') */
  text?: string
  /** tool name (kind==='tool') */
  name?: string
  /** tool input payload (kind==='tool') */
  input?: string
  /** Output(s) that followed this step — rendered attached/indented under it. */
  results: string[]
}

/**
 * Argument keys, most-to-least identifying, we surface as a tool call's one-line
 * summary (e.g. Read → its `file_path`, Bash → its `command`). The first key
 * present on the parsed args wins, so a call reads as "what it acted on" instead
 * of a raw JSON blob.
 */
const SUMMARY_KEYS = [
  'file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url',
  'prompt', 'description', 'glob', 'name', 'id', 'key',
]

/**
 * A tool call's compact one-line argument summary, or null when there's nothing
 * useful to show inline (empty/unparseable input, or an args object with no
 * recognized key). Pure so the view can stay presentational and this stays
 * unit-testable. The full input is always still available (expandable) in the view.
 */
export function summarizeTool(input: string | undefined): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON — a short scalar payload is itself the summary; a long blob isn't.
    return raw.length <= 120 ? raw : null
  }
  if (typeof parsed === 'string' || typeof parsed === 'number') return String(parsed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  for (const k of SUMMARY_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

export function groupTranscript(steps: TranscriptStep[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const s of steps) {
    if (s.kind === 'result') {
      const owner = items[items.length - 1]
      if (owner) owner.results.push(s.text ?? '')
      // A leading result with no owner is unusual; surface it as a bare text item
      // so nothing is silently dropped.
      else items.push({ kind: 'text', text: s.text ?? '', results: [] })
      continue
    }
    if (s.kind === 'tool') items.push({ kind: 'tool', name: s.name, input: s.input, results: [] })
    else items.push({ kind: 'text', text: s.text ?? '', results: [] })
  }
  return items
}
