import DOMPurify, { type Config } from 'dompurify'
import { marked } from 'marked'

/**
 * Shared markdown → sanitized HTML pipeline: marked (GFM) → DOMPurify (an
 * allowlisted prose subset, NO script/handlers). ONE sanitizer config for every
 * markdown surface (the Files viewer's `TaskFileView`, the run-detail Execution
 * transcript) so the allowlist can't drift between them. Render the output under
 * the `.taskmd` styles.
 */
export const MD_SANITIZE: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i',
    'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt'],
}

/** Markdown string → sanitized HTML string (safe for dangerouslySetInnerHTML). */
export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false, gfm: true }) as string, MD_SANITIZE)
}
