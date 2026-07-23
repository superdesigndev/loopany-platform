import { renderMarkdown } from './markdown'
import { parseFrontMatter } from '../server/frontmatter'

/**
 * The To-Do detail is ONE consistent thing: an HTML report document rendered in
 * the sandboxed frame. A run's own HTML artifact is shown as-is; a run whose
 * output is markdown/plain text is turned into the SAME styled report document
 * here (client-side — the sanitizer needs a DOM), so the UI has a single render
 * path (a sandboxed iframe) with no text-vs-html branching.
 *
 * `wrapReportHtml` is a pure string wrap (testable without a DOM);
 * `markdownToReportDoc` renders markdown → sanitized HTML (the shared
 * `renderMarkdown` pipeline) then wraps it. The stylesheet is SELF-CONTAINED
 * (the sandboxed frame has an opaque origin and can't use the app's CSS) and
 * light (the frame renders on white, like the existing HTML-artifact preview).
 */

const FRONT_MATTER_RE = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

function stripFrontMatter(content: string): { meta: Record<string, string> | null; body: string } {
  const meta = parseFrontMatter(content)
  if (!meta) return { meta: null, body: content }
  const m = FRONT_MATTER_RE.exec(content)
  return m ? { meta, body: content.slice(m[0].length) } : { meta: null, body: content }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A self-contained, calm report stylesheet (concrete colours — no app CSS vars). */
export const REPORT_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; background: #ffffff; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #2b2f36; font-size: 14.5px; line-height: 1.62;
    -webkit-font-smoothing: antialiased;
  }
  .report { max-width: 780px; margin: 0 auto; padding: 28px 30px 40px; }
  .report > :first-child { margin-top: 0; }
  .rpt-meta { margin: 0 0 18px; padding-bottom: 14px; border-bottom: 1px solid #ececf0; }
  .rpt-title { margin: 0; font-size: 22px; }
  .rpt-sub { margin-top: 4px; font-size: 12.5px; color: #8a9099; }
  h1, h2, h3, h4, h5, h6 { color: #14171c; font-weight: 650; line-height: 1.3; margin: 1.5em 0 0.5em; }
  h1 { font-size: 22px; } h2 { font-size: 18px; } h3 { font-size: 15.5px; } h4, h5, h6 { font-size: 14px; }
  p { margin: 0.7em 0; }
  a { color: #0b62d6; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
  strong { color: #14171c; font-weight: 650; }
  ul, ol { margin: 0.7em 0; padding-left: 1.4em; }
  li { margin: 0.3em 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em; background: #f4f5f7; padding: 0.12em 0.4em; border-radius: 5px; overflow-wrap: anywhere;
  }
  pre {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12.5px; line-height: 1.55; background: #f6f7f9; border: 1px solid #ececf0;
    padding: 13px 15px; border-radius: 9px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0.9em 0;
  }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #e2e4e9; padding: 2px 0 2px 14px; color: #6a7079; margin: 0.9em 0; }
  hr { border: 0; border-top: 1px solid #ececf0; margin: 1.5em 0; }
  table { display: block; width: max-content; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0.9em 0; font-size: 13.5px; }
  th, td { border: 1px solid #e2e4e9; padding: 7px 11px; text-align: left; vertical-align: top; }
  th { background: #f7f8fa; font-weight: 600; color: #14171c; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
`

/**
 * Wrap already-sanitized inner HTML into a full, self-contained styled report
 * document. Pure string concatenation (the inner HTML is trusted sanitizer
 * output; only the front-matter scalars are escaped), so it is safe to hand to a
 * sandboxed iframe `srcDoc`.
 */
export function wrapReportHtml(innerHtml: string, meta?: Record<string, string> | null): string {
  const title = meta?.title
  const sub = [meta?.type, meta?.date].filter(Boolean).map((s) => esc(s as string)).join(' · ')
  const header =
    title || sub
      ? `<header class="rpt-meta">${title ? `<h1 class="rpt-title">${esc(title)}</h1>` : ''}${sub ? `<div class="rpt-sub">${sub}</div>` : ''}</header>`
      : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${REPORT_CSS}</style></head><body><article class="report">${header}${innerHtml}</article></body></html>`
}

/**
 * Markdown/plain text → a full styled HTML report document. Front matter (if any)
 * renders as a calm header; the body goes through the shared sanitizing markdown
 * pipeline. Needs a DOM (the sanitizer), so it runs client-side / under jsdom.
 */
export function markdownToReportDoc(content: string): string {
  const { meta, body } = stripFrontMatter(content)
  return wrapReportHtml(renderMarkdown(body), meta)
}
