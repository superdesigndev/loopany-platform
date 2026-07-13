// PURE unit tests — imports ONLY ./poolOptions.js (never ./index.js, which
// would boot the pglite database).
import { describe, expect, it } from "vitest";

import { isTransactionPooler, poolOptionsFor } from "./poolOptions.js";

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
      expect(opts.max).toBe(10);
      expect(opts.idle_timeout).toBe(30);
      expect(opts.connect_timeout).toBe(15);
      expect(opts.max_lifetime).toBe(1800);
      expect(opts.connection.statement_timeout).toBe(30000);
    }
  });
});
