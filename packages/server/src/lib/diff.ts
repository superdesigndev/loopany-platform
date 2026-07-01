/**
 * Tiny unified-diff line parser — enough to render a `RunDiffFile.diff` string
 * (a real unified text diff produced server-side by `server/runDiff.ts`, via
 * jsdiff) as a colored, gutter-marked diff view. Deliberately NOT a full patch
 * parser: we only classify each physical line so the UI can tint it. Long lines
 * are preserved verbatim (the view scrolls them inside its own pane).
 */

export type DiffLineKind =
  | 'add' // an inserted line ("+…", not the "+++" file header)
  | 'del' // a removed line ("-…", not the "---" file header)
  | 'hunk' // a hunk header ("@@ -a,b +c,d @@")
  | 'meta' // file headers / index lines ("--- a/…", "+++ b/…", "diff …", "index …")
  | 'context' // an unchanged context line

export interface DiffLine {
  kind: DiffLineKind
  /** The line WITHOUT its leading +/-/space marker (meta/hunk keep their text). */
  text: string
  /** The gutter glyph: "+", "-", or "" (blank for context/meta/hunk). */
  gutter: string
}

/** Classify one physical diff line. */
function classify(line: string): DiffLine {
  // File-header / index lines come before content and must NOT be read as add/del.
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
    return { kind: 'meta', text: line, gutter: '' }
  if (line.startsWith('@@')) return { kind: 'hunk', text: line, gutter: '' }
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), gutter: '+' }
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), gutter: '-' }
  // A leading space is the unified-diff context marker; strip exactly one.
  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1), gutter: '' }
  // "\ No newline at end of file" and any stray line → neutral context.
  return { kind: 'context', text: line, gutter: '' }
}

/**
 * Split a unified-diff string into classified lines. A trailing newline does not
 * emit a spurious empty final line (common in generated diffs).
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const body = diff.endsWith('\n') ? diff.slice(0, -1) : diff
  return body.split('\n').map(classify)
}

/** Counts of added/removed content lines — for a compact per-file "+N −M" tally. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
