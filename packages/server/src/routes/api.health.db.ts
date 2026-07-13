import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'

/**
 * DB-touching liveness probe — the ONE home for the wedged-pool incident rationale
 * (db/index.ts and the Fly checks point here). Unlike /api/health (which never
 * touches the DB and so reported `ok` right through a ~5.5h outage while a dead
 * postgres-js pool masked it), this runs a trivial `select 1` through the runtime
 * pool.
 *
 * This route SURFACES a wedged pool (Fly's check goes critical, which de-routes the
 * machine); it does NOT by itself recover it. Fly's failing `[http_service.checks]`
 * only pull the machine from load balancing — they never restart the VM (the
 * 2026-07-12 outage: pool wedged, check critical, box down ~9h with no auto-restart
 * until a manual `fly machine restart`). The ACTUAL auto-recovery is the in-process
 * DB watchdog (`server/dbWatchdog.ts`), which exits the process on a sustained wedge
 * so Fly's `restart.policy = "on-failure"` brings up a fresh pool.
 *
 * A wedged pool makes `select 1` HANG (queued behind stuck connections; the pool's
 * `statement_timeout` is unenforced under the Supabase transaction pooler). So the
 * probe races the query against a hard client-side deadline (`PROBE_TIMEOUT_MS`, <
 * Fly's 10s check timeout) and returns a fast 503 instead of eating the full timeout
 * "awaiting headers". 200 → DB reachable; 503 → the query failed or timed out.
 * Drizzle imported inside the handler so it stays out of the client bundle.
 */
const PROBE_TIMEOUT_MS = 5_000

export const Route = createFileRoute('/api/health/db')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { db } = await import('../db/index.js')
          const ping = db.execute(sql`select 1`)
          const timeout = new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error(`db ping timed out after ${PROBE_TIMEOUT_MS}ms`)),
              PROBE_TIMEOUT_MS,
            )
            // Don't let the probe's timer keep the process alive.
            ;(t as { unref?: () => void }).unref?.()
          })
          await Promise.race([ping, timeout])
          return Response.json({ ok: true, db: 'up' })
        } catch (err) {
          return Response.json(
            { ok: false, db: 'down', error: err instanceof Error ? err.message : String(err) },
            { status: 503 },
          )
        }
      },
    },
  },
})
