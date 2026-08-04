import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * THE AUTH SEAM, driven with real Requests against real rows.
 *
 * This file exists because of a blocking review finding: the 47 CLI goldens stub
 * `fetchImpl` and the object-API integration tests hand-construct `ApiContext`
 * objects, so NOTHING exercised `resolveApiContext` itself — and the guard was
 * keying on credential presence rather than run-context presence, which made
 * `loopany inbox`/`answer` refuse NOT_HUMAN on every machine that had ever run
 * `loopany up`. The class of bug is "the branch nobody drove", so these tests
 * drive the branch: real device tokens, real run rows, real leases, real
 * `Request` objects, one case per cell of the spec §2.6 auth table.
 *
 * Only the SESSION half is injected (`SessionSeam`) — it is bound to the
 * framework's request-scoped context, not to anything this seam decides.
 */
let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let auth: typeof import("./apiAuth.js");

const TEAM = "team-auth";
const T0 = "2026-08-03T00:00:00.000Z";
const DEVICE = "dk_9f13ac02b81d4e77a5c0";

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-api-auth-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/kernel-schema.js");
  legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js");
  auth = await import("./apiAuth.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
  await database.db.delete(legacySchema.runs);
  await database.db.delete(legacySchema.machines);
});

/** A signed-in person. */
const SIGNED_IN: import("./apiAuth.js").SessionSeam = {
  currentUser: async () => ({ id: "u-owner", email: "owner@example.test" }),
  requestScope: async () => ({ enforce: true, userId: "u-owner", teamId: TEAM }),
  authEnabled: true,
};
/** The gate is on and nobody is signed in. */
const SIGNED_OUT: import("./apiAuth.js").SessionSeam = {
  currentUser: async () => null,
  requestScope: async () => ({ enforce: true, userId: null, teamId: TEAM }),
  authEnabled: true,
};

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/inbox", { headers });
}

async function machine(): Promise<string> {
  const { machineIdFromToken, sha256 } = await import("../gateway/tokens.js");
  const id = machineIdFromToken(DEVICE);
  await database.db.insert(legacySchema.machines).values({ id, userId: "u-owner", name: "laptop", tokenHash: sha256(DEVICE), teamId: TEAM, lastSeen: T0, createdAt: T0 });
  return id;
}

/** A claimed run with a live lease — the state an agent request must be in. */
async function claimedRun(machineId: string) {
  const loop = await kernel.createObject({ teamId: TEAM, kind: "loop", actor: { entrance: "human", actorId: "u-owner" }, now: T0, title: "Housekeeper", cron: "0 7 * * *", body: "charter" });
  if (!loop.ok) throw new Error(loop.message);
  await database.db.insert(legacySchema.runs).values({
    id: "run-3f8a20", loopId: loop.object.id, userId: TEAM, machineId, phase: "running", role: "exec", ts: T0,
    queueState: "claimed", scope: "routine", reason: "clock", entrance: "clock",
    leaseState: "active", leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  return { loopId: loop.object.id, runId: "run-3f8a20" };
}

const code = (r: Awaited<ReturnType<typeof auth.resolveApiContext>>) => (r.ok ? "OK" : r.error.code);

// -------------------------------------------------------- the regression itself

describe("a human on a connected machine (the B1 regression)", () => {
  it("admits `loopany inbox` from a signed-in human even with a device credential attached", async () => {
    await machine();
    // This is the shape the CLI used to send from EVERY machine that had run
    // `loopany up`: a stored device token, no run context, a real session.
    const result = await auth.resolveApiContext(request({ Authorization: `Bearer ${DEVICE}` }), "human", true, SIGNED_IN);
    expect(result.ok).toBe(true);
    expect(result.ok && result.context).toMatchObject({ mode: "human", teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" } });
  });

  it("admits the same human with no credential at all", async () => {
    const result = await auth.resolveApiContext(request(), "human", true, SIGNED_IN);
    expect(result.ok && result.context.mode).toBe("human");
  });

  it("never answers NOT_HUMAN to a request that carries no run context", async () => {
    await machine();
    for (const requirement of ["human", "dual"] as const) {
      for (const seam of [SIGNED_IN, SIGNED_OUT]) {
        const shapes: Record<string, string>[] = [{}, { Authorization: `Bearer ${DEVICE}` }, { Authorization: "Bearer dk_forged" }];
        for (const headers of shapes) {
          const result = await auth.resolveApiContext(request(headers), requirement, true, seam);
          expect(code(result), `${requirement} / ${JSON.stringify(headers)}`).not.toBe("NOT_HUMAN");
        }
      }
    }
  });
});

// ------------------------------------------------------------ the §2.6 table

describe("the auth table keys on run-context presence, not on a credential type", () => {
  it("refuses NOT_HUMAN on a human endpoint only when run context is present", async () => {
    const machineId = await machine();
    const { runId } = await claimedRun(machineId);
    const agent = request({ Authorization: `Bearer ${DEVICE}`, "X-Loopany-Run": runId });
    const result = await auth.resolveApiContext(agent, "human", true, SIGNED_IN);
    expect(code(result)).toBe("NOT_HUMAN");
    // The refusal names the run it saw, so the caller can tell WHY it was
    // classified as an agent rather than guessing at its credential.
    expect(!result.ok && result.error.issues[0]).toMatchObject({ path: "X-Loopany-Run", got: runId });
    expect(!result.ok && result.error.hint).toContain("the human inbox");
  });

  it("teaches the proposal path, not the inbox, when the human-only endpoint is loop governance", async () => {
    const machineId = await machine();
    const { runId } = await claimedRun(machineId);
    const agent = request({ Authorization: `Bearer ${DEVICE}`, "X-Loopany-Run": runId });
    // The ROUTE guard answers before any kernel function runs, so this is the
    // refusal a run attempting `loop create|pause|resume|retire` actually reads:
    // the inbox voice would be teaching a surface it never touched (review F2).
    const result = await auth.resolveApiContext(agent, { human: "loop-governance" }, true, SIGNED_IN);
    expect(code(result)).toBe("NOT_HUMAN");
    expect(!result.ok && result.error.message).toContain("governance");
    expect(!result.ok && result.error.hint).toContain("--needs-human");
    expect(!result.ok && result.error.hint).not.toContain("inbox");
  });

  it("gives a bare device credential the DAEMON answers: NO_RUN_CONTEXT on dual, UNAUTHORIZED on human-only", async () => {
    await machine();
    const bare = () => request({ Authorization: `Bearer ${DEVICE}` });
    expect(code(await auth.resolveApiContext(bare(), "dual", true, SIGNED_OUT))).toBe("NO_RUN_CONTEXT");
    const humanOnly = await auth.resolveApiContext(bare(), "human", true, SIGNED_OUT);
    expect(code(humanOnly)).toBe("UNAUTHORIZED");
    expect(!humanOnly.ok && humanOnly.error.issues[0]).toMatchObject({ message: "a device credential is a machine's, not a person's" });
  });

  it("refuses a human session on an agent-only endpoint with NO_RUN_CONTEXT", async () => {
    const result = await auth.resolveApiContext(request(), "agent", true, SIGNED_IN);
    expect(code(result)).toBe("NO_RUN_CONTEXT");
    expect(!result.ok && result.error.hint).toContain("loop page");
  });

  it("refuses a signed-out caller with no credential", async () => {
    expect(code(await auth.resolveApiContext(request(), "human", true, SIGNED_OUT))).toBe("UNAUTHORIZED");
    expect(code(await auth.resolveApiContext(request(), "dual", true, SIGNED_OUT))).toBe("UNAUTHORIZED");
  });

  it("admits an agent on a dual endpoint and resolves run → loop → team", async () => {
    const machineId = await machine();
    const { runId, loopId } = await claimedRun(machineId);
    const result = await auth.resolveApiContext(request({ Authorization: `Bearer ${DEVICE}`, "X-Loopany-Run": runId }), "dual", true, SIGNED_OUT);
    expect(result.ok).toBe(true);
    expect(result.ok && result.context).toMatchObject({ mode: "agent", teamId: TEAM, actor: { entrance: "agent", actorId: runId } });
    expect(result.ok && result.context.loop?.id).toBe(loopId);
  });
});

// ------------------------------------------------------------ run-context guards

describe("run context is resolved against the runs table, never trusted from the wire", () => {
  it("refuses run context with no device credential — the run id authorizes nothing on its own", async () => {
    const machineId = await machine();
    const { runId } = await claimedRun(machineId);
    expect(code(await auth.resolveApiContext(request({ "X-Loopany-Run": runId }), "dual", true, SIGNED_OUT))).toBe("UNAUTHORIZED");
  });

  it("gives an unknown run and another machine's run the SAME answer, so runs cannot be enumerated", async () => {
    const machineId = await machine();
    await claimedRun(machineId);
    const headers = { Authorization: `Bearer ${DEVICE}` };
    const unknown = await auth.resolveApiContext(request({ ...headers, "X-Loopany-Run": "run-does-not-exist" }), "dual", true, SIGNED_OUT);
    await database.db.update(legacySchema.runs).set({ machineId: "m-somebody-else" });
    const foreign = await auth.resolveApiContext(request({ ...headers, "X-Loopany-Run": "run-3f8a20" }), "dual", true, SIGNED_OUT);
    expect(code(unknown)).toBe("RUN_CONTEXT_UNKNOWN");
    expect(code(foreign)).toBe("RUN_CONTEXT_UNKNOWN");
    expect(!unknown.ok && unknown.error.hint).toBe(!foreign.ok ? foreign.error.hint : "");
  });

  it("refuses a mutation on a reclaimed lease but still serves the read that lets it report", async () => {
    const machineId = await machine();
    const { runId } = await claimedRun(machineId);
    await database.db.update(legacySchema.runs).set({ leaseState: "terminal-grace" });
    const headers = { Authorization: `Bearer ${DEVICE}`, "X-Loopany-Run": runId };
    expect(code(await auth.resolveApiContext(request(headers), "dual", true, SIGNED_OUT))).toBe("LEASE_LOST");
    expect((await auth.resolveApiContext(request(headers), "dual", false, SIGNED_OUT)).ok).toBe(true);
  });

  it("refuses an expired lease", async () => {
    const machineId = await machine();
    const { runId } = await claimedRun(machineId);
    await database.db.update(legacySchema.runs).set({ leaseExpiresAt: T0 });
    expect(code(await auth.resolveApiContext(request({ Authorization: `Bearer ${DEVICE}`, "X-Loopany-Run": runId }), "dual", true, SIGNED_OUT))).toBe("LEASE_LOST");
  });
});
