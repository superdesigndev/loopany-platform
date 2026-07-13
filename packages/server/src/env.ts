import os from "node:os";
import path from "node:path";

/**
 * Loopany server data directory — server-side file state, and (for the embedded
 * pglite tier) the on-disk Postgres data dir at `<dataDir>/pgdata`. Locally it
 * defaults to `~/.loopany`. Override with `LOOPANY_DATA_DIR`. The HOSTED tier
 * (DATABASE_URL set) is stateless and never touches this.
 */
export function dataDir(): string {
  return process.env.LOOPANY_DATA_DIR?.trim() || path.join(os.homedir(), ".loopany");
}

/**
 * Supabase (or any Postgres) connection string for the RUNTIME app process. When
 * set, the server uses the postgres-js driver (hosted prod/staging). Pool options
 * are MODE-AWARE (`db/poolOptions.ts`): a Supabase TRANSACTION pooler URL
 * (`:6543`) gets `prepare:false`; a SESSION pooler / direct URL (`:5432`) gets
 * `prepare:true` (backend pinned per connection — safe and faster). Either form
 * is supported; `dbPoolMode()` below overrides the port-based detection.
 * When UNSET, the server falls back to the embedded, file-backed pglite database
 * at `<dataDir>/pgdata` (local dev + light self-host + tests) — zero external DB.
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}

/**
 * Explicit pool-mode override for the runtime postgres-js pool
 * (`LOOPANY_DB_POOL_MODE=transaction|session`). Normally UNSET — the mode is
 * detected from `DATABASE_URL`'s port (`:6543` ⇒ transaction pooler; see
 * `db/poolOptions.ts` `isTransactionPooler`). This is the escape hatch for a
 * NONSTANDARD-PORT or self-hosted pooler the port heuristic can't classify.
 * Getting it wrong on a real transaction pooler (`session` when the pooler is
 * transaction-mode) re-arms the prepared-statement breakage the detection
 * exists to prevent — set it only when you know the pooler's mode.
 */
export function dbPoolMode(): "transaction" | "session" | undefined {
  const raw = process.env.LOOPANY_DB_POOL_MODE?.trim().toLowerCase();
  if (raw === "transaction" || raw === "session") return raw;
  return undefined;
}

/**
 * Direct (session-mode, `:5432`) Postgres URL used ONLY for migrations — DDL and
 * the migrator's advisory lock must NOT go through the transaction pooler. Falls
 * back to `DATABASE_URL` when unset (e.g. a plain non-pooled Postgres).
 *
 * Fails LOUD when that fallback would silently route DDL/advisory-lock traffic
 * over a Supabase transaction pooler: the pooler multiplexes connections and
 * cannot hold the session-scoped advisory lock the migrator relies on, so a
 * migration over `:6543` deadlocks or corrupts. A plain non-pooled Postgres URL
 * as the fallback stays allowed.
 */
export function directDatabaseUrl(): string | undefined {
  const explicit = process.env.DIRECT_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const fallback = databaseUrl();
  if (fallback && (fallback.includes(":6543") || fallback.includes("pooler.supabase.com"))) {
    throw new Error(
      "DIRECT_DATABASE_URL is unset but DATABASE_URL points at the Supabase transaction pooler " +
        "(:6543 / pooler.supabase.com) — set DIRECT_DATABASE_URL to the direct (:5432, session-mode) " +
        "connection so migrations run off the pooler",
    );
  }
  return fallback;
}

/**
 * Cloudflare R2 (S3-compatible) credentials for the artifact blob store. Read
 * from env so credentials are never hardcoded; absent ⇒ the blob store falls
 * back to an in-memory implementation (dev/test — no network, no creds). The
 * endpoint defaults to R2's account-scoped host when only the account id is set.
 */
export interface R2Config {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores region but the S3 client requires one; "auto" is R2's convention. */
  region: string;
}

export function r2Config(): R2Config | null {
  const accountId = process.env.LOOPANY_R2_ACCOUNT_ID?.trim();
  const bucket = process.env.LOOPANY_R2_BUCKET?.trim();
  const accessKeyId = process.env.LOOPANY_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.LOOPANY_R2_SECRET_ACCESS_KEY?.trim();
  const endpoint =
    process.env.LOOPANY_R2_ENDPOINT?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return { bucket, endpoint, accessKeyId, secretAccessKey, region: process.env.LOOPANY_R2_REGION?.trim() || "auto" };
}

/**
 * Artifact-storage retention / GC knobs (see gateway/retention.ts). Read lazily
 * from env at call time (not at module load) so tests can set them per-case and
 * a deploy can tune them without a rebuild. Each has a safe, generous default —
 * the bias is "keep storage bounded without ever surprising a healthy loop".
 */

/** A positive env integer, or `fallback` when unset / unparseable / non-positive. */
function posIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-loop total stored-bytes cap. Once a loop's live (byte-backed) artifact
 * footprint reaches this, the sync stops accepting NEW bytes for that loop (it
 * still reconciles deletions and already-stored files) and surfaces the cap —
 * mirroring how the per-file 10MB cap surfaces oversize. Generous default so a
 * normal loop folder never hits it; a runaway growing folder does. 500MB.
 */
export function loopBytesCap(): number {
  return posIntEnv("LOOPANY_LOOP_BYTES_CAP", 500 * 1024 * 1024);
}

/**
 * How many of the most recent run snapshots to keep per loop. Older ones are
 * pruned (their now-unreferenced blobs then become GC-collectable). The per-run
 * diff only needs the immediately-prior snapshot, so 20 keeps ample history for
 * the "Changes" view while bounding the table + blob retention. Default 20.
 */
export function snapshotRetention(): number {
  return posIntEnv("LOOPANY_SNAPSHOT_RETENTION", 20);
}

/**
 * GC grace window: a blob whose metadata row is younger than this is NEVER
 * collected, even if currently unreferenced. This is the concurrency guard —
 * a blob a sync just wrote (and is about to reference) can't be swept out from
 * under it. Generous default (1h) since a leaked blob is only a cost bug that
 * the next GC pass reclaims anyway. Default 3,600,000ms (1 hour).
 */
export function blobGcGraceMs(): number {
  return posIntEnv("LOOPANY_BLOB_GC_GRACE_MS", 60 * 60 * 1000);
}

/**
 * How often the periodic storage-maintenance pass runs (prune snapshots → GC
 * blobs). Default 15 minutes. Kept independent of the faster offline-sweep tick.
 */
export function gcIntervalMs(): number {
  return posIntEnv("LOOPANY_GC_INTERVAL_MS", 15 * 60 * 1000);
}

/**
 * DB watchdog (`server/dbWatchdog.ts`) — the ACTUAL auto-recovery backstop for a
 * wedged postgres-js pool. Fly's `[http_service.checks]` failing only pulls the
 * machine from load balancing; it never restarts the VM (the 2026-07-12 outage:
 * the pool wedged, `/api/health/db` hung, the check went critical, and the box
 * stayed down ~9h with no auto-restart). The watchdog turns a HANG into a process
 * EXIT so Fly's `restart.policy = "on-failure"` kicks in with a fresh pool.
 *
 * Enabled by default ONLY on the hosted postgres tier (a wedged transaction-pooler
 * connection is the failure mode); OFF for the embedded pglite tier and under
 * vitest (a test must never `process.exit`). Force either way with
 * `LOOPANY_DB_WATCHDOG=on|off`.
 */
export function dbWatchdogEnabled(): boolean {
  const raw = process.env.LOOPANY_DB_WATCHDOG?.trim().toLowerCase();
  if (raw === "on") return true;
  if (raw === "off") return false;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
  return Boolean(databaseUrl());
}

/** How often the DB watchdog pings `select 1`. Default 20s. */
export function dbWatchdogIntervalMs(): number {
  return posIntEnv("LOOPANY_DB_WATCHDOG_INTERVAL_MS", 20_000);
}

/** Hard per-ping deadline; a ping that exceeds it counts as a failure. Default 5s. */
export function dbWatchdogTimeoutMs(): number {
  return posIntEnv("LOOPANY_DB_WATCHDOG_TIMEOUT_MS", 5_000);
}

/**
 * Consecutive failed/timed-out pings before the watchdog exits the process. A
 * healthy ping resets the counter, so this only trips on a SUSTAINED wedge — a
 * brief blip never restarts the box. Default 3 (≈60-75s to detect at 20s cadence).
 */
export function dbWatchdogFailureThreshold(): number {
  return posIntEnv("LOOPANY_DB_WATCHDOG_FAILURES", 3);
}

/**
 * Self-schedule cadence floors — enforced ONLY on the RUN self-schedule path (a
 * run using `set-cron` / `reschedule` on itself). The owner's `editLoop` path is
 * unlimited. A run may not set a cron whose adjacent fires are closer than
 * `LOOPANY_SELF_CRON_FLOOR_MINUTES` (default 15), nor reschedule sooner than
 * `LOOPANY_SELF_RESCHEDULE_FLOOR_MINUTES` (default 5). Lazy env reads like the
 * other knobs, so tests set them per-case.
 */
export function selfCronFloorMinutes(): number {
  return posIntEnv("LOOPANY_SELF_CRON_FLOOR_MINUTES", 15);
}

export function selfRescheduleFloorMinutes(): number {
  return posIntEnv("LOOPANY_SELF_RESCHEDULE_FLOOR_MINUTES", 5);
}
