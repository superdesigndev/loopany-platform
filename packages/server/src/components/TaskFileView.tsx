import { useMemo } from 'react'
import DOMPurify, { type Config } from 'dompurify'
import { marked } from 'marked'

/**
 * Renders markdown (a loop's task file, or any `.md` artifact) as a calm,
 * formatted document instead of a raw mono dump. Pipeline: marked (GFM) →
 * DOMPurify (allowlisted prose subset, NO script/handlers) → `.taskmd` styles.
 * Bare prose only — the host (the unified Files viewer) owns the surface,
 * padding cadence, and scroll.
 */
const MD_SANITIZE: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i',
    'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt'],
}

export function TaskFileView({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true }) as string, MD_SANITIZE),
    [content],
  )

  return <div className="taskmd px-5 py-4" dangerouslySetInnerHTML={{ __html: html }} />
}
