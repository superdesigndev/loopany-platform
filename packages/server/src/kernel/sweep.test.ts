/**
 * KERNEL SWEEP (P0 stage B): the server-side time driver. Due teams found by
 * one indexed query; the authority tick mints pending runs; addressed machines'
 * long-polls are woken; an unknown alias leaves the run pending (durable
 * inbox); a second sweep of the same instant mints nothing (run-id dedup).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Provenance } from "@loopany/kernel";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let kstore: typeof import("./store.js");
let kgateway: typeof import("./gateway.js");
let sweep: typeof import("./sweep.js");
let tokens: typeof import("../gateway/tokens.js");
let gatewayMod: typeof import("../gateway/index.js");

const OWNER: Provenance = { entrance: "human", actorId: "u1" };
const T0 = "2026-09-07T06:00:00.000Z"; // Monday, one hour before the 07:00 fire
const T1 = "2026-09-07T07:00:01.000Z"; // just past the fire

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-ksweep-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  kstore = await import("./store.js");
  kgateway = await import("./gateway.js");
  sweep = await import("./sweep.js");
  tokens = await import("../gateway/tokens.js");
  gatewayMod = await import("../gateway/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM kernel_runs; DELETE FROM kernel_triggers; DELETE FROM kernel_events; DELETE FROM kernel_objects; " +
      "DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

function gateway() {
  return new gatewayMod.MachineGateway(
    {
      maybeFlagEvolve(): void {},
      finishEvolution(): void {},
      finishEdit(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined,
  );
}

/** Seed a kernel loop task (weekly Monday 07:00 cron, assignee mbp/claude) into
 *  `teamId` via the same decide+apply path the HTTP route runs. */
async function seedLoop(teamId: string) {
  const { decide } = await import("@loopany/kernel");
  const d = decide(
    {
      op: "create",
      title: "seo bet manager",
      id: "seo-bet-manager",
      cron: "0 7 * * 1",
      timezone: "UTC",
      status: "in-progress",
      assignee: "mbp/claude",
    },
    await kstore.readSnapshot(teamId),
    OWNER,
    T0,
  );
  if (!d.ok) throw new Error(d.refusal.message);
  const applied = await kstore.applyChangesetForTeam(teamId, d.changeset);
  if (!applied.ok) throw new Error("seed apply conflict");
}

/** Enroll a machine with alias `mbp` for u1's personal team. */
async function enrollMbp() {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  const res = await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  expect(res.status).toBe(200);
  return { machineId, teamId };
}

test("a due cron mints a pending run at the authority and wakes the aliased machine", async () => {
  const { machineId, teamId } = await enrollMbp();
  await seedLoop(teamId);

  // Before the fire instant: no due team, nothing minted.
  const early = await sweep.kernelSweep(T0, () => {
    throw new Error("must not wake before the fire");
  });
  expect(early).toMatchObject({ teams: 0, minted: 0, woken: 0 });

  const woken: string[] = [];
  const r1 = await sweep.kernelSweep(T1, (id) => woken.push(id));
  expect(r1).toMatchObject({ teams: 1, minted: 1, woken: 1, skipped: false });
  expect(woken).toEqual([machineId]);

  const snap = await kstore.readSnapshot(teamId);
  expect(snap.runs).toMatchObject([
    { taskId: "seo-bet-manager", cause: "cron", state: "pending", assignee: "mbp/claude" },
  ]);

  // Same instant again: the trigger advanced past the fire, nothing new mints.
  const r2 = await sweep.kernelSweep(T1, () => {
    throw new Error("must not wake twice");
  });
  expect(r2.minted).toBe(0);
});

test("an unknown alias leaves the run pending with zero wakes AND a durable, DEDUPED task event", async () => {
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await seedLoop(teamId); // no machine enrolled at all

  const r = await sweep.kernelSweep(T1, () => {
    throw new Error("no machine exists - nothing to wake");
  });
  expect(r).toMatchObject({ minted: 1, woken: 0 });
  const snap = await kstore.readSnapshot(teamId);
  const run = snap.runs[0]!;
  expect(run.state).toBe("pending"); // waits for the machine to enroll

  // The condition is DURABLE + owner-visible: one note event on the task,
  // written by the clock actor, naming the missing alias.
  const blocked = (await kstore.readEvents(teamId)).filter(
    (e) => e.objectId === "seo-bet-manager" && (e.note ?? "").includes("dispatch blocked"),
  );
  expect(blocked).toHaveLength(1);
  expect(blocked[0]!.note).toContain('no machine in this team has alias "mbp"');
  expect(blocked[0]!.provenance.entrance).toBe("clock");

  // DEDUP: while the SAME run stays blocked, repeats write nothing new.
  const { recordDispatchBlocked } = await import("./blocked.js");
  await recordDispatchBlocked(teamId, run, "whatever - same run, must dedup");
  const again = (await kstore.readEvents(teamId)).filter(
    (e) => e.objectId === "seo-bet-manager" && (e.note ?? "").includes("dispatch blocked"),
  );
  expect(again).toHaveLength(1);
});

test("one team's tick failure is ISOLATED: later teams still sweep; the report counts it", async () => {
  const teamA = store.teamIdForUser("uA");
  const teamB = store.teamIdForUser("uB");
  await store.ensureTeam(teamA, "A", "uA");
  await store.ensureTeam(teamB, "B", "uB");
  await seedLoop(teamA);
  await seedLoop(teamB);

  const ticked: string[] = [];
  const real = (await import("./gateway.js")).tickTeamAtAuthority;
  const r = await sweep.kernelSweep(T1, () => {}, async (teamId, now) => {
    if (teamId === teamA) throw new Error("malformed team blows up");
    ticked.push(teamId);
    return real(teamId, now);
  });
  expect(r.failed).toBe(1);
  expect(ticked).toEqual([teamB]); // B swept despite A throwing
  const snapB = await kstore.readSnapshot(teamB);
  expect(snapB.runs).toHaveLength(1); // B's fire really minted
});

test("a pass is BOUNDED: teams past the cap are dropped loudly and stay due for the next round", async () => {
  process.env.LOOPANY_KERNEL_SWEEP_MAX_TEAMS = "2";
  try {
    for (const u of ["u1", "u2", "u3"]) {
      const teamId = store.teamIdForUser(u);
      await store.ensureTeam(teamId, u, u);
      await seedLoop(teamId);
    }
    const r1 = await sweep.kernelSweep(T1, () => {});
    expect(r1).toMatchObject({ teams: 2, minted: 2, dropped: 1 });

    // The dropped team is simply still due: the next round picks it up.
    const r2 = await sweep.kernelSweep(T1, () => {});
    expect(r2).toMatchObject({ teams: 1, minted: 1, dropped: 0 });
  } finally {
    delete process.env.LOOPANY_KERNEL_SWEEP_MAX_TEAMS;
  }
});

test("assigneeSegments splits the execution address and rejects non-addresses", () => {
  expect(sweep.assigneeSegments("mbp/claude")).toEqual({ machine: "mbp", agent: "claude" });
  expect(sweep.assigneeSegments("claude")).toBeNull(); // bare local-mode name
  expect(sweep.assigneeSegments("tim@x.co")).toBeNull(); // person, never dispatched
  expect(sweep.assigneeSegments("/claude")).toBeNull();
  expect(sweep.assigneeSegments("mbp/")).toBeNull();
  expect(sweep.assigneeSegments(null)).toBeNull();
});
