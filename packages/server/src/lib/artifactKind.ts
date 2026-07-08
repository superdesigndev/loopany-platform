/**
 * Pure classification of a synced artifact by its path extension, shared by the
 * in-browser viewer (`artifactView.tsx`) and the byte-serving route
 * (`api.artifact.$loopId.$.ts`). No I/O, no React - just the display kind and the
 * safe image MIME allowlist, so the two surfaces can't drift on what renders how.
 *
 * The kinds map to how the viewer renders each type:
 *  - `image`  - served from the hardened inline route and shown via <img>, NEVER
 *               inlined into the app DOM (SVG is scriptable, so it rides as an
 *               image too - <img> does not execute embedded scripts).
 *  - `html`   - rendered in a strict sandboxed iframe (no allow-same-origin), so
 *               user-synced markup is isolated from the app's session/origin.
 *  - `markdown` - rendered as formatted prose (the shared markdown pipeline).
 *  - `text`   - shown as monospace source.
 */

export type ArtifactKind = 'image' | 'html' | 'markdown' | 'text'

/** Extension → MIME for the image types we serve inline. This is an ALLOWLIST:
 *  the route serves an inline content-type only for these, everything else stays
 *  a download. SVG is included but is only ever rendered via <img> (never inline
 *  markup) and served with a sandbox CSP so a direct navigation can't script. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Lowercased file extension without the dot (`''` when the path has none). */
export function ext(path: string): string {
  return (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
}

/** The safe inline image MIME for this path, or null when it isn't a known image. */
export function imageMime(path: string): string | null {
  return IMAGE_MIME[ext(path)] ?? null
}

export const isImagePath = (path: string): boolean => imageMime(path) !== null
export const isHtmlPath = (path: string): boolean => ext(path) === 'html' || ext(path) === 'htm'
export const isMarkdownPath = (path: string): boolean => ext(path) === 'md' || ext(path) === 'markdown'

/** The display kind for one artifact path (extension only - the bytes decide
 *  binary-ness elsewhere; here we only pick the RENDERER). */
export function artifactKind(path: string): ArtifactKind {
  if (isImagePath(path)) return 'image'
  if (isHtmlPath(path)) return 'html'
  if (isMarkdownPath(path)) return 'markdown'
  return 'text'
}
