#!/usr/bin/env node
/**
 * One command for the Graph Engineering v1 local demo:
 *
 *   pnpm graph:demo          build → seed → serve  (http://127.0.0.1:3700/dev/workspace)
 *   pnpm graph:demo --seed   build → seed, then exit (re-seed a running demo's DB
 *                            only when the server is stopped — pglite is single-writer)
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
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedOnly = process.argv.includes('--seed')

const env = {
  ...process.env,
  LOOPANY_DATA_DIR: process.env.LOOPANY_DATA_DIR || path.join(repoRoot, '.graph-demo-data'),
  LOOPANY_PORT: process.env.LOOPANY_PORT || '3700',
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

  step(`seeding the graph demo into ${env.LOOPANY_DATA_DIR}`)
  await run('pnpm', ['--filter', '@loopany/server', 'graph:seed'])

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
