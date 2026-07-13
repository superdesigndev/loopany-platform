/**
 * Mode-aware runtime pool options (db/poolOptions.ts). The 2026-07-12 root-cause
 * fix: a transaction-pooler URL (:6543) must disable pipelining (`max_pipeline:0`)
 * and prepared statements (porsager/postgres#970); a session/direct URL (:5432)
 * must enable both. Truly pure — imports the leaf module, so no DB/driver boot.
 */
import { describe, expect, it } from "vitest";

import { isTransactionPooler, poolOptionsFor } from "./poolOptions.js";

const TXN = "postgresql://postgres.ref:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require";
const TXN_SHORT = "postgres://postgres.ref:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres";
const SESSION = "postgresql://postgres.ref:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require";
const DIRECT = "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres?sslmode=require";
const NO_PORT = "postgresql://postgres:pw@db.ref.supabase.co/postgres?sslmode=require";

describe("isTransactionPooler", () => {
  it("is true ONLY for the :6543 transaction pooler (both URL schemes)", () => {
    expect(isTransactionPooler(TXN)).toBe(true);
    expect(isTransactionPooler(TXN_SHORT)).toBe(true);
    expect(isTransactionPooler(SESSION)).toBe(false);
    expect(isTransactionPooler(DIRECT)).toBe(false);
  });

  it("a portless URL is treated as non-pooler (default 5432 is direct/session)", () => {
    expect(isTransactionPooler(NO_PORT)).toBe(false);
  });

  it("does not throw on an unparseable URL (treated as non-pooler)", () => {
    expect(isTransactionPooler("not a url")).toBe(false);
    expect(isTransactionPooler("")).toBe(false);
  });
});

describe("poolOptionsFor", () => {
  it("transaction pooler (:6543): pipelining OFF + prepare OFF (the #970 guard)", () => {
    const o = poolOptionsFor(TXN);
    expect(o.max_pipeline).toBe(0);
    expect(o.prepare).toBe(false);
  });

  it("session pooler (:5432): pipelining ON + prepare ON — the key is ABSENT, not undefined", () => {
    const o = poolOptionsFor(SESSION);
    // `max_pipeline: undefined` would silently disable pipelining (n < undefined is
    // false), so assert the key is genuinely absent → postgres-js default (100).
    expect("max_pipeline" in o).toBe(false);
    expect(o.prepare).toBe(true);
  });

  it("direct connection (:5432): same as session — prepared statements + pipelining", () => {
    const o = poolOptionsFor(DIRECT);
    expect("max_pipeline" in o).toBe(false);
    expect(o.prepare).toBe(true);
  });

  it("an explicit transactionPooler override wins over the URL heuristic (both ways)", () => {
    // Force transaction mode on a :5432 URL (e.g. a self-hosted pooler).
    const forcedTxn = poolOptionsFor(SESSION, true);
    expect(forcedTxn.max_pipeline).toBe(0);
    expect(forcedTxn.prepare).toBe(false);
    // Force session mode on a :6543 URL.
    const forcedSession = poolOptionsFor(TXN, false);
    expect("max_pipeline" in forcedSession).toBe(false);
    expect(forcedSession.prepare).toBe(true);
  });

  it("shared, mode-independent options are stable across URLs", () => {
    for (const url of [TXN, SESSION, DIRECT]) {
      const o = poolOptionsFor(url);
      expect(o.max).toBe(10);
      expect(o.idle_timeout).toBe(30);
      expect(o.connect_timeout).toBe(15);
      expect(o.max_lifetime).toBe(1800);
      expect(o.connection.statement_timeout).toBe(30_000);
    }
  });
});
