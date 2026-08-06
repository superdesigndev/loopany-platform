import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DOC_SANDBOX } from './Render'

/**
 * Source-reading guards for the two rendering rules design §7 states as
 * absolutes. Both are the kind of rule a well-meaning refactor quietly breaks —
 * "just add rehype-raw so the doc renders", "add allow-same-origin so the iframe
 * can size itself" — and neither failure is visible on screen.
 *
 * NB the path must stay in a VARIABLE: Vite statically rewrites the LITERAL
 * `new URL('./x', import.meta.url)` form into an asset URL, which
 * `fileURLToPath` then rejects.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Source with comments removed. The rules below are about what the CODE does;
 *  the prose explaining them naturally names the very things they forbid. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every workspace module except the guards themselves. */
function workspaceSources(): [string, string][] {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
    .map((name) => [name, stripComments(readFileSync(`${dir}${name}`, 'utf8'))])
}

describe('markdown never renders raw HTML', () => {
  it('imports no raw-HTML rehype plugin anywhere in the workspace', () => {
    for (const [file, source] of workspaceSources()) {
      expect(source, `${file} must not enable raw HTML in markdown`).not.toMatch(/rehype-raw|rehypeRaw/)
    }
  })

  it('renders no body through dangerouslySetInnerHTML — the sandboxed iframe is the only HTML door', () => {
    for (const [file, source] of workspaceSources()) {
      expect(source, `${file} must not inject HTML into the app DOM`).not.toMatch(/dangerouslySetInnerHTML/)
    }
  })
})

describe('the html doc sandbox is opaque-origin', () => {
  it('allows scripts and nothing else', () => {
    expect(DOC_SANDBOX).toBe('allow-scripts')
  })

  it('never carries allow-same-origin — together with allow-scripts that is no sandbox at all', () => {
    expect(DOC_SANDBOX).not.toContain('allow-same-origin')
    for (const [file, source] of workspaceSources()) {
      expect(source, `${file} must not widen the doc sandbox`).not.toMatch(/allow-same-origin/)
    }
  })

  it('the iframe is fed by srcDoc, so the markup never becomes a same-origin document URL', () => {
    const source = read('./Render.tsx')
    expect(source).toMatch(/<iframe[^>]*sandbox=\{DOC_SANDBOX\}/s)
    expect(source).toMatch(/srcDoc=\{srcDoc\}/)
  })
})

describe('every view endpoint is owner-only', () => {
  it('resolves its context with the owner-authority requirement', () => {
    const routes = fileURLToPath(new URL('../../routes/', import.meta.url))
    const files = readdirSync(routes).filter((name) => name.startsWith('api.views.'))
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const file of files) {
      const source = readFileSync(`${routes}${file}`, 'utf8')
      expect(source, `${file} must gate on owner authority`).toMatch(/resolveApiContext\(request, "owner"\)/)
    }
  })
})
