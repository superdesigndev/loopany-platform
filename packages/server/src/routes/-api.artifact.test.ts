/**
 * The session-authed artifact download route. Exercises the GET handler directly:
 *  - the input-validation paths that settle BEFORE the dynamic store/auth imports
 *    (so no DB is touched): a malformed percent-encoded loop id must be a clean
 *    400 - `decodeURIComponent` throws a URIError on bad encoding, which used to
 *    escape the handler as a 500;
 *  - the disposition branches (store/auth/bytes mocked): `?view=inline` on a KNOWN
 *    image serves the real image content-type with `inline` + the hardening
 *    headers (nosniff + `Content-Security-Policy: sandbox`); everything else - and
 *    an inline request for a NON-image - stays an `attachment` download.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { Route } from './api.artifact.$loopId.$'

const GET = (Route as any).options.server.handlers.GET as (ctx: {
  request: Request
}) => Response | Promise<Response>

const call = (pathname: string) =>
  GET({ request: new Request(`http://localhost:3000${pathname}`) })

describe('/api/artifact/$loopId/$', () => {
  test('malformed percent-encoding in the loop id → 400, not a thrown 500', async () => {
    const res = await call('/api/artifact/%zz/report.md')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad loop id' })
  })

  test('a lone trailing % in the loop id → 400', async () => {
    const res = await call('/api/artifact/loop-1%/report.md')
    expect(res.status).toBe(400)
  })

  test('malformed percent-encoding in a path segment → 400 (same policy as the loop id)', async () => {
    const res = await call('/api/artifact/loop-1/data/%zz.json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad path' })
  })

  test('missing file path → 400', async () => {
    const res = await call('/api/artifact/loop-1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing path' })
  })
})

// ---- disposition branches (store/auth/bytes mocked) ----

const bytes = Buffer.from([1, 2, 3, 4])
const readBytes = vi.fn()

vi.mock('../db/store.js', () => ({ getLoop: vi.fn(async () => ({ id: 'loop-1', teamId: 'team-1' })) }))
vi.mock('../auth.js', () => ({ requestScope: vi.fn(async () => ({})), canAccessLoop: vi.fn(async () => true) }))
vi.mock('../server/artifactFiles.js', () => ({ readLoopArtifactBytes: (...a: unknown[]) => readBytes(...a) }))

describe('/api/artifact/$loopId/$ dispositions', () => {
  beforeEach(() => {
    readBytes.mockReset()
    readBytes.mockResolvedValue({ status: 200, bytes, binary: true, filename: 'pic.png' })
  })

  test('?view=inline on a png → inline image content-type + hardening headers', async () => {
    const res = await call('/api/artifact/loop-1/pic.png?view=inline')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // The load-bearing isolation for a direct navigation to a scripted SVG/HTML.
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('svg inline is served as an image (via <img>), hardened by the sandbox CSP', async () => {
    readBytes.mockResolvedValue({ status: 200, bytes, binary: false, filename: 'd.svg' })
    const res = await call('/api/artifact/loop-1/d.svg?view=inline')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })

  test('inline requested for a NON-image → stays an attachment download', async () => {
    readBytes.mockResolvedValue({ status: 200, bytes, binary: false, filename: 'a.html' })
    const res = await call('/api/artifact/loop-1/a.html?view=inline')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  test('default (no view) → attachment, unchanged', async () => {
    const res = await call('/api/artifact/loop-1/pic.png')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })
})
