/**
 * `loopany new --json '{… "enabled": false}'` — the armed-but-paused create.
 *
 * Live validation (F1) found four loops created with `enabled: false` coming up
 * ENABLED, each firing a real creation run before a follow-up pause edit could
 * land. `createLoop` hardcoded `enabled: true` and then fired `runNow` behind a
 * gate that could never be false, so the staging/twin pattern was inexpressible
 * at creation.
 *
 * These drive the REAL Scheduler against a real store (no stubbed run-now), so
 * "zero runs queued" is a fact about the run table rather than about a spy:
 *   - create disabled ⇒ enabled=false, no cron registered, ZERO runs;
 *   - run-now on that loop ⇒ EXACTLY ONE run, and the loop stays paused (D1);
 *   - create enabled (the default, and an explicit `true`) ⇒ unchanged, the
 *     immediate first run still fires.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import type { Loop, Run } from "../db/schema.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");
let sched: typeof import("../scheduler/index.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-createpaused-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
  sched = await import("../scheduler/index.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as { exec(q: string): Promise<unknown> }).exec(
    "DELETE FROM run_leases; DELETE FROM connect_keys; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

/** Drop every timer a test armed, so a live cron can neither pollute the next
 *  test nor keep the process alive. `stopAll` is private (it belongs to the
 *  abort signal), so unschedule by id through the public `removeLoop`. */
let live: InstanceType<typeof sched.Scheduler> | undefined;
afterEach(async () => {
  for (const loop of await store.listLoops()) live?.removeLoop(loop.id);
  live = undefined;
});

/** Is a cron registered for this loop? The registry is private on purpose — the
 *  scheduler exposes no reader — but "the clock cannot select a paused loop" is
 *  exactly what this fix is about, so assert it directly rather than inferring
 *  it from a run count that a slow timer could satisfy later. */
function hasCron(scheduler: InstanceType<typeof sched.Scheduler>, id: string): boolean {
  return (scheduler as unknown as { crons: Map<string, unknown> }).crons.has(id);
}

/** The gateway wired to the REAL Scheduler, exactly as boot does — so `addLoop`
 *  and `runNow` are the shipping implementations, not no-op stubs. */
async function harness() {
  const dispatched: Array<{ loop: Loop; run: Run }> = [];
  const scheduler = new sched.Scheduler({
    dispatch(loop: Loop, run: Run) {
      dispatched.push({ loop, run });
    },
  });
  live = scheduler;
  const gateway = new gatewayMod.MachineGateway(scheduler as never);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  return { gateway, scheduler, token, machineId, dispatched };
}

/** The rendered TOON the daemon prints — every create response carries one. */
function text(res: { body: unknown }): string {
  return String((res.body as { text?: unknown }).text ?? "");
}

/** A create config that fires on a cadence far enough out that ONLY the create's
 *  own immediate run (or the absence of one) can put a row in `runs`. */
function config(extra: Record<string, unknown> = {}) {
  return { name: "Twin", cron: "0 0 1 1 *", taskFile: "loopany/twin/README.md", ...extra };
}

test("create with enabled:false → paused loop, no cron, and ZERO runs", async () => {
  const { gateway, scheduler, token } = await harness();

  const res = await gateway.createLoop(token, config({ enabled: false }));
  expect(res.status).toBe(200);
  const id = (res.body as { id: string }).id;

  // The persisted row is the authority: the create honored the intent.
  const loop = await store.getLoop(id);
  expect(loop?.enabled).toBe(false);
  // Autonomously inert: the clock cannot select it...
  expect(hasCron(scheduler, id)).toBe(false);
  // ...and nothing was queued — no creation run, no deferred one-shot to
  // surprise the owner on a later re-enable.
  expect(await store.listRuns(id, 10)).toHaveLength(0);
  expect(loop?.nextRunAt ?? null).toBeNull();

  // The response tells the truth about what just happened.
  expect((res.body as { enabled: boolean }).enabled).toBe(false);
  expect(text(res)).toContain("enabled: paused");
  expect(text(res)).not.toContain("nextRuns");
});

test("run-now on a create-paused loop fires EXACTLY ONE run and leaves it paused (D1)", async () => {
  const { gateway, scheduler, token, dispatched } = await harness();
  const id = ((await gateway.createLoop(token, config({ enabled: false }))).body as { id: string }).id;

  const fired = await scheduler.runNow(id);
  expect(fired.queued).toBe(true);

  const runs = await store.listRuns(id, 10);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.phase).toBe("pending");
  expect(dispatched).toHaveLength(1);
  // Pause governs the CADENCE only: firing it by hand never resumes it, and
  // leaves no one-shot behind.
  const after = await store.getLoop(id);
  expect(after?.enabled).toBe(false);
  expect(after?.nextRunAt ?? null).toBeNull();
  expect(hasCron(scheduler, id)).toBe(false);
});

test("create is ENABLED by default and on an explicit true — the immediate first run still fires", async () => {
  const { gateway, scheduler, token } = await harness();

  for (const extra of [{}, { enabled: true }]) {
    const res = await gateway.createLoop(token, config(extra));
    const id = (res.body as { id: string }).id;
    const loop = await store.getLoop(id);
    expect(loop?.enabled).toBe(true);
    expect(hasCron(scheduler, id)).toBe(true);
    // The create's own immediate run — the feature a paused create opts out of.
    expect(await store.listRuns(id, 10)).toHaveLength(1);
    expect(text(res)).toContain("enabled: on");
  }
});

test("a non-boolean `enabled` is REFUSED, never coerced", async () => {
  const { gateway, token } = await harness();

  for (const bad of ["false", 0, null]) {
    const res = await gateway.createLoop(token, config({ enabled: bad }));
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("enabled must be a boolean");
  }
  // Nothing was persisted by any of the refused attempts.
  expect(await store.listLoops()).toHaveLength(0);
});

test("--dry-run echoes the enabled state (and previews no fires when paused)", async () => {
  const { gateway, token } = await harness();

  const paused = await gateway.createLoop(token, config({ enabled: false, dryRun: true }));
  expect((paused.body as { config: { enabled: boolean } }).config.enabled).toBe(false);
  expect((paused.body as { nextRuns: string[] }).nextRuns).toHaveLength(0);
  expect(text(paused)).toContain("enabled: paused");

  const armed = await gateway.createLoop(token, config({ dryRun: true }));
  expect((armed.body as { config: { enabled: boolean } }).config.enabled).toBe(true);
  expect((armed.body as { nextRuns: string[] }).nextRuns.length).toBeGreaterThan(0);
  expect(text(armed)).toContain("enabled: on");

  // A preview persists nothing, whichever way it went.
  expect(await store.listLoops()).toHaveLength(0);
});
