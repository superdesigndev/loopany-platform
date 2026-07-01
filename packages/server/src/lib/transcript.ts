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
