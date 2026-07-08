/**
 * Machine-fn scoping — the pure decision helpers behind machineStatus /
 * finalizeMachine / deleteMachine (visibility) and toSummary (plaintext-token
 * exposure). The server fns themselves need the Start request runtime (they
 * read the session via requestScope), so the authorization logic lives in the
 * framework-free machineScope module and is pinned here without a request, a
 * session, or a DB.
 */
import { describe, expect, test } from "vitest";

import { machineInScope, tokenVisibleTo } from "./machineScope.js";

const machine = { id: "m_1", userId: "u_owner" };
const none = () => new Set<string>();
const teamSet =
  (...ids: string[]) =>
  () =>
    new Set(ids);
/** A team-set thunk that must NOT be consulted (the decision settles earlier). */
const neverQueried = () => {
  throw new Error("team set should not be queried on this path");
};

const scope = (over: Partial<{ enforce: boolean; userId: string | null }> = {}) => ({
  enforce: true,
  userId: "u_other" as string | null,
  ...over,
});

describe("machineInScope", () => {
  test("open mode (gate off) sees everything — even signed-out", () => {
    expect(machineInScope(machine, scope({ enforce: false, userId: null }), neverQueried)).toBe(true);
  });

  test("gate on + no user ⇒ never in scope", () => {
    expect(machineInScope(machine, scope({ userId: null }), none)).toBe(false);
    // …even when the team set would have matched (and it's never even queried).
    expect(machineInScope(machine, scope({ userId: null }), neverQueried)).toBe(false);
  });

  test("owner is always in scope — without touching the team set (the hot poll path)", () => {
    expect(machineInScope(machine, scope({ userId: "u_owner" }), neverQueried)).toBe(true);
  });

  test("teammate: in scope only via the active team's machine set", () => {
    expect(machineInScope(machine, scope(), teamSet("m_1"))).toBe(true);
    expect(machineInScope(machine, scope(), teamSet("m_2"))).toBe(false);
    expect(machineInScope(machine, scope(), none)).toBe(false);
  });
});

describe("tokenVisibleTo", () => {
  test("open mode keeps the v1 behavior (token shown)", () => {
    expect(tokenVisibleTo(machine, { enforce: false, userId: null })).toBe(true);
  });

  test("gate on ⇒ owner-only — a teammate or signed-out caller never gets the token", () => {
    expect(tokenVisibleTo(machine, { enforce: true, userId: "u_owner" })).toBe(true);
    expect(tokenVisibleTo(machine, { enforce: true, userId: "u_other" })).toBe(false);
    expect(tokenVisibleTo(machine, { enforce: true, userId: null })).toBe(false);
  });
});
