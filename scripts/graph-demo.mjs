#!/usr/bin/env node
/**
 * One command for the Graph Engineering v1 local demo:
 *
 *   pnpm graph:demo              build → seed → serve  (http://127.0.0.1:3700/dev/workspace)
 *   pnpm graph:demo --seed       build → seed, then exit (re-seed a running demo's DB
 *                                only when the server is stopped — pglite is single-writer)
 *   pnpm graph:demo --synthetic  use the hand-built fleet instead of the real snapshot
 *   pnpm graph:pr <repo> <n>     register a REAL pull request + a merge review
 *   pnpm graph:dispatch          stage an approvable agent task (the runs bridge)
 *   pnpm graph:schedule -- --every 2m
 *                               ARM a cadence, so the clock fires it with nobody
 *                               watching (the clock shadow)
 *   pnpm graph:pull              READ-ONLY snapshot of the real production fleet
 *   pnpm graph:bodies            READ-ONLY fetch of those artifacts' real bytes
 *
 * The DEFAULT dataset is the REAL production fleet, replayed from the local
 * snapshot `pnpm graph:pull` writes. With no snapshot on disk the seeder stops
 * and tells you which of the two commands you want — it never silently falls
 * back to synthetic data, because "is this the real fleet?" must never be a
 * guess.
 *
 * Why a script and not a shell one-liner:
 *
 *  - the demo runs on its OWN database (`.graph-demo-data/pgdata`, gitignored), so
 *    it never touches `~/.loopany` and a `git clean` resets it completely;
 *  - `LOOPANY_DATA_DIR` has to be ABSOLUTE, because pnpm runs each child with the
 *    package directory as its cwd;
 *  - the embedded pglite tier is SINGLE-WRITER, so the seeder has to be its own
 *    process that exits before the dev server opens the same data dir;
 *  - `@loopany/artifact-format` is consumed through its `dist` entry, so it is
 *    built first (the demo parses and renders real artifact files with it).
 *
 * Port 3700 is deliberate: the review environments on 3000/3001/3004/3200/3400/
 * 3500/3611 must not be disturbed. Override with `LOOPANY_PORT`.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedOnly = process.argv.includes('--seed')
const synthetic = process.argv.includes('--synthetic')
const pullOnly = process.argv.includes('--pull')
const bodiesOnly = process.argv.includes('--bodies')
const prOnly = process.argv.includes('--pr')
const dispatchOnly = process.argv.includes('--dispatch')
const scheduleOnly = process.argv.includes('--schedule')

const env = {
  ...process.env,
  LOOPANY_DATA_DIR: process.env.LOOPANY_DATA_DIR || path.join(repoRoot, '.graph-demo-data'),
  LOOPANY_PORT: process.env.LOOPANY_PORT || '3700',
  // Artifact-store credentials for the read-only body fetch. Loaded from a file
  // the operator points at; nothing is copied into the repo.
  LOOPANY_R2_ENV_FILE:
    process.env.LOOPANY_R2_ENV_FILE ||
    path.join(os.homedir(), 'Workspace', 'firstmate', 'data', 'graph-v1-local-demo', 'r2.env'),
  // The demo is the embedded tier by construction: a DATABASE_URL inherited from
  // a shell would silently seed a real Postgres.
  DATABASE_URL: '',
}
delete env.DATABASE_URL

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} → exit ${code}`))))
  })
}

const step = (msg) => process.stdout.write(`\n▸ ${msg}\n`)

try {
  step('building @loopany/artifact-format (the server imports its dist)')
  await run('pnpm', ['--filter', '@loopany/artifact-format', 'build'])

  if (pullOnly) {
    // The pull writes its snapshot next to the demo database, never into
    // `~/.loopany` (the live daemon's home) - that is why it runs through here
    // and not as a bare package script.
    step('pulling a READ-ONLY snapshot of the production fleet')
    await run('pnpm', ['--filter', '@loopany/server', 'graph:pull', '--', ...process.argv.slice(2).filter((a) => a !== '--pull')])
    process.exit(0)
  }

  if (bodiesOnly) {
    step("fetching the artifacts' real bytes (read-only)")
    await run('pnpm', ['--filter', '@loopany/server', 'graph:bodies'])
    process.exit(0)
  }

  if (prOnly) {
    // Registers a REAL pull request as a mirror and opens a merge review on it.
    // Routed through here for the same reason the seeder is: it must write the
    // DEMO's database, and pglite is single-writer - stop the server first.
    step('registering a pull request in the demo workspace')
    await run('pnpm', [
      '--filter',
      '@loopany/server',
      'graph:pr',
      '--',
      ...process.argv.slice(2).filter((a) => a !== '--pr'),
    ])
    process.exit(0)
  }

  if (dispatchOnly) {
    // Stages an approvable `agent-task` - the runs bridge's own starting shape.
    // Routed through here for the same reason the seeder and `--pr` are: it must
    // write the DEMO's database, and pglite is single-writer - stop the server first.
    step('staging an agent task in the demo workspace')
    await run('pnpm', [
      '--filter',
      '@loopany/server',
      'graph:dispatch',
      '--',
      ...process.argv.slice(2).filter((a) => a !== '--dispatch'),
    ])
    process.exit(0)
  }

  if (scheduleOnly) {
    // Arms a cadence - the deliberate act that makes a schedule live. Routed
    // through here for the same reason as the seeder and `--dispatch`: it writes
    // the DEMO's database, and pglite is single-writer, so stop the server first.
    step('arming a cadence in the demo workspace')
    await run('pnpm', [
      '--filter',
      '@loopany/server',
      'graph:schedule',
      '--',
      ...process.argv.slice(2).filter((a) => a !== '--schedule'),
    ])
    process.exit(0)
  }

  step(`seeding the graph demo into ${env.LOOPANY_DATA_DIR}${synthetic ? ' (synthetic fleet)' : ''}`)
  await run('pnpm', ['--filter', '@loopany/server', 'graph:seed', ...(synthetic ? ['--', '--synthetic'] : [])])

  if (seedOnly) {
    process.stdout.write('\nseed complete.\n')
    process.exit(0)
  }

  step(`serving http://127.0.0.1:${env.LOOPANY_PORT}/dev/workspace`)
  await run('pnpm', ['--filter', '@loopany/server', 'dev'])
} catch (err) {
  process.stderr.write(`\ngraph demo failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
