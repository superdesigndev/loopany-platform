import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { rewriteStoryAssets, stripFrontMatter, templateStory } from './templates'

/**
 * The template field-notes pipeline (`story.md` → the public detail page):
 * front matter (publishing metadata, internal notes) must never render, and
 * `assets/<file>` references must rewrite to the Vite-emitted URLs.
 */
describe('stripFrontMatter', () => {
  test('drops a leading front-matter block, keeps the body', () => {
    const md = '---\nstatus: awaiting-review\nnotes: |\n  internal\n---\n\n# Title\n\nBody.'
    expect(stripFrontMatter(md)).toBe('# Title\n\nBody.')
  })

  test('leaves markdown without front matter untouched (incl. mid-document hr)', () => {
    const md = '# Title\n\n---\n\nBody.'
    expect(stripFrontMatter(md)).toBe(md)
  })

  test('an unterminated block is left as-is rather than eating the document', () => {
    const md = '---\nnever closed'
    expect(stripFrontMatter(md)).toBe(md)
  })
})

describe('rewriteStoryAssets', () => {
  test('rewrites markdown images and raw-HTML src attrs, with or without ./', () => {
    const md = '![before](assets/shot.png) and <video controls src="./assets/demo.mp4"></video>'
    expect(rewriteStoryAssets(md, 'reddit-karma')).toBe(
      '![before](/template-assets/reddit-karma/shot.png) and <video controls src="/template-assets/reddit-karma/demo.mp4"></video>',
    )
  })

  test('non-asset links and absolute URLs are untouched', () => {
    const md = '[doc](https://example.com/assets/x.png) and ![ok](/already/absolute.png)'
    expect(rewriteStoryAssets(md, 'reddit-karma')).toBe(md)
  })
})

describe('templateStory (the real registry)', () => {
  test('reddit-karma ships a story with its front matter stripped', () => {
    const story = templateStory('reddit-karma')
    expect(story).toBeTruthy()
    // The body renders; the publishing metadata and internal notes never do.
    expect(story).toContain('karma grew from -4 to 92 comment karma')
    expect(story).not.toContain('awaiting-review')
  })

  test('the field-notes templates ship a story whose media really exists on disk', () => {
    // Only `public/` is served verbatim by nitro, so every rewritten
    // `/template-assets/<name>/<file>` ref must have a real file behind it — a ref with
    // no file 404s on the public detail page (the 2026-07-29 prod incident).
    const publicRel = '../../public/'
    const publicDir = fileURLToPath(new URL(publicRel, import.meta.url))
    for (const name of ['react-doctor', 'housekeeper', 'docs-sweep', 'error-sweep', 'dependency-triage']) {
      const story = templateStory(name)
      expect(story, name).toBeTruthy()
      // Publishing metadata never renders.
      expect(story, name).not.toContain('awaiting-review')
      const refs = [...(story ?? '').matchAll(/\/template-assets\/[\w.-]+\/[\w.-]+/g)].map((m) => m[0])
      expect(refs.length, `${name} story references at least one asset`).toBeGreaterThan(0)
      for (const ref of refs) {
        expect(existsSync(publicDir + ref.slice(1)), `${name}: ${ref} exists under public/`).toBe(true)
      }
    }
  })

  test('a template without a story returns null', () => {
    expect(templateStory('bug-vigil')).toBeNull()
  })
})
