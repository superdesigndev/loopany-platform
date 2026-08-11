/**
 * OWNER NOTIFICATIONS (kernel-owner-notifications): attention-only pushes over
 * the just-applied changeset - human assignment (with the hand-back note and
 * the product link), auto-park, dispatch-blocked (dedup inherited) - and the
 * quiet path: ordinary successful activity notifies NOTHING.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { Provenance } from "@loopany/kernel";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let kstore: typeof import("./store.js");
let kgateway: typeof import("./gateway.js");
let knotify: typeof import("./notify.js");
let blocked: typeof import("./blocked.js");
let tokens: typeof import("../gateway/tokens.js");
let gatewayMod: typeof import("../gateway/index.js");

const T0 = "2026-09-07T06:00:00.000Z";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-knotify-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  kstore = await import("./store.js");
  kgateway = await import("./gateway.js");
  knotify = await import("./notify.js");
  blocked = await import("./blocked.js");
  tokens = await import("../gateway/tokens.js");
  gatewayMod = await import("../gateway/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let pushes: Array<{ teamId: string; title: string; message: string }>;

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM kernel_runs; DELETE FROM kernel_triggers; DELETE FROM kernel_events; DELETE FROM kernel_objects; " +
      "DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
  pushes = [];
  knotify.setKernelNotifier(async (teamId, title, message) => {
    pushes.push({ teamId, title, message });
  });
});

afterEach(() => {
  knotify.setKernelNotifier(null);
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

async function enrolledDevice() {
  const gw = gateway();
  const deviceToken = tokens.mintDeviceToken();
  const teamId = store.teamIdForUser("u1");
  await store.ensureTeam(teamId, "u1's team", "u1");
  await tokens.rememberConnectKey(deviceToken, { userId: "u1", teamId });
  await gw.poll(deviceToken, { host: "mbp.local", alias: "mbp" });
  return { gw, deviceToken, teamId };
}

test("a HUMAN assignment notifies with the reply and the product link; agent work stays quiet", async () => {
  const { deviceToken } = await enrolledDevice();

  // Quiet path: ordinary agent-bound create + a doc product notify NOTHING.
  await kgateway.kernelCli(deviceToken, { command: { op: "create", title: "seo loop", id: "seo", assignee: "mbp/claude" } });
  await kgateway.kernelCli(deviceToken, { command: { op: "doc-put", key: "w33", body: "#", attachTask: "seo" } });
  expect(pushes).toHaveLength(0);

  // A decision task minted FOR a human notifies, linking the tracked product.
  await kgateway.kernelCli(deviceToken, {
    command: { op: "create", title: "decide: variant A or B", id: "decide-v", assignee: "tim@x.co", tracks: "w33" },
  });
  expect(pushes).toHaveLength(1);
  expect(pushes[0]!.title).toContain("decision needed");
  expect(pushes[0]!.message).toContain("tim@x.co");
  expect(pushes[0]!.message).toContain("inspect: w33");

  // The HAND-BACK to a human (assignee-changed) notifies with the note.
  await kgateway.kernelCli(deviceToken, {
    command: { op: "update", id: "seo", patch: { assignee: "tim@x.co" }, note: "your call on the pricing page" },
  });
  expect(pushes).toHaveLength(2);
  expect(pushes[1]!.message).toContain("your call on the pricing page");

  // Handing BACK to an agent is quiet (the dispatch is the notification-free path).
  await kgateway.kernelCli(deviceToken, {
    command: { op: "update", id: "seo", patch: { assignee: "mbp/claude", status: "todo" }, note: "go" },
  });
  expect(pushes).toHaveLength(2);
});

test("a dispatch-blocked condition notifies ONCE per blocked run (dedup inherited from the event)", async () => {
  const { teamId, deviceToken } = await enrolledDevice();
  await kgateway.kernelCli(deviceToken, { command: { op: "create", title: "ghost loop", id: "ghost", assignee: "nowhere/claude" } });
  pushes = [];

  const run = (await kstore.readSnapshot(teamId)).runs[0]!;
  await blocked.recordDispatchBlocked(teamId, run, 'no machine in this team has alias "nowhere"');
  expect(pushes).toHaveLength(1);
  expect(pushes[0]!.title).toContain("needs configuration");

  // The same blocked run on the next sweep round: no event, no push.
  await blocked.recordDispatchBlocked(teamId, run, 'no machine in this team has alias "nowhere"');
  expect(pushes).toHaveLength(1);
});

test("an AUTO-PARK (persistent failure) notifies the owner once", async () => {
  const { teamId, deviceToken } = await enrolledDevice();
  await kgateway.kernelCli(deviceToken, {
    command: { op: "create", title: "flaky once", id: "flaky", assignee: "mbp/claude", status: "todo" },
  });
  pushes = [];

  // Drive the failed-run ladder to the park via decide (assignment cause fails
  // repeatedly). Each round: claim then finish failed.
  const { decide } = await import("@loopany/kernel");
  for (let round = 0; ; round++) {
    const snap = await kstore.readSnapshot(teamId);
    const pending = snap.runs.find((r) => r.taskId === "flaky" && r.state === "pending");
    if (!pending) break;
    const actor: Provenance = { entrance: "agent-run", actorId: pending.id };
    const claim = decide({ op: "run-claim", runId: pending.id, sessionId: "s" }, snap, actor, T0);
    if (!claim.ok) throw new Error(claim.refusal.code);
    await kstore.applyChangesetForTeam(teamId, claim.changeset);
    // The failed finish flows through the kernelCli chokepoint (as a reclaim or
    // agent report would), so the park notification fires there.
    const fin = decide(
      { op: "run-finish", runId: pending.id, outcome: "failed", note: "boom" },
      await kstore.readSnapshot(teamId),
      { entrance: "clock", actorId: "kernel-reclaim" },
      T0,
    );
    if (!fin.ok) throw new Error(fin.refusal.code);
    await kstore.applyChangesetForTeam(teamId, fin.changeset);
    await (await import("./notify.js")).notifyKernelChangeset(teamId, fin.changeset);
    // Re-arm: the failed-run resilience set follow-up; flip it back to todo to
    // mint the next assignment run (simulating the retry ladder quickly).
    const t = (await kstore.readSnapshot(teamId)).objects["flaky"];
    if (t?.archetype === "task" && t.status === "idea") break; // parked
    await kgateway.kernelCli(deviceToken, { command: { op: "update", id: "flaky", patch: { status: "todo" } } });
    if (round > 6) throw new Error("never parked");
  }

  const parkPushes = pushes.filter((p) => p.title.includes("parked"));
  expect(parkPushes).toHaveLength(1);
  expect(parkPushes[0]!.message).toContain("auto-parked");
});
