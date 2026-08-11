/**
 * RUN CREDENTIAL BRIDGE (P0 stage D): /api/kernel/cli accepts an rk_ kernel
 * lease. Team is the hard wall; the actor is the RUN (provenance stamped on
 * every event); cross-task writes inside the team are ALLOWED (pull-mode
 * collaboration); owner/host verbs 403; run-finish only for the lease's OWN
 * run; a production (non-kernel) rk_ lease is a flat 401 here.
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
const T0 = "2026-09-07T06:00:00.000Z";
const T1 = "2026-09-07T07:00:01.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-krun-"));
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
      "DELETE FROM machine_team_aliases; DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
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

/** Full stage A-C pipeline: enroll mbp, seed the weekly loop, sweep, poll -
 *  returns the delivered kernel run's rk_ token + ids. */
async function deliveredRun(taskId = "seo-bet-manager") {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });

  const { decide } = await import("@loopany/kernel");
  const d = decide(
    { op: "create", title: "seo bet manager", id: taskId, cron: "0 7 * * 1", timezone: "UTC", status: "in-progress", assignee: "mbp/claude" },
    await kstore.readSnapshot(teamId),
    OWNER,
    T0,
  );
  if (!d.ok) throw new Error(d.refusal.message);
  await kstore.applyChangesetForTeam(teamId, d.changeset);
  await sweep.kernelSweep(T1, () => {});
  const res = await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  const kr = (res.body as { kernelRuns: Array<{ runId: string; runToken: string }> }).kernelRuns[0]!;
  return { teamId, deviceToken, runId: kr.runId, rk: kr.runToken };
}

test("an rk_ kernel lease writes with RUN provenance; cross-task writes allowed; own run-finish works", async () => {
  const { teamId, runId, rk } = await deliveredRun();

  // In-run note on the loop task (own-task write).
  const note = await kgateway.kernelCli(rk, { command: { op: "note", id: "seo-bet-manager", note: "W1 pass" } });
  expect(note.status).toBe(200);

  // CROSS-TASK write: mint a new bet task (the pull-mode contract).
  const create = await kgateway.kernelCli(rk, {
    command: { op: "create", title: "bet: ai design agent", id: "bet-a" },
  });
  expect(create.status).toBe(200);

  // Every event carries the RUN's provenance, not a human actor.
  const events = await kstore.readEvents(teamId);
  const betCreated = events.find((e) => e.objectId === "bet-a" && e.kind === "created");
  expect(betCreated?.provenance).toMatchObject({ entrance: "agent-run", actorId: runId });

  // Reads are team-scoped and allowed (show/list ride this) - and carry the
  // per-alias machine presence the Loops projection consumes (review round 3).
  const read = await kgateway.kernelCli(rk, { read: true });
  expect(read.status).toBe(200);
  expect(read.body.machinePresence).toMatchObject({ mbp: "online" });

  // run-finish for the OWN run succeeds.
  const finish = await kgateway.kernelCli(rk, {
    command: { op: "run-finish", runId, outcome: "done", note: "agent run completed" },
  });
  expect(finish.status).toBe(200);
  const snap = await kstore.readSnapshot(teamId);
  expect(snap.runs.find((r) => r.id === runId)?.state).toBe("done");
});

test("an rk_ credential cannot dictate time: body.now is ignored, events land on server time", async () => {
  const { teamId, rk } = await deliveredRun();

  const forged = "2020-01-01T00:00:00.000Z";
  const res = await kgateway.kernelCli(rk, {
    command: { op: "note", id: "seo-bet-manager", note: "backdated?" },
    now: forged,
  });
  expect(res.status).toBe(200);

  const events = await kstore.readEvents(teamId);
  const noted = events.find((e) => e.kind === "note" && (e.note ?? "").includes("backdated?"));
  expect(noted).toBeDefined();
  expect(noted!.at).not.toBe(forged);
  // Sanity: the stamp is recent server time, not the forged past.
  expect(Date.parse(noted!.at)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
});

test("SIMULATOR seam: LOOPANY_KERNEL_TRUST_CLIENT_NOW=1 lets an rk_ ride the virtual clock (default stays OFF)", async () => {
  const { teamId, rk } = await deliveredRun();
  const virtual = "2026-01-05T07:00:00.000Z";
  try {
    process.env.LOOPANY_KERNEL_TRUST_CLIENT_NOW = "1";
    const res = await kgateway.kernelCli(rk, {
      command: { op: "note", id: "seo-bet-manager", note: "virtual-clock note" },
      now: virtual,
    });
    expect(res.status).toBe(200);
    const noted = (await kstore.readEvents(teamId)).find(
      (e) => e.kind === "note" && (e.note ?? "").includes("virtual-clock note"),
    );
    expect(noted!.at).toBe(virtual);
  } finally {
    delete process.env.LOOPANY_KERNEL_TRUST_CLIENT_NOW;
  }
  // Flag cleared: the very next rk_ write is back on server time.
  const after = await kgateway.kernelCli(rk, {
    command: { op: "note", id: "seo-bet-manager", note: "post-flag note" },
    now: "2020-06-06T00:00:00.000Z",
  });
  expect(after.status).toBe(200);
  const post = (await kstore.readEvents(teamId)).find(
    (e) => e.kind === "note" && (e.note ?? "").includes("post-flag note"),
  );
  expect(post!.at).not.toBe("2020-06-06T00:00:00.000Z");
});

test("POSTCONDITION: a zero-evidence run-finish(done) settles as FAILED", async () => {
  // Silent success: the daemon reports done but the run wrote nothing - the
  // server settles it as a protocol FAILURE, never a done run.
  const { teamId, runId, rk } = await deliveredRun();
  const res = await kgateway.kernelCli(rk, {
    command: { op: "run-finish", runId, outcome: "done", note: "agent run completed (exit 0)" },
  });
  expect(res.status).toBe(200);
  const run = (await kstore.readSnapshot(teamId)).runs.find((r) => r.id === runId);
  expect(run?.state).toBe("failed");
  expect(run?.note ?? "").toContain("postcondition");
});

test("POSTCONDITION: an explicit no-op note is honest evidence - done stands", async () => {
  const { teamId, runId, rk } = await deliveredRun("bet-noop");
  await kgateway.kernelCli(rk, {
    command: { op: "note", id: "bet-noop", note: "nothing actionable this pass" },
  });
  const res = await kgateway.kernelCli(rk, {
    command: { op: "run-finish", runId, outcome: "done", note: "agent run completed (exit 0)" },
  });
  expect(res.status).toBe(200);
  expect((await kstore.readSnapshot(teamId)).runs.find((r) => r.id === runId)?.state).toBe("done");
});

test("POSTCONDITION: cross-task work counts as evidence (the pull-mode contract)", async () => {
  const { teamId, runId, rk } = await deliveredRun("bet-cross");
  await kgateway.kernelCli(rk, { command: { op: "create", title: "spun-off bet", id: "bet-spinoff" } });
  const res = await kgateway.kernelCli(rk, { command: { op: "run-finish", runId, outcome: "done" } });
  expect(res.status).toBe(200);
  expect((await kstore.readSnapshot(teamId)).runs.find((r) => r.id === runId)?.state).toBe("done");
});

test("POSTCONDITION: a doc PRODUCT (doc-put --task) is evidence - done stands", async () => {
  const { teamId, runId, rk } = await deliveredRun("bet-doc");
  const put = await kgateway.kernelCli(rk, {
    command: { op: "doc-put", key: "weekly-report-2026W33", body: "# findings", attachTask: "bet-doc" },
  });
  expect(put.status).toBe(200);
  const res = await kgateway.kernelCli(rk, { command: { op: "run-finish", runId, outcome: "done" } });
  expect(res.status).toBe(200);
  expect((await kstore.readSnapshot(teamId)).runs.find((r) => r.id === runId)?.state).toBe("done");
});

test("FOLLOW-UP COHERENCE: status=follow-up without a date refuses at the bridge (never inconsistent state)", async () => {
  const { rk } = await deliveredRun("bet-fu");
  const bad = await kgateway.kernelCli(rk, {
    command: { op: "update", id: "bet-fu", patch: { status: "follow-up" } },
  });
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toContain("FOLLOWUP_NEEDS_DATE");
});

test("POSTCONDITION: a DEVICE credential's finish is an owner override - never second-guessed", async () => {
  const { teamId, deviceToken, runId } = await deliveredRun("bet-owner");
  const res = await kgateway.kernelCli(deviceToken, {
    command: { op: "run-finish", runId, outcome: "done", note: "owner closes it manually" },
  });
  expect(res.status).toBe(200);
  expect((await kstore.readSnapshot(teamId)).runs.find((r) => r.id === runId)?.state).toBe("done");
});

test("TIMELINE endpoint: bounded, team-scoped, readable by BOTH credentials, run-collapsed", async () => {
  const { teamId, runId, rk, deviceToken } = await deliveredRun();

  // The run writes a product + a note (collapses into one item).
  await kgateway.kernelCli(rk, { command: { op: "doc-put", key: "w33-report", body: "# w33", attachTask: "seo-bet-manager" } });
  await kgateway.kernelCli(rk, { command: { op: "note", id: "seo-bet-manager", note: "progress" } });

  // Device credential reads the timeline.
  const dres = await kgateway.kernelCli(deviceToken, { timeline: { since: "2020-01-01T00:00:00.000Z" } });
  expect(dres.status).toBe(200);
  const items = dres.body.timeline!;
  const runItems = items.filter((i) => i.runId === runId);
  expect(runItems).toHaveLength(1); // the whole pass is ONE item
  expect(runItems[0]!.summary).toContain("doc ");

  // Run credential may read it too (team-scoped, safe).
  const rres = await kgateway.kernelCli(rk, { timeline: { since: "2020-01-01T00:00:00.000Z" } });
  expect(rres.status).toBe(200);
  expect(rres.body.timeline!.length).toBeGreaterThan(0);

  // The limit is CAPPED server-side (bounded endpoint, never a full dump).
  const capped = await kgateway.kernelCli(deviceToken, { timeline: { since: "2020-01-01T00:00:00.000Z", limit: 99999 } });
  expect(capped.status).toBe(200);
  expect(capped.body.timeline!.length).toBeLessThanOrEqual(200);

  // TEAM ISOLATION: another team's credential sees none of this team's items.
  const otherToken = tokens.mintDeviceToken();
  const otherTeam = store.teamIdForUser("u2");
  await store.ensureTeam(otherTeam, "u2's team", "u2");
  await tokens.rememberConnectKey(otherToken, { userId: "u2", teamId: otherTeam });
  const gw2 = gateway();
  await gw2.poll(otherToken, { host: "other.local", alias: "other" });
  const ores = await kgateway.kernelCli(otherToken, { timeline: { since: "2020-01-01T00:00:00.000Z" } });
  expect(ores.status).toBe(200);
  expect(ores.body.timeline!).toHaveLength(0);
});

test("owner/host verbs 403 on a run credential; a foreign run-finish 403s; a non-kernel rk_ is 401", async () => {
  const { runId, rk } = await deliveredRun();

  const tick = await kgateway.kernelCli(rk, { tick: true });
  expect(tick.status).toBe(403);

  const claim = await kgateway.kernelCli(rk, { command: { op: "run-claim", runId, sessionId: "x" } });
  expect(claim.status).toBe(403);

  const foreignFinish = await kgateway.kernelCli(rk, {
    command: { op: "run-finish", runId: "run-someone-else", outcome: "done" },
  });
  expect(foreignFinish.status).toBe(403);
  expect(JSON.stringify(foreignFinish.body)).toContain("ITS OWN run");

  // A PRODUCTION lease (no kernel markers) is not a kernel credential: 401.
  const prodRk = await tokens.registerRunLease({
    runId: "run-prod",
    loopId: "loop-prod",
    machineId: "m-x",
    role: "exec",
    allowControl: true,
  });
  const prod = await kgateway.kernelCli(prodRk, { read: true });
  expect(prod.status).toBe(401);
});
