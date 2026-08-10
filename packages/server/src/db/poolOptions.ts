/**
 * Pure pool-option derivation for the hosted postgres-js tier. LEAF module by
 * design: no env reads, no DB opens — `db/index.ts` supplies the URL (and the
 * optional `LOOPANY_DB_POOL_MODE` override via `env.ts`), tests import this
 * directly without booting a database.
 */

/**
 * Whether `url` points at a pgBouncer/Supavisor TRANSACTION pooler. Detection
 * is by the conventional port `:6543` (Supabase's transaction-mode port).
 *
 * Why it matters: postgres-js pipelines queries and caches prepared statements
 * per connection, but a transaction pooler reassigns the backend connection per
 * transaction, which both breaks cached prepared statements and is implicated
 * in the pool-wedge failure mode (porsager/postgres#970). Session mode (:5432)
 * pins one backend per client connection, so neither problem exists there.
 *
 * LIMITATION: a nonstandard-port or self-hosted transaction pooler will NOT be
 * detected here — set `LOOPANY_DB_POOL_MODE=transaction` (see `env.ts`
 * `dbPoolMode`) to override. Getting that wrong on a real transaction pooler
 * re-arms the prepared-statement breakage.
 */
export function isTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === "6543";
  } catch {
    return false;
  }
}

/**
 * The full postgres-js option set we pass to `postgres(url, …)`. Deliberately a
 * closed interface — every field is typed, and there is NO `max_pipeline` field:
 * setting `max_pipeline` short-circuits postgres-js's `onexecute` callback,
 * which `sql.begin()` relies on to pin a connection, poisoning connections with
 * `25P02`/`25001` errors (the reverted #133 incident). The wedge fix is moving
 * `DATABASE_URL` to the SESSION pooler, never pipelining tuning. Do not add it.
 */
export interface PoolOptions {
  prepare: boolean;
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  max_lifetime: number;
  connection: { statement_timeout: number };
}

/**
 * Mode-aware pool options:
 *
 *   - TRANSACTION pooler (:6543): `prepare:false` is mandatory — the backend is
 *     reassigned per transaction, so cached prepared statements break.
 *   - SESSION pooler / direct (:5432): the backend is pinned per connection, so
 *     `prepare:true` is safe AND faster (cached plans), and the session-scoped
 *     `statement_timeout` is actually enforced on the executing backend.
 *
 * The shared knobs are the conservative self-healing ring for one always-on
 * machine (see `db/index.ts` + api.health.db.ts for the incident history).
 * Pass `transactionPooler` explicitly to override the port-based detection
 * (the `LOOPANY_DB_POOL_MODE` escape hatch).
 */
/**
 * Runtime pool size. Sized by the POOLER's client cap, not by our concurrency
 * appetite - Supabase's session pooler refuses past `pool_size` (15 on this
 * project) with `EMAXCONNSESSION`, and that budget is shared with the migrator and
 * any ops session.
 *
 * The binding constraint is a RESTART, not steady state. A process killed without a
 * clean shutdown leaves its backends held until TCP keepalive reaps them, while the
 * replacement immediately opens its own, so the worst case is `2*max`. The prestart
 * migrator draws on the same 15 slots (DATABASE_URL and DIRECT_DATABASE_URL both
 * point at the session pooler here) but closes its single connection before the
 * server boots, so it overlaps only the dead process's lingering backends, not the
 * fresh pool. At the old `max: 10` that is 20 against a cap of 15: guaranteed
 * refusals during any restart, which is exactly what the 2026-08-10 crash loop
 * produced (observed 14/15 occupied, with new connections refused).
 *
 * 6 keeps the restart worst case at 12, leaving headroom, and is still well clear of
 * demand: sampling prod once a second for a minute showed 0 active connections in 56
 * of 60 samples, 1 in three, and a peak of 4 - while the pool held all 10 open the
 * entire time (poll traffic keeps round-robining across them, so `idle_timeout` never
 * gets a 30s-quiet connection to reap). Queueing behind a smaller pool costs almost
 * nothing on a single-vCPU box, where the CPU - not the connection count - is the
 * real limit.
 *
 * Override with `LOOPANY_DB_POOL_MAX` (env.ts `dbPoolMax`) when the pooler's own
 * `pool_size` changes; this stays an EXTERNAL constraint, so it must be tunable
 * without a code change.
 */
export const DEFAULT_POOL_MAX = 6;

export function poolOptionsFor(
  url: string,
  transactionPooler: boolean = isTransactionPooler(url),
  max: number = DEFAULT_POOL_MAX,
): PoolOptions {
  return {
    prepare: !transactionPooler,
    max,
    idle_timeout: 30,
    connect_timeout: 15,
    max_lifetime: 60 * 30, // 30 min — retire connections by age so dead sockets drop
    connection: { statement_timeout: 30_000 }, // 30s server-side kill for a hung query (ms)
  };
}
