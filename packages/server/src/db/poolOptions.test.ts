// PURE unit tests — imports ONLY ./poolOptions.js (never ./index.js, which
// would boot the pglite database).
import { describe, expect, it } from "vitest";

import { DEFAULT_POOL_MAX, isTransactionPooler, poolOptionsFor } from "./poolOptions.js";

const TXN_URL = "postgresql://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const TXN_URL_ALT_SCHEME = "postgres://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const SESSION_URL = "postgresql://user:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const DIRECT_URL = "postgresql://user:pass@db.abcdefgh.supabase.co:5432/postgres";
const PORTLESS_URL = "postgresql://user:pass@db.example.com/postgres";
const UNPARSEABLE = "not a url at all";

const ALL_URLS = [TXN_URL, TXN_URL_ALT_SCHEME, SESSION_URL, DIRECT_URL, PORTLESS_URL, UNPARSEABLE];

describe("isTransactionPooler", () => {
  it("detects :6543 on both postgresql:// and postgres:// schemes", () => {
    expect(isTransactionPooler(TXN_URL)).toBe(true);
    expect(isTransactionPooler(TXN_URL_ALT_SCHEME)).toBe(true);
  });

  it("is false for :5432 session pooler and direct URLs", () => {
    expect(isTransactionPooler(SESSION_URL)).toBe(false);
    expect(isTransactionPooler(DIRECT_URL)).toBe(false);
  });

  it("is false for a portless URL", () => {
    expect(isTransactionPooler(PORTLESS_URL)).toBe(false);
  });

  it("is false (never throws) for an unparseable URL", () => {
    expect(isTransactionPooler(UNPARSEABLE)).toBe(false);
  });
});

describe("poolOptionsFor", () => {
  it("disables prepare on the :6543 transaction pooler", () => {
    expect(poolOptionsFor(TXN_URL).prepare).toBe(false);
    expect(poolOptionsFor(TXN_URL_ALT_SCHEME).prepare).toBe(false);
  });

  it("enables prepare on :5432 session pooler and direct URLs", () => {
    expect(poolOptionsFor(SESSION_URL).prepare).toBe(true);
    expect(poolOptionsFor(DIRECT_URL).prepare).toBe(true);
  });

  it("honors the explicit transactionPooler override in both directions", () => {
    // Force transaction mode on a session-looking URL (nonstandard-port pooler).
    expect(poolOptionsFor(SESSION_URL, true).prepare).toBe(false);
    // Force session mode on a :6543-looking URL.
    expect(poolOptionsFor(TXN_URL, false).prepare).toBe(true);
  });

  it("NEVER carries max_pipeline for any URL (the reverted #133 regression guard)", () => {
    for (const url of ALL_URLS) {
      expect("max_pipeline" in poolOptionsFor(url)).toBe(false);
      expect("max_pipeline" in poolOptionsFor(url, true)).toBe(false);
      expect("max_pipeline" in poolOptionsFor(url, false)).toBe(false);
    }
  });

  it("keeps the shared pool knobs stable regardless of mode", () => {
    for (const url of ALL_URLS) {
      const opts = poolOptionsFor(url);
      expect(opts.max).toBe(6);
      expect(opts.idle_timeout).toBe(30);
      expect(opts.connect_timeout).toBe(15);
      expect(opts.max_lifetime).toBe(1800);
      expect(opts.connection.statement_timeout).toBe(30000);
    }
  });

  /**
   * The pool is sized by the POOLER's client cap, not by our concurrency appetite.
   * Supabase's session pooler refuses past `pool_size` (15 here) with
   * `EMAXCONNSESSION`, and the binding case is a RESTART: a process killed without a
   * clean shutdown leaves its backends held until TCP keepalive reaps them while the
   * replacement opens its own, so the worst case is `2*max`. (The prestart migrator
   * draws on the same budget but closes its connection before the server boots, so it
   * overlaps only the dead process's leftovers.) At the old `max: 10` that is 20
   * against 15 - guaranteed refusals during any restart, as the 2026-08-10 crash loop
   * demonstrated.
   */
  it("leaves restart headroom under a 15-client pooler cap", () => {
    const POOLER_CAP = 15;
    const worstCaseDuringRestart = DEFAULT_POOL_MAX * 2;
    expect(worstCaseDuringRestart).toBeLessThan(POOLER_CAP);
  });

  it("honors an explicit max so the pooler cap can change without a code change", () => {
    expect(poolOptionsFor(SESSION_URL, false, 3).max).toBe(3);
    // An omitted override keeps the documented default rather than going unbounded.
    expect(poolOptionsFor(SESSION_URL, false, undefined).max).toBe(DEFAULT_POOL_MAX);
  });
});
