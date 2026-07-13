/**
 * REAL-DRIVER validation for the session-mode pool fix (Plan A). Gated on
 * `PG_INTEGRATION_URL` (a real Postgres, e.g. a local Docker container) so it is
 * SKIPPED in normal CI / the pglite suite. Exercises the exact stack that the
 * reverted #133 broke — postgres-js@3.4.9 + drizzle `db.transaction()` (which calls
 * `client.begin`) — under a concurrency burst past `max`, plus a DISEASE-repro that
 * proves this harness would have caught #133 before it reached prod.
 *
 *   PG_INTEGRATION_URL='postgresql://postgres:test@127.0.0.1:5433/postgres' \
 *     pnpm --filter @loopany/server test -- --run src/db/poolOptions.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import { poolOptionsFor } from "./poolOptions.js";

const URL = process.env.PG_INTEGRATION_URL;
const suite = URL ? describe : describe.skip;

suite("poolOptions — real postgres-js + drizzle", () => {
  it("session-mode opts survive a >max concurrency burst of transactions + prepared queries (no hang, no 25P02)", async () => {
    // A non-:6543 URL ⇒ session/direct mode ⇒ prepare:true, no max_pipeline.
    const opts = poolOptionsFor(URL!);
    expect(opts.prepare).toBe(true);
    expect("max_pipeline" in opts).toBe(false);

    const client = postgres(URL!, opts as Parameters<typeof postgres>[1]);
    const db = drizzle(client);
    try {
      await client`drop table if exists wd_burst`;
      await client`create table wd_burst (id serial primary key, n int)`;

      // 120 concurrent ops = 12x the pool's max:10, forcing the pipelining regime
      // that wedges on the transaction pooler. Mix of prepared SELECTs (findSession-
      // like) and drizzle transactions (updateLoop/ensureTeam/removeTeamMember-like).
      const N = 120;
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) {
          ops.push(db.execute(sql`select ${i}::int as x`));
        } else {
          ops.push(
            db.transaction(async (tx) => {
              await tx.execute(sql`insert into wd_burst (n) values (${i})`);
              await tx.execute(sql`select count(*)::int from wd_burst`);
            }),
          );
        }
      }

      // Promise.allSettled only resolves if EVERY op settles — a wedged/hung promise
      // would time out the test (the hang detector).
      const settled = await Promise.allSettled(ops);
      const failures = settled
        .filter((s): s is PromiseRejectedResult => s.status === "rejected")
        .map((s) => (s.reason instanceof Error ? `${s.reason.message} (${(s.reason as { code?: string }).code ?? "?"})` : String(s.reason)));
      expect(failures).toEqual([]);

      // Every transaction committed (60 of the 120 ops inserted a row).
      const rows = await client<{ count: number }[]>`select count(*)::int as count from wd_burst`;
      expect(rows[0]?.count).toBe(N / 2);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);

  it("DISEASE repro: max_pipeline:0 breaks db.transaction (proves the harness detects the reverted #133 bug)", async () => {
    // The #133 config: on postgres-js, max_pipeline:0 short-circuits the onexecute
    // callback sql.begin() needs to reserve its connection → BEGIN lands but is never
    // reserved → the driver's own UNSAFE_TRANSACTION guard rejects the transaction.
    const client = postgres(URL!, { prepare: false, max: 10, max_pipeline: 0 } as unknown as Parameters<typeof postgres>[1]);
    const db = drizzle(client);
    try {
      let error: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
        });
      } catch (e) {
        error = e;
      }
      // MUST reject — if this ever passes cleanly, max_pipeline:0 became safe and the
      // regression guard in poolOptions.test.ts could be relaxed. Until then, this is
      // the empirical proof that #133 was detectable.
      expect(error).toBeDefined();
      // And reject for the RIGHT reason: the #133 mechanism (BEGIN not reserved →
      // UNSAFE_TRANSACTION guard), not an incidental connection error.
      const msg = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.log("[disease] db.transaction under max_pipeline:0 rejected with:", msg);
      expect(msg).toMatch(/sql\.begin|sql\.reserved|max: 1|transaction/i);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);

  it("session-mode statement_timeout is ENFORCED (a hung query is killed, unlike on :6543)", async () => {
    // On :6543 the transaction pooler silently ignores session statement_timeout;
    // on session/direct it is enforced. Use a short 1.5s timeout so the test is fast.
    const client = postgres(URL!, {
      prepare: true,
      max: 2,
      connection: { statement_timeout: 1500 },
    } as unknown as Parameters<typeof postgres>[1]);
    try {
      const t0 = Date.now();
      let code: string | undefined;
      try {
        await client`select pg_sleep(5)`; // would run 5s; must be killed at ~1.5s
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      const elapsed = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[stmt_timeout] pg_sleep(5) killed after ${elapsed}ms, code=${code}`);
      expect(code).toBe("57014"); // query_canceled / statement timeout
      expect(elapsed).toBeLessThan(4000); // killed well before the 5s sleep finished
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 30_000);
});
