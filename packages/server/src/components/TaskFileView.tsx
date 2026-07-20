import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { parseFrontMatter } from '../server/frontmatter'

/** The leading `---` front-matter block (opening fence, block, closing fence).
 *  Must agree with `parseFrontMatter` before anything is stripped: the regex
 *  finds the extent, the parser decides it really is front matter. */
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

/** Split a markdown document into its front-matter scalars and the body below.
 *  No front matter (or a malformed block) → meta null, body untouched — the
 *  document renders exactly as before. */
function splitFrontMatter(content: string): { meta: Record<string, string> | null; body: string } {
  const meta = parseFrontMatter(content)
  if (!meta) return { meta: null, body: content }
  const m = FRONT_MATTER_RE.exec(content)
  if (!m) return { meta: null, body: content }
  return { meta, body: content.slice(m[0].length) }
}

/** Front-matter scalars as a calm key/value strip instead of raw `key: value`
 *  prose (which the markdown pipeline would otherwise mangle into a heading). */
function FrontMatterBlock({ meta }: { meta: Record<string, string> }) {
  const entries = Object.entries(meta)
  if (!entries.length) return null
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-control border border-hairline px-3.5 py-2.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-caption text-disabled">{k}</span>
          <span className="min-w-0 break-words text-caption text-secondary">{v}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Renders markdown (a loop's task file, or any `.md` artifact) as a calm,
 * formatted document instead of a raw mono dump. A leading front-matter block
 * renders as a key/value strip (not as prose); the rest goes through the shared
 * pipeline: `renderMarkdown` (marked GFM → DOMPurify allowlist) → `.taskmd`
 * styles. Bare prose only — the host (the unified Files viewer) owns the
 * surface, padding cadence, and scroll.
 */
export function TaskFileView({ content }: { content: string }) {
  const { meta, body } = useMemo(() => splitFrontMatter(content), [content])
  const html = useMemo(() => renderMarkdown(body), [body])

  return (
    <div className="px-5 py-4">
      {meta && <FrontMatterBlock meta={meta} />}
      <div className="taskmd" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
