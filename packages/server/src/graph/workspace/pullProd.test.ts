import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveProdUrl } from './pull-prod'
import { resolveR2 } from './fetch-bodies'

/**
 * `pull-prod.ts` is the ONLY module in this repo that opens a connection to the
 * production database. Its read-only posture is therefore not a style
 * preference - it is the safety property, and this suite is what keeps it true
 * as the file changes.
 *
 * The source guard keeps its path in a VARIABLE on purpose: Vite statically
 * rewrites the literal `new URL('./x.ts', import.meta.url)` form into an asset
 * URL, which `fileURLToPath` then rejects (see AGENTS.md "Web UI gotchas").
 */
const rel = './pull-prod.ts'
const SOURCE = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const relBodies = './fetch-bodies.ts'
const BODIES_RAW = readFileSync(fileURLToPath(new URL(relBodies, import.meta.url)), 'utf8')
/** Comments explain the posture by NAMING what is forbidden, so the guard has to
 *  read the code alone - exactly the trap the SQL guard below already avoids. */
const BODIES = stripComments(BODIES_RAW)

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the production pull is read-only by construction', () => {
  it('pins the session read-only at the server', () => {
    expect(SOURCE).toContain('default_transaction_read_only=on')
  })

  it('runs every statement inside a read-only transaction', () => {
    expect(SOURCE).toContain('sql.begin("read only"')
  })

  it('contains no write or DDL statement of any kind', () => {
    // Comments and prose are stripped first so the words in the module header
    // ("never write, never DDL") cannot mask a real statement appearing later.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of [
      /\binsert\s+into\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+(table|index|schema)\b/i,
      /\balter\s+table\b/i,
      /\btruncate\b/i,
      /\bcreate\s+(table|index|schema)\b/i,
      /\bgrant\b/i,
      /\bcopy\b/i,
    ]) {
      expect(code).not.toMatch(forbidden)
    }
  })

  it('writes its output only to the local snapshot file', () => {
    // The single filesystem write in the pull path is the snapshot; anything
    // else would mean this module grew a second output.
    expect(SOURCE).toContain('prod-snapshot.json')
    expect(SOURCE).not.toContain('writeFileSync')
  })
})

describe('resolveProdUrl', () => {
  const saved = { url: process.env.LOOPANY_PROD_DB_URL, file: process.env.LOOPANY_PROD_ENV_FILE }
  afterEach(() => {
    if (saved.url === undefined) delete process.env.LOOPANY_PROD_DB_URL
    else process.env.LOOPANY_PROD_DB_URL = saved.url
    if (saved.file === undefined) delete process.env.LOOPANY_PROD_ENV_FILE
    else process.env.LOOPANY_PROD_ENV_FILE = saved.file
  })

  it('prefers an explicit env var', () => {
    process.env.LOOPANY_PROD_DB_URL = 'postgres://explicit/db'
    expect(resolveProdUrl(() => 'LOOPANY_DB_URL=postgres://file/db')).toBe('postgres://explicit/db')
  })

  it('reads the LOOPANY_DB_URL line out of the admin env file', () => {
    delete process.env.LOOPANY_PROD_DB_URL
    expect(resolveProdUrl(() => 'OTHER=1\nLOOPANY_DB_URL="postgres://file/db"\n')).toBe('postgres://file/db')
  })

  it('fails with actionable guidance when there is no source at all', () => {
    delete process.env.LOOPANY_PROD_DB_URL
    expect(() =>
      resolveProdUrl(() => {
        throw new Error('ENOENT')
      }),
    ).toThrow(/LOOPANY_PROD_DB_URL/)
    expect(() => resolveProdUrl(() => 'NOTHING=1')).toThrow(/no LOOPANY_DB_URL entry/)
  })
})

describe('the artifact-body fetch is read-only by construction', () => {
  it('imports exactly one S3 command, and it is a read', () => {
    const commands = [...BODIES.matchAll(/\b([A-Z][A-Za-z]*Command)\b/g)].map((m) => m[1])
    expect([...new Set(commands)]).toEqual(['GetObjectCommand'])
  })

  it('never reaches for a write operation', () => {
    for (const forbidden of [
      /PutObject/,
      /DeleteObject/,
      /CreateMultipartUpload/,
      /UploadPart/,
      /CopyObject/,
      /PutBucket/,
    ]) {
      expect(BODIES).not.toMatch(forbidden)
    }
  })

  it('does not hold a store handle that can write', () => {
    // `R2BlobStore` carries put/delete; a read-only job must not construct one.
    expect(BODIES).not.toMatch(/R2BlobStore/)
  })

  it('takes the object layout from the server, not a second copy of the string', () => {
    expect(BODIES_RAW).toContain('import { blobKey }')
    // The literal key prefix must appear only in blobstore.ts.
    expect(BODIES).not.toMatch(/["'`]blobs\//)
  })

  it('caches beside the demo database and refuses to guess a location', () => {
    expect(BODIES).toContain('LOOPANY_DATA_DIR is unset')
  })
})

describe('resolveR2', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of ['LOOPANY_R2_BUCKET', 'LOOPANY_R2_ACCESS_KEY_ID', 'LOOPANY_R2_SECRET_ACCESS_KEY', 'LOOPANY_R2_ACCOUNT_ID', 'LOOPANY_R2_ENV_FILE', 'LOOPANY_R2_ENDPOINT']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('derives the R2 endpoint from the account id', () => {
    process.env.LOOPANY_R2_ENV_FILE = '/tmp/does-not-matter'
    delete process.env.LOOPANY_R2_ENDPOINT
    const creds = resolveR2(
      () => 'LOOPANY_R2_BUCKET=b\nLOOPANY_R2_ACCESS_KEY_ID=k\nLOOPANY_R2_SECRET_ACCESS_KEY=s\nLOOPANY_R2_ACCOUNT_ID=acct\n',
    )
    expect(creds.endpoint).toBe('https://acct.r2.cloudflarestorage.com')
    expect(creds.region).toBe('auto')
    expect(creds.bucket).toBe('b')
  })

  it('fails loudly rather than half-configured', () => {
    process.env.LOOPANY_R2_ENV_FILE = '/tmp/does-not-matter'
    for (const k of ['LOOPANY_R2_BUCKET', 'LOOPANY_R2_ACCESS_KEY_ID', 'LOOPANY_R2_SECRET_ACCESS_KEY', 'LOOPANY_R2_ACCOUNT_ID', 'LOOPANY_R2_ENDPOINT']) delete process.env[k]
    expect(() => resolveR2(() => 'LOOPANY_R2_BUCKET=b\n')).toThrow(/incomplete R2 credentials/)
  })
})
