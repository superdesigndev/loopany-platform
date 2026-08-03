import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * THE TWO RENDER PATHS, and the wall between them (design §7).
 *
 *  - **Markdown** → client-side COMPONENT rendering (react-markdown + GFM).
 *    Raw inline HTML is NOT rendered: react-markdown drops it unless you opt in
 *    with `rehype-raw`, which this file deliberately never imports. That is the
 *    XSS answer for every body we display — task bodies, loop charters, doc
 *    bodies, run reports. There is no sanitizer to configure and therefore no
 *    allowlist to drift.
 *
 *  - **`format: html` docs** → a STRICT sandboxed iframe, and nothing else.
 *    `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the frame an
 *    OPAQUE origin: its scripts run, but they cannot read this app's cookies or
 *    session, cannot reach `parent`, and cannot call our API as the signed-in
 *    human. Adding `allow-same-origin` alongside `allow-scripts` would let the
 *    frame remove its own sandbox — the two together are equivalent to no
 *    sandbox at all, which is why they never appear together here.
 *
 * HTML is a DOC-only narrow door. Task and loop bodies stay Markdown: task
 * bodies feed diffs and verdicts, loop bodies are prompts whose diffs are the
 * audit window. Nothing in this file offers an HTML path for either.
 */

/** Markdown body → React elements. Raw HTML in the source is not rendered. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="ws-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}

/** The sandbox attribute, exported so a test can pin it as a VALUE rather than
 *  assert against a string buried in JSX. `allow-same-origin` must never join it. */
export const DOC_SANDBOX = 'allow-scripts'

export function SandboxedHtml({ html, title }: { html: string; title: string }) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  // A referrer/anchor policy the frame cannot widen: it has no same-origin
  // access, so this is belt-and-braces around navigation, not the boundary.
  const srcDoc = useMemo(() => `<!doctype html><meta charset="utf-8"><base target="_blank">${html}`, [html])
  return (
    <div className="ws-sandbox">
      <div className="ws-sandbox-bar">
        <span className="ws-badge ws-badge-html">format: html</span>
        <span className="ws-sandbox-note">sandboxed · opaque origin · no access to your session</span>
        <div className="ws-toggle">
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
            Preview
          </button>
          <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
            Source
          </button>
        </div>
      </div>
      {mode === 'preview' ? (
        <iframe className="ws-sandbox-frame" title={`${title} (sandboxed)`} sandbox={DOC_SANDBOX} srcDoc={srcDoc} />
      ) : (
        <pre className="ws-source">{html}</pre>
      )}
    </div>
  )
}

/**
 * THE EXECUTION BLOCK — the execution-integrity invariant made visible.
 *
 * Machine-executed content lives in structured payload fields; this renders
 * those fields VERBATIM, as data, never as prose and never through a formatter
 * that could reinterpret them. Presentation may decorate but can never
 * substitute what is actually approved and executed: what a person reads here is
 * byte-for-byte what the payload holds.
 *
 * Rich review surfaces compose instead — a doc (possibly HTML) as exhibit, and a
 * task whose body links it. Approval lands on the task; the doc is never the
 * contract.
 */
export function ExecutionBlock({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload ?? {})
  return (
    <section className="ws-execution" aria-label="Execution payload">
      <header>
        <b>Execution payload</b>
        <span>rendered verbatim — this is what gets executed</span>
      </header>
      {entries.length === 0 ? (
        <p className="ws-empty">No structured payload. This task carries narrative only.</p>
      ) : (
        <dl>
          {entries.map(([key, value]) => (
            <div key={key} className="ws-execution-row">
              <dt>{key}</dt>
              <dd>
                <pre>{scalar(value)}</pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}
