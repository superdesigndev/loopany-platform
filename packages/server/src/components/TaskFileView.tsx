import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'

/**
 * Renders markdown (a loop's task file, or any `.md` artifact) as a calm,
 * formatted document instead of a raw mono dump. Pipeline: the shared
 * `renderMarkdown` (marked GFM → DOMPurify allowlist) → `.taskmd` styles.
 * Bare prose only — the host (the unified Files viewer) owns the surface,
 * padding cadence, and scroll.
 */
export function TaskFileView({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])

  return <div className="taskmd px-5 py-4" dangerouslySetInnerHTML={{ __html: html }} />
}
