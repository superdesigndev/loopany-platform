/**
 * U1 — the append-only event stream + the `note` verb. Bootstrap mirrors
 * tasks-api.test.ts (pglite, temp dir, async store; note goes through the
 * CliGateway unified dispatch on both credential branches).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let cliMod: typeof import("./cli.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-events-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  cliMod = await import("./cli.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as never as { exec(sql: string): Promise<void> }).exec(
    "DELETE FROM events; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

const noopScheduler = {
  maybeFlagEvolve(): void {},
  finishEvolution(): void {},
  finishEdit(): void {},
  addLoop(): void {},
  removeLoop(): void {},
  runNow(): void {},
} as never;

function cli() {
  const core = new gatewayMod.MachineGateway(noopScheduler, undefined);
  return { core, cli: new cliMod.CliGateway(core) };
}

async function seedMachine(userId = "u1", name = "M") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId, name, tokenHash: tokens.sha256(token), online: true });
  return { token, machineId };
}

const readme = (slug: string, extra = "") => `---\nid: ${slug}\ntitle: T ${slug}\n${extra}---\n\n## Spec\nx\n`;

async function seedTask(machineId: string, slug: string, extra = "") {
  return store.createLoop({
    userId: "u1",
    machineId,
    teamId: null,
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: `/h/loopany/${slug}/README.md`,
    taskFileContent: readme(slug, extra),
  });
}

test("note appends an attributed immutable event; get --log returns it with the total", async () => {
  const { token, machineId } = await seedMachine();
  const t = await seedTask(machineId, "exp-x");
  const { core, cli: c } = cli();

  const r = await c.cli(token, ["note", "exp-x", "hello", "from", "the", "record"]);
  expect(r.status).toBe(200);
  expect((r.body as { text: string }).text).toContain("note: added to exp-x");

  const got = await core.taskGet(token, "exp-x", { log: true });
  const body = got.body as { events: Array<{ type: string; text: string; actor: string }>; eventsTotal: number };
  expect(body.eventsTotal).toBe(1);
  expect(body.events[0]).toMatchObject({ type: "note", text: "hello from the record" });
  void t;
});

test("note validates: unknown flag exit 2 with guidance; missing text is usage; out-of-scope ref flat 404", async () => {
  const { token, machineId } = await seedMachine();
  await seedTask(machineId, "exp-x");
  const { cli: c } = cli();

  // finalizeCli strips cli bodies to {text, exitCode, ...} — errors render as text.
  const badFlag = await c.cli(token, ["note", "exp-x", "text", "--urgent"]);
  expect(badFlag.status).toBe(400);
  expect((badFlag.body as { exitCode: number }).exitCode).toBe(2);
  expect((badFlag.body as { text: string }).text).toContain("--urgent");

  const noText = await c.cli(token, ["note", "exp-x"]);
  expect(noText.status).toBe(400);

  // A stranger's machine (different owner) cannot note the task — flat 404.
  const { token: strangerToken } = await seedMachine("u-stranger", "S");
  expect((await c.cli(strangerToken, ["note", "exp-x", "hi"])).status).toBe(404);
});

test("run-credential note links to the run and works over the legacy transport too", async () => {
  const { machineId } = await seedMachine();
  const t = await seedTask(machineId, "exp-x");
  const run = await store.addRun({ loopId: t.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({ runId: run.id, loopId: t.id, machineId, role: "exec", allowControl: true, canSetUi: false, canSetSchema: false, canSetWorkflow: false, canFinish: false });
  const { cli: c } = cli();

  const r = await c.agentApi(rt, ["note", "in-run", "observation"]);
  expect(r.status).toBe(200);
  const evs = await store.eventsForRun(run.id);
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({ type: "note", runId: run.id, text: "in-run observation" });
  expect(evs[0]!.actor).toContain("agent:");
});

test("chokepoints: status/assignee field diffs emit exactly one typed event each, in-transaction", async () => {
  const { machineId } = await seedMachine();
  const t = await seedTask(machineId, "exp-x", "status: todo\n");
  await store.updateLoop(t.id, { taskFileContent: readme("exp-x", "status: in-progress\nassignee: sam@x.dev\n") }, { actor: "alice@x.dev" });

  const evs = await store.listEvents(t.id, { limit: 10 });
  const types = evs.map((e) => e.type).sort();
  expect(types).toEqual(["assignee-changed", "status-changed"]);
  const status = evs.find((e) => e.type === "status-changed")!;
  expect(status.actor).toBe("alice@x.dev");
  expect(status.data).toMatchObject({ from: "todo", to: "in-progress" });

  // No-diff write emits nothing (the stream records changes, not writes).
  await store.updateLoop(t.id, { name: "renamed" });
  expect(await store.countEvents(t.id)).toBe(2);
});

test("report finalize emits run-returned; claim emits run-started (record synthesis inputs)", async () => {
  const { token, machineId } = await seedMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId, teamId: null, cron: "0 9 * * *", enabled: true, notify: "never",
    taskFile: "/h/loopany/looped/README.md", taskFileContent: readme("looped"),
  });
  const { core } = cli();
  // Scheduler-created pending run → poll claims it (emits run-started).
  await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const poll = await core.poll(token, { version: "test" });
  const deliveries = (poll.body as { deliveries?: Array<{ runToken: string; runId: string }> }).deliveries ?? [];
  expect(deliveries).toHaveLength(1);

  await core.report(deliveries[0]!.runToken, { ok: true, outcome: "exec", message: "did the thing" });
  const evs = await store.listEvents(loop.id, { limit: 10 });
  const types = evs.map((e) => e.type).sort();
  expect(types).toEqual(["run-returned", "run-started"].sort());
  const ret = evs.find((e) => e.type === "run-returned")!;
  expect(ret.runId).toBe(deliveries[0]!.runId);
  expect(ret.text).toBe("did the thing");
});

test("listEvents is bounded, newest-first, with a strict --since filter", async () => {
  const { machineId } = await seedMachine();
  const t = await seedTask(machineId, "exp-x");
  for (let i = 0; i < 25; i++) {
    await store.addEvent({ loopId: t.id, type: "note", actor: "u", text: `n${i}`, at: `2026-07-24T00:00:${String(i).padStart(2, "0")}Z` });
  }
  const page = await store.listEvents(t.id, { limit: 10 });
  expect(page).toHaveLength(10);
  expect(page[0]!.text).toBe("n24"); // newest first
  const since = await store.listEvents(t.id, { since: "2026-07-24T00:00:22Z", limit: 10 });
  expect(since.map((e) => e.text).sort()).toEqual(["n23", "n24"]);
  expect(await store.listEvents(t.id, { since: "2026-07-24T00:01:00Z" })).toHaveLength(0);
});
