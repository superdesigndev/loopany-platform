/**
 * Runtime postgres-js pool options, adapted to the connection mode. Kept a PURE
 * leaf module (no DB open, no env read) so it unit-tests without booting pglite.
 *
 * The 2026-07-12 outage root cause (porsager/postgres#970): postgres-js pipelines
 * queries onto one TCP connection once concurrency exceeds `max`; Supabase's
 * Supavisor TRANSACTION pooler (:6543) reassigns the backend between pipelined
 * queries, so the second query's response is lost and its promise hangs forever,
 * wedging the whole pool. Session mode (:5432) / a direct connection pin one backend
 * per client for its lifetime, so pipelining and prepared statements are both safe.
 */

/** Own interface because `max_pipeline` is a real but UNtyped postgres-js option
 *  (absent from the shipped `.d.ts`); the call site casts to the driver's Options. */
export interface PoolOptions {
  prepare: boolean;
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  max_lifetime: number;
  max_pipeline?: number;
  connection: { statement_timeout: number };
}

/**
 * Heuristic: a URL on port 6543 is Supabase's Supavisor transaction pooler. This
 * covers every real Supabase transaction-pooler URL (always an explicit :6543).
 * LIMITATION: a self-hosted PgBouncer/Supavisor in transaction mode on a
 * nonstandard port, or a multihost URL (which `new URL` can't parse), would NOT be
 * detected here — set `LOOPANY_DB_POOL_MODE=transaction` to force it (see
 * env.ts `dbPoolMode`, consulted before this heuristic at the call site).
 */
export function isTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === "6543";
  } catch {
    return false;
  }
}

/**
 * Runtime pool options for the given URL. `transactionPooler` defaults to the port
 * heuristic but is injectable so the env override (`LOOPANY_DB_POOL_MODE`) and tests
 * can force the mode. Correct against EITHER a transaction-pooler or a session/direct
 * URL, so a rollback or the Phase-2 move to session mode is a pure DATABASE_URL swap.
 */
export function poolOptionsFor(
  url: string,
  transactionPooler: boolean = isTransactionPooler(url),
): PoolOptions {
  return {
    // Transaction mode can't cache prepared statements (backend reassigned per txn);
    // session/direct pins the backend, so prepared statements are safe (and faster).
    prepare: !transactionPooler,
    max: 10,
    idle_timeout: 30,
    connect_timeout: 15,
    max_lifetime: 60 * 30, // 30 min — retire connections by age so dead sockets drop
    // Transaction mode ONLY: disable pipelining. `max_pipeline:0` keeps postgres-js's
    // per-connection `busy` queue empty (the active query still ships), so no query is
    // ever pipelined behind an in-flight one — removing the #970 wedge. Serializes per
    // connection (still `max`-wide concurrency; excess bursts queue in the pool). The
    // key is OMITTED off :6543 so pipelining stays on (the postgres-js default 100) —
    // a present-with-`undefined` value would silently disable it (`n < undefined` is
    // false), so never write `max_pipeline: … ? 0 : undefined`.
    ...(transactionPooler ? { max_pipeline: 0 } : {}),
    // Session-scoped statement_timeout is ENFORCED only in session/direct mode; the
    // transaction pooler silently ignores it (Supabase docs) — harmless on :6543, and
    // it becomes a real 30s server-side query kill after a move to :5432.
    connection: { statement_timeout: 30_000 },
  };
}
