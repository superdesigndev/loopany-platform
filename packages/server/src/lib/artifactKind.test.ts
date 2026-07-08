import { describe, expect, it } from 'vitest'
import { artifactKind, ext, imageMime, isHtmlPath, isImagePath, isMarkdownPath } from './artifactKind'

describe('artifactKind', () => {
  it('classifies images (incl. svg) by extension, case-insensitively', () => {
    for (const p of ['a.png', 'dir/b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.SVG', 'g.avif', 'h.bmp', 'i.ico']) {
      expect(artifactKind(p)).toBe('image')
      expect(isImagePath(p)).toBe(true)
    }
  })

  it('classifies html/htm as html', () => {
    expect(artifactKind('reports/2026-07-07-run-lifecycle.html')).toBe('html')
    expect(artifactKind('x.HTM')).toBe('html')
    expect(isHtmlPath('a.html')).toBe(true)
  })

  it('classifies markdown', () => {
    expect(artifactKind('notes/a.md')).toBe('markdown')
    expect(artifactKind('b.markdown')).toBe('markdown')
    expect(isMarkdownPath('c.MD')).toBe(true)
  })

  it('falls back to text for everything else', () => {
    for (const p of ['data.json', 'log.txt', 'noext', 'a.csv', 'weird.']) {
      expect(artifactKind(p)).toBe('text')
      expect(isImagePath(p)).toBe(false)
    }
  })

  it('maps only the allowlisted image types to a MIME, else null', () => {
    expect(imageMime('a.png')).toBe('image/png')
    expect(imageMime('a.jpg')).toBe('image/jpeg')
    expect(imageMime('a.jpeg')).toBe('image/jpeg')
    expect(imageMime('a.svg')).toBe('image/svg+xml')
    expect(imageMime('a.webp')).toBe('image/webp')
    // Not an image → no inline MIME (the route keeps it a download).
    expect(imageMime('a.html')).toBeNull()
    expect(imageMime('a.md')).toBeNull()
    expect(imageMime('a.exe')).toBeNull()
  })

  it('ext lowercases and tolerates no-extension paths', () => {
    expect(ext('A.PNG')).toBe('png')
    expect(ext('no-ext')).toBe('')
    expect(ext('dir.with.dots/file')).toBe('')
  })
})
