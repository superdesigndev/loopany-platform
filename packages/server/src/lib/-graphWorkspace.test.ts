import { afterEach, describe, expect, test } from 'vitest'

import {
  graphWorkspaceEnabled,
  graphWorkspaceLocalDev,
  graphWorkspaceRequiresLogin,
  graphSeedTokenMatches,
  mayViewGraphWorkspace,
} from './graphWorkspace'

/**
 * The workspace serves real customer content, so its allowlist inverts the
 * app-wide rule: empty means NO ONE, never "everyone". These cases are the
 * whole reason the module exists — an unset variable must not be able to widen
 * the audience.
 */
const KEYS = [
  'NODE_ENV',
  'LOOPANY_GRAPH_SEED_TOKEN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'LOOPANY_GRAPH_WORKSPACE',
  'LOOPANY_GRAPH_WORKSPACE_LOGINS',
  'LOOPANY_ALLOWED_LOGINS',
] as const

const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k] as string
  }
})

/** Put the process in the shape a deployed, gated server has. */
function deployed() {
  process.env.NODE_ENV = 'production'
  process.env.GITHUB_CLIENT_ID = 'id'
  process.env.GITHUB_CLIENT_SECRET = 'secret'
}

describe('graph workspace access policy', () => {
  test('local dev is open and needs no configuration', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET
    expect(graphWorkspaceLocalDev()).toBe(true)
    expect(graphWorkspaceEnabled()).toBe(true)
    expect(graphWorkspaceRequiresLogin()).toBe(false)
    expect(mayViewGraphWorkspace(null)).toBe(true)
  })

  test('a deployed build is off until explicitly enabled', () => {
    deployed()
    delete process.env.LOOPANY_GRAPH_WORKSPACE
    expect(graphWorkspaceEnabled()).toBe(false)
    process.env.LOOPANY_GRAPH_WORKSPACE = 'on'
    expect(graphWorkspaceEnabled()).toBe(true)
    expect(graphWorkspaceRequiresLogin()).toBe(true)
  })

  test('an EMPTY allowlist serves no one, even a signed-in user', () => {
    deployed()
    process.env.LOOPANY_GRAPH_WORKSPACE = 'on'
    delete process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS
    delete process.env.LOOPANY_ALLOWED_LOGINS
    expect(mayViewGraphWorkspace('anyone@example.com')).toBe(false)
    expect(mayViewGraphWorkspace(null)).toBe(false)
  })

  test('admits exactly the listed addresses', () => {
    deployed()
    process.env.LOOPANY_GRAPH_WORKSPACE = 'on'
    process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS = 'a@example.com, B@Example.com'
    expect(mayViewGraphWorkspace('a@example.com')).toBe(true)
    expect(mayViewGraphWorkspace('b@example.com')).toBe(true)
    expect(mayViewGraphWorkspace('c@example.com')).toBe(false)
    // A near-miss on the domain must not slip through.
    expect(mayViewGraphWorkspace('a@example.com.evil.com')).toBe(false)
  })

  test('supports a domain wildcard, in both spellings', () => {
    deployed()
    process.env.LOOPANY_GRAPH_WORKSPACE = 'on'
    process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS = '*@team.dev'
    expect(mayViewGraphWorkspace('someone@team.dev')).toBe(true)
    expect(mayViewGraphWorkspace('someone@other.dev')).toBe(false)
    process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS = '@team.dev'
    expect(mayViewGraphWorkspace('someone@team.dev')).toBe(true)
  })

  test('falls back to the app-wide allowlist, but never to its empty=anyone rule', () => {
    deployed()
    process.env.LOOPANY_GRAPH_WORKSPACE = 'on'
    delete process.env.LOOPANY_GRAPH_WORKSPACE_LOGINS
    process.env.LOOPANY_ALLOWED_LOGINS = 'ops@team.dev'
    expect(mayViewGraphWorkspace('ops@team.dev')).toBe(true)
    expect(mayViewGraphWorkspace('other@team.dev')).toBe(false)
  })
})

describe('the operator seed token', () => {
  test('never matches when unset — an absent secret authorizes nothing', () => {
    delete process.env.LOOPANY_GRAPH_SEED_TOKEN
    expect(graphSeedTokenMatches('Bearer anything')).toBe(false)
    expect(graphSeedTokenMatches(null)).toBe(false)
    expect(graphSeedTokenMatches('Bearer ')).toBe(false)
  })

  test('matches the exact token, with or without the Bearer prefix', () => {
    process.env.LOOPANY_GRAPH_SEED_TOKEN = 's3cret-value'
    expect(graphSeedTokenMatches('Bearer s3cret-value')).toBe(true)
    expect(graphSeedTokenMatches('s3cret-value')).toBe(true)
    expect(graphSeedTokenMatches('Bearer s3cret-valu')).toBe(false)
    expect(graphSeedTokenMatches('Bearer S3CRET-VALUE')).toBe(false)
    delete process.env.LOOPANY_GRAPH_SEED_TOKEN
  })
})
