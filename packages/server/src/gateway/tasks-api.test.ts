/**
 * Phase-2 task API surface: the device-token task verbs (list/get/search/run),
 * createLoop's slug idempotency, and the run-token task subset (+ the `done`
 * alias for `report`). Bootstrap mirrors index.test.ts (pglite, temp dir, async
 * store; the run-token verbs go through CliGateway.agentApi over the same core).
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-tasksapi-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
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
  await (db.client as any).exec("DELETE FROM events; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function recordingScheduler() {
  const calls = { runNow: [] as string[], removeLoop: [] as string[] };
  return {
    calls,
    scheduler: {
      maybeFlagEvolve(): void {},
      finishEvolution(): void {},
      finishEdit(): void {},
      addLoop(): void {},
      removeLoop(id: string): void {
        calls.removeLoop.push(id);
      },
      runNow(id: string): void {
        calls.runNow.push(id);
      },
    },
  };
}

/** The MachineGateway core MERGED with the CliGateway run-token verb surface
 *  (`agentApi`), so every existing call site keeps working (mirrors index.test.ts). */
type TestGateway = InstanceType<typeof gatewayMod.MachineGateway> & Pick<InstanceType<typeof cliMod.CliGateway>, "agentApi">;

function gateway(scheduler: object = recordingScheduler().scheduler): TestGateway {
  const core = new gatewayMod.MachineGateway(scheduler as never, undefined);
  const cli = new cliMod.CliGateway(core);
  return Object.assign(core, { agentApi: cli.agentApi.bind(cli) });
}

async function seededMachine(over: { userId?: string; name?: string } = {}) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({
    id: machineId,
    userId: over.userId ?? "u1",
    name: over.name ?? "M",
    tokenHash: tokens.sha256(token),
    online: true,
  });
  return { token, machineId };
}

const readme = (slug: string, extra: Record<string, string> = {}, body = "## Spec\nwork it\n"): string => {
  const fm = Object.entries({ id: slug, title: `Title ${slug}`, ...extra })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}`;
};

/** Seed a small tree on one machine: goal → strategy → 2 leaves. */
async function seededTree(machineId: string) {
  const mk = (slug: string, extra: Record<string, string> = {}, cron: string | null = null) =>
    store.createLoop({
      userId: "u1",
      machineId,
      cron,
      enabled: true,
      notify: "auto",
      taskFile: `/home/u/loopany/${slug}/README.md`,
      taskFileContent: readme(slug, extra),
    });
  const goal = await mk("revenue-growth", { type: "goal", priority: "P0" });
  const strat = await mk("acquisition", { type: "strategy", parent: "revenue-growth", priority: "P1" });
  const leafA = await mk("prompt-library-seo", { type: "experiment", parent: "acquisition", status: "in-progress" }, "0 9 * * 1");
  // Seeds the RETIRED spelling on purpose: the parser must alias review → follow-up.
  const leafB = await mk("billing-interval", { type: "task", parent: "revenue-growth", status: "review", follow_up_date: "2026-01-01" });
  return { goal, strat, leafA, leafB };
}

// ---- device-token surface ----

test("taskList: unfiltered → tree (default depth 2); filtered → flat rows with breadcrumbs", async () => {
  const { token, machineId } = await seededMachine();
  await seededTree(machineId);
  const gw = gateway();

  const tree = await gw.taskList(token);
  expect(tree.status).toBe(200);
  const tbody = tree.body as { mode: string; tree: Array<{ slug: string; children: Array<{ slug: string; children: unknown[] }> }> };
  expect(tbody.mode).toBe("tree");
  expect(tbody.tree).toHaveLength(1);
  expect(tbody.tree[0]!.slug).toBe("revenue-growth");

  const flat = await gw.taskList(token, { status: "follow-up" });
  const fbody = flat.body as { mode: string; rows: Array<{ slug: string; breadcrumb: string[] }> };
  expect(fbody.mode).toBe("flat");
  expect(fbody.rows.map((r) => r.slug)).toEqual(["billing-interval"]);
  expect(fbody.rows[0]!.breadcrumb).toEqual(["Title revenue-growth"]);
});

test("taskList: invalid status enumerates the vocabulary; --due finds arrived reviews", async () => {
  const { token, machineId } = await seededMachine();
  await seededTree(machineId);
  const gw = gateway();

  const bad = await gw.taskList(token, { status: "doing" });
  expect(bad.status).toBe(400);
  expect((bad.body as { error: string }).error).toMatch(/idea, todo, in-progress, follow-up, done, archived/);
  expect((bad.body as { error: string }).error).toMatch(/'doing'/);

  const due = await gw.taskList(token, { due: true });
  expect((due.body as { rows: Array<{ slug: string }> }).rows.map((r) => r.slug)).toEqual(["billing-interval"]);
});

test("taskGet: full node + children rows; slug and loop id both resolve; cross-machine is a flat 404", async () => {
  const { token, machineId } = await seededMachine();
  const { strat } = await seededTree(machineId);
  const gw = gateway();

  const bySlug = await gw.taskGet(token, "acquisition");
  expect(bySlug.status).toBe(200);
  const body = bySlug.body as { task: { slug: string; content: string | null; taskFile: string }; children: Array<{ slug: string }> };
  expect(body.task.slug).toBe("acquisition");
  expect(body.task.content).toContain("## Spec");
  expect(body.children.map((c) => c.slug)).toEqual(["prompt-library-seo"]);

  const byId = await gw.taskGet(token, strat.id);
  expect((byId.body as { task: { slug: string } }).task.slug).toBe("acquisition");

  // `get` absorbed `show`: the body carries the FULL editable envelope, keyed
  // exactly as `edit --json` accepts (id + every EDITABLE_LOOP_FIELDS key).
  const env = (bySlug.body as { envelope: Record<string, unknown> }).envelope;
  expect(env.id).toBe(strat.id);
  for (const k of ["name", "cron", "timezone", "notify", "agent", "enabled", "runAt", "goal", "workflow", "ui", "stateSchema"]) {
    expect(env).toHaveProperty(k);
  }

  const { token: otherToken } = await seededMachine();
  expect((await gw.taskGet(otherToken, "acquisition")).status).toBe(404);
});

test("taskGet --runs appends run history (transcript stripped unless asked)", async () => {
  const { token, machineId } = await seededMachine();
  const { leafA } = await seededTree(machineId);
  await store.addRun({
    loopId: leafA.id,
    userId: "u1",
    machineId,
    phase: "done",
    role: "exec",
    outcome: "exec",
    message: "did the thing",
    ts: new Date().toISOString(),
  });
  const res = await gateway().taskGet(token, "prompt-library-seo", { runs: true });
  const body = res.body as { runs: Array<{ message: string; transcript?: string }> };
  expect(body.runs).toHaveLength(1);
  expect(body.runs[0]!.message).toBe("did the thing");
  expect(body.runs[0]!.transcript).toBeUndefined();
});

test("taskSearch matches content with a snippet; all terms must hit", async () => {
  const { token, machineId } = await seededMachine();
  await seededTree(machineId);
  const gw = gateway();

  const hit = await gw.taskSearch(token, "work it");
  expect((hit.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

  const miss = await gw.taskSearch(token, "work zebra");
  expect((miss.body as { rows: unknown[] }).rows).toHaveLength(0);
});

test("runLoopNow dispatches any task once; refuses paused and already-running", async () => {
  const { token, machineId } = await seededMachine();
  const { goal, leafA } = await seededTree(machineId);
  const { calls, scheduler } = recordingScheduler();
  const gw = gateway(scheduler);

  // Works on a cron-null task.
  expect((await gw.runLoopNow(token, "revenue-growth")).status).toBe(200);
  expect(calls.runNow).toEqual([goal.id]);

  // Open run → 409 with a message, not a silent skip.
  await store.addRun({ loopId: leafA.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const busy = await gw.runLoopNow(token, "prompt-library-seo");
  expect(busy.status).toBe(409);
  expect((busy.body as { error: string }).error).toMatch(/already open/);

  // Paused → 409 teaching resume.
  await store.updateLoop(goal.id, { enabled: false });
  expect((await gw.runLoopNow(token, "revenue-growth")).status).toBe(409);
});

test("createLoop with a slug is idempotent per machine (existing:true, no duplicate)", async () => {
  const { token, machineId } = await seededMachine();
  const gw = gateway();

  const first = await gw.createLoop(token, {
    name: "Cheap geo PPP",
    slug: "cheap-geo-ppp",
    taskFile: "/home/u/loopany/cheap-geo-ppp/README.md",
    taskFileContent: readme("cheap-geo-ppp", { status: "idea" }),
  });
  expect(first.status).toBe(200);
  expect((first.body as { existing?: boolean }).existing).toBeUndefined();

  const retry = await gw.createLoop(token, { slug: "cheap-geo-ppp", taskFile: "whatever/README.md" });
  expect(retry.status).toBe(200);
  expect((retry.body as { existing?: boolean }).existing).toBe(true);
  expect(await store.loopsForMachine(machineId)).toHaveLength(1);

  // A DIFFERENT machine may reuse the slug (idempotency is per-machine).
  const other = await seededMachine();
  const cross = await gw.createLoop(other.token, {
    slug: "cheap-geo-ppp",
    taskFile: "x/README.md",
    taskFileContent: readme("cheap-geo-ppp"),
  });
  expect((cross.body as { existing?: boolean }).existing).toBeUndefined();
});

// ---- run-token subset ----

async function runSlotOn(machineId: string, loopId: string) {
  const run = await store.addRun({ loopId, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  return tokens.registerRunLease({ runId: run.id, loopId, machineId, role: "exec", allowControl: false });
}

test("run-token: done is an alias of report", async () => {
  const { machineId } = await seededMachine();
  const { leafA } = await seededTree(machineId);
  const rt = await runSlotOn(machineId, leafA.id);
  const gw = gateway();

  const res = await gw.agentApi(rt, ["done", "--status", "new", "--message", "found something"]);
  expect(res.status).toBe(200);
  const run = (await store.listRuns(leafA.id, 1))[0]!;
  expect(run.status).toBe("new");
  expect(run.message).toBe("found something");
});

test("run-token: get/search/list read the machine's tree", async () => {
  const { machineId } = await seededMachine();
  const { leafA } = await seededTree(machineId);
  const rt = await runSlotOn(machineId, leafA.id);
  const gw = gateway();

  const get = await gw.agentApi(rt, ["get", "acquisition"]);
  expect(get.status).toBe(200);
  expect((get.body as { text: string }).text).toContain("acquisition");
  expect((get.body as { text: string }).text).toContain("children (1)");

  const search = await gw.agentApi(rt, ["search", "billing"]);
  expect((search.body as { text: string }).text).toContain("billing-interval");

  const list = await gw.agentApi(rt, ["list", "--status", "follow-up"]);
  expect((list.body as { text: string }).text).toContain("billing-interval");
});

test("run-token: create registers an inert task but may never arm a schedule", async () => {
  const { machineId } = await seededMachine();
  const { leafA } = await seededTree(machineId);
  const rt = await runSlotOn(machineId, leafA.id);
  const gw = gateway();

  const scheduled = await gw.agentApi(rt, ["create", "--title", "Evil", "--task-file", "x/README.md", "--cron", "* * * * *"]);
  expect(scheduled.status).toBe(403);

  const before = (await store.loopsForMachine(machineId)).length;
  const ok = await gw.agentApi(rt, [
    "create",
    "--title",
    "Captured idea",
    "--slug",
    "captured-idea",
    "--task-file",
    "/home/u/loopany/captured-idea/README.md",
    "--file-content",
    readme("captured-idea", { type: "idea", status: "idea" }),
  ]);
  expect(ok.status).toBe(200);
  const loops = await store.loopsForMachine(machineId);
  expect(loops).toHaveLength(before + 1);
  const created = loops.find((l) => l.taskMeta?.id === "captured-idea")!;
  expect(created.cron).toBeNull();
  expect(created.teamId).toBe(leafA.teamId);

  // Idempotent on slug.
  const retry = await gw.agentApi(rt, ["create", "--title", "Captured idea", "--slug", "captured-idea", "--task-file", "x"]);
  expect((retry.body as { text: string }).text).toContain("already exists");
  expect(await store.loopsForMachine(machineId)).toHaveLength(before + 1);
});

test("run-token: update writes work-state as fields (file-era rejection retired); cron stays owner-only", async () => {
  const { machineId } = await seededMachine();
  const { leafA, leafB } = await seededTree(machineId);
  const rt = await runSlotOn(machineId, leafA.id);
  const gw = gateway();

  // An inert task's status is an unguarded field write now (flag spelling).
  const status = await gw.agentApi(rt, ["update", "--id", "billing-interval", "--status", "done"]);
  expect(status.status).toBe(200);
  expect((await store.getLoop(leafB.id))!.taskMeta?.status).toBe("done");

  const cron = await gw.agentApi(rt, ["update", "--id", "billing-interval", "--cron", "0 9 * * *"]);
  expect(cron.status).toBe(403);

  const name = await gw.agentApi(rt, ["update", "--id", "billing-interval", "--name", "Billing A/B"]);
  expect(name.status).toBe(200);
  expect((await store.getLoop(leafB.id))!.name).toBe("Billing A/B");
});

test("run-token: delete teaches archived", async () => {
  const { machineId } = await seededMachine();
  const { leafA } = await seededTree(machineId);
  const rt = await runSlotOn(machineId, leafA.id);
  const res = await gateway().agentApi(rt, ["delete", "billing-interval"]);
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/archived/);
});

// ---- team-wide device reads + the config/content write fence ----

/** Two machines, ONE owner (u-team), one team; a third machine owned by a
 *  stranger. The common real-world case: you, two laptops. */
async function seededTeamWorld() {
  await store.ensureTeam("team-A", "Team A", "u-team");
  const m1 = await seededMachine({ userId: "u-team", name: "mbp" });
  const m2 = await seededMachine({ userId: "u-team", name: "studio" });
  const other = await seededMachine({ userId: "u-stranger", name: "intruder" });
  await store.ensureTeam("team-B", "Team B", "u-stranger");
  const mk = (machineId: string, slug: string, teamId: string, extra: Record<string, string> = {}) =>
    store.createLoop({
      userId: "u-team",
      machineId,
      teamId,
      cron: null,
      enabled: false,
      notify: "auto",
      taskFile: `/home/u/loopany/${slug}/README.md`,
      taskFileContent: readme(slug, extra),
    });
  const here = await mk(m1.machineId, "local-task", "team-A");
  const away = await mk(m2.machineId, "away-task", "team-A", { type: "task", status: "todo" });
  const foreign = await store.createLoop({
    userId: "u-stranger",
    machineId: other.machineId,
    teamId: "team-B",
    cron: null,
    enabled: false,
    notify: "auto",
    taskFile: "/home/x/loopany/foreign/README.md",
    taskFileContent: readme("foreign"),
  });
  return { m1, m2, other, here, away, foreign };
}

test("taskList: team-wide by default (+machines map/requester); --here narrows; foreign teams invisible", async () => {
  const w = await seededTeamWorld();
  const gw = gateway();

  const all = await gw.taskList(w.m1.token, { flat: true });
  const body = all.body as { rows: Array<{ slug: string; machineId: string }>; requester: string; machines: Record<string, string> };
  expect(body.rows.map((r) => r.slug).sort()).toEqual(["away-task", "local-task"]);
  expect(body.requester).toBe(w.m1.machineId);
  expect(body.machines[w.m2.machineId]).toBe("studio");
  // The stranger's loop never appears, in any mode.
  expect(body.rows.some((r) => r.slug === "foreign")).toBe(false);

  const here = await gw.taskList(w.m1.token, { flat: true, here: true });
  expect((here.body as { rows: Array<{ slug: string }> }).rows.map((r) => r.slug)).toEqual(["local-task"]);

  // A team the owner is NOT a member of → flat 404 (existence never leaks).
  expect((await gw.taskList(w.m1.token, { flat: true, team: "team-B" })).status).toBe(404);
  const teamA = await gw.taskList(w.m1.token, { flat: true, team: "team-A" });
  expect((teamA.body as { rows: Array<{ slug: string }> }).rows).toHaveLength(2);
});

test("search + log read team-wide; the stranger's loop stays a flat 404", async () => {
  const w = await seededTeamWorld();
  const gw = gateway();

  const hits = await gw.taskSearch(w.m1.token, "away-task");
  expect((hits.body as { rows: Array<{ slug: string }> }).rows.map((h) => h.slug)).toContain("away-task");

  // Run-history read on the teammate-machine loop (same owner) works…
  expect((await gw.renderLoopLog(w.m1.machineId, w.away.id)).status).toBe(200);
  // …the stranger's loop does not exist as far as this credential can tell.
  expect((await gw.renderLoopLog(w.m1.machineId, w.foreign.id)).status).toBe(404);
});

test("write fence: cross-machine CONFIG writes apply; CONTENT writes 403; own-machine unrestricted", async () => {
  const w = await seededTeamWorld();
  const gw = gateway();

  // Config key on the OTHER machine's loop: allowed ("pause my other laptop's loop").
  const pause = await gw.editLoop(w.m1.token, w.away.id, { name: "renamed from mbp" });
  expect(pause.status).toBe(200);
  expect((await store.getLoop(w.away.id))!.name).toBe("renamed from mbp");

  // Content key cross-machine: the lateral-movement fence — 403 naming the split.
  const inject = await gw.editLoop(w.m1.token, w.away.id, { workflow: "return {message: 'pwned'}" });
  expect(inject.status).toBe(403);
  expect((inject.body as { error: string }).error).toContain("machine-local");
  expect((await store.getLoop(w.away.id))!.workflow ?? null).toBeNull();

  // The stranger's loop: flat 404 even for a config write.
  expect((await gw.editLoop(w.m1.token, w.foreign.id, { name: "x" })).status).toBe(404);

  // Own machine: content writes unrestricted (unchanged behavior).
  const own = await gw.editLoop(w.m1.token, w.here.id, { workflow: "return {}" });
  expect(own.status).toBe(200);
});

test("resolve: same slug on two machines → 409 with machine candidates; <machine>/<slug> disambiguates", async () => {
  const w = await seededTeamWorld();
  const gw = gateway();
  // Same slug captured on BOTH machines (the two-react-doctors case).
  await store.createLoop({
    userId: "u-team",
    machineId: w.m2.machineId,
    teamId: "team-A",
    cron: null,
    enabled: false,
    notify: "auto",
    taskFile: "/home/u/loopany/local-task/README.md",
    taskFileContent: readme("local-task"),
  });

  const ambiguous = await gw.resolveTaskRow(w.m1.machineId, "local-task");
  expect("err" in ambiguous && ambiguous.err.status).toBe(409);
  if ("err" in ambiguous) {
    const cands = (ambiguous.err.body as { candidates: Array<{ machineId: string }> }).candidates;
    expect(new Set(cands.map((c) => c.machineId))).toEqual(new Set([w.m1.machineId, w.m2.machineId]));
  }

  // Qualify by machine NAME…
  const byName = await gw.resolveTaskRow(w.m1.machineId, "studio/local-task");
  expect("row" in byName && byName.row.machineId).toBe(w.m2.machineId);
  // …or by machine id.
  const byId = await gw.resolveTaskRow(w.m1.machineId, `${w.m1.machineId}/local-task`);
  expect("row" in byId && byId.row.machineId).toBe(w.m1.machineId);
});

test("loops list: team-wide records carry machine identity; --fields machine renders it", async () => {
  const w = await seededTeamWorld();
  const gw = gateway();
  const r = await gw.listLoops(w.m1.token, "machine");
  expect(r.status).toBe(200);
  const body = r.body as { loops: Array<{ machineId: string; machine: string }>; text: string };
  expect(body.loops).toHaveLength(2);
  expect(new Set(body.loops.map((l) => l.machine))).toEqual(new Set(["mbp", "studio"]));
  expect(body.text).toContain("studio");
});

// ---- executor assignment (`update <id> assignee=<machine>/<agent>`) ----

test("executor assignment re-binds an inert todo task to my other device and dispatches ONCE", async () => {
  const w = await seededTeamWorld();
  const rec = recordingScheduler();
  const gw = gateway(rec.scheduler);
  // A todo, enabled, cron-null task on m1 — the assignable shape.
  const task = await store.createLoop({
    userId: "u-team",
    machineId: w.m1.machineId,
    teamId: "team-A",
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/portable/README.md",
    taskFileContent: readme("portable", { status: "todo" }),
  });

  const r = await gw.editLoop(w.m1.token, task.id, { assignee: "studio/codex" });
  expect(r.status).toBe(200);
  const body = r.body as { applied: string[]; assignee: string; dispatched: boolean };
  expect(body.applied).toEqual(["assignee"]);
  expect(body.assignee).toBe("studio/codex");
  expect(body.dispatched).toBe(true);
  expect(rec.calls.runNow).toEqual([task.id]);
  const after = (await store.getLoop(task.id))!;
  expect(after.machineId).toBe(w.m2.machineId);
  expect(after.agent).toBe("codex");

  // The edge fired once — re-sending the same assignment while a run is open
  // does NOT stack a second dispatch (open-run guard).
  await store.addRun({ loopId: task.id, userId: "u-team", machineId: w.m2.machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const again = await gw.editLoop(w.m1.token, task.id, { assignee: "studio/codex" });
  expect((again.body as { dispatched: boolean }).dispatched).toBe(false);
  expect(rec.calls.runNow).toHaveLength(1);
});

test("executor assignment refuses: loops (fixed executor), strangers' devices, bad agents, non-todo silent", async () => {
  const w = await seededTeamWorld();
  const rec = recordingScheduler();
  const gw = gateway(rec.scheduler);

  // A LOOP (cron set) never re-binds.
  const loop = await store.createLoop({
    userId: "u-team",
    machineId: w.m1.machineId,
    teamId: "team-A",
    cron: "0 9 * * *",
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/scheduled/README.md",
    taskFileContent: readme("scheduled"),
  });
  const fixed = await gw.editLoop(w.m1.token, loop.id, { assignee: "studio/codex" });
  expect(fixed.status).toBe(400);
  expect((fixed.body as { error: string }).error).toContain("fixed");

  // The stranger's machine is not "a device of yours" — flat 404, never leaks.
  const foreign = await gw.editLoop(w.m1.token, w.here.id, { assignee: "intruder/claude-code" });
  expect(foreign.status).toBe(404);

  // Unknown agent enumerates the vocabulary.
  const badAgent = await gw.editLoop(w.m1.token, w.here.id, { assignee: "studio/emacs" });
  expect(badAgent.status).toBe(400);
  expect((badAgent.body as { error: string }).error).toContain("claude-code");

  // A non-todo task re-binds but does NOT dispatch (status is the trigger arm).
  const idle = await gw.editLoop(w.m1.token, w.here.id, { assignee: "studio/claude-code" });
  expect(idle.status).toBe(200);
  expect((idle.body as { dispatched: boolean }).dispatched).toBe(false);
  expect(rec.calls.runNow).toHaveLength(0);
});

test("executor assignment queues instead of flooding: per-machine pending cap holds", async () => {
  const w = await seededTeamWorld();
  const rec = recordingScheduler();
  const gw = gateway(rec.scheduler);
  // Fill m2's pending queue to the cap.
  for (let i = 0; i < gatewayMod.ASSIGN_DISPATCH_MACHINE_CAP; i++) {
    const filler = await store.createLoop({
      userId: "u-team",
      machineId: w.m2.machineId,
      teamId: "team-A",
      cron: null,
      enabled: true,
      notify: "auto",
      taskFile: `/home/u/loopany/filler-${i}/README.md`,
      taskFileContent: readme(`filler-${i}`),
    });
    await store.addRun({ loopId: filler.id, userId: "u-team", machineId: w.m2.machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  }
  const task = await store.createLoop({
    userId: "u-team",
    machineId: w.m1.machineId,
    teamId: "team-A",
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/capped/README.md",
    taskFileContent: readme("capped", { status: "todo" }),
  });
  const r = await gw.editLoop(w.m1.token, task.id, { assignee: "studio/claude-code" });
  expect(r.status).toBe(200);
  const body = r.body as { dispatched: boolean; note?: string };
  expect(body.dispatched).toBe(false);
  expect(body.note).toContain("queued");
  expect(rec.calls.runNow).toHaveLength(0);
  // The re-bind itself still applied — the task waits on its new machine.
  expect((await store.getLoop(task.id))!.machineId).toBe(w.m2.machineId);
});

test("a cron-null dispatch gets the one-shot task prompt (done-contract + snapshot), a loop keeps exec-core", async () => {
  const prompts = await import("./prompt.js");
  const base = {
    id: "loop-x",
    name: "Portable task",
    taskFile: "/home/u/loopany/portable/README.md",
    taskFileContent: "---\nid: portable\n---\n\n## Spec\ndo the thing\n",
    taskMeta: { id: "portable" },
    goal: null,
    stateSchema: null,
  } as never;

  // Legacy daemon (no TASK.md capability): doc inlined READ-ONLY in a fence.
  const oneShot = prompts.buildExecTask({ ...(base as object), cron: null } as never);
  expect(oneShot).toContain("[task run · Portable task]");
  expect(oneShot).toContain("NOT be re-run");
  expect(oneShot).toContain("status=follow-up");
  expect(oneShot).toContain("follow_up_date");
  expect(oneShot).toContain("status=done --note"); // the terminal grammar
  expect(oneShot).not.toContain("loopany report"); // task runs have no report call
  expect(oneShot).toContain("<task-doc>");
  expect(oneShot).toContain("do the thing");
  expect(oneShot).not.toContain("TASK.md"); // no working-copy instructions for a legacy daemon
  expect(oneShot).toContain("update portable"); // slug-addressed verbs

  // Capable daemon: TASK.md working-copy discipline, no inline snapshot.
  const capable = prompts.buildExecTask({ ...(base as object), cron: null } as never, { taskDocCapable: true });
  expect(capable).toContain("TASK.md");
  expect(capable).not.toContain("<task-doc>");

  const recurring = prompts.buildExecTask({ ...(base as object), cron: "0 9 * * *" } as never);
  expect(recurring).toContain("[loop run · Portable task]");
  expect(recurring).not.toContain("NOT be re-run");
});

test("follow-up date arrival dispatches ONE outcome check, never re-fires for the same date", async () => {
  const w = await seededTeamWorld();
  const rec = recordingScheduler();
  const gw = gateway(rec.scheduler);
  const shipped = await store.createLoop({
    userId: "u-team",
    machineId: w.m1.machineId,
    teamId: "team-A",
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/shipped-thing/README.md",
    taskFileContent: readme("shipped-thing", { status: "follow-up", follow_up_date: "2026-01-02" }),
  });
  const notYet = await store.createLoop({
    userId: "u-team",
    machineId: w.m1.machineId,
    teamId: "team-A",
    cron: null,
    enabled: true,
    notify: "auto",
    taskFile: "/home/u/loopany/future-thing/README.md",
    taskFileContent: readme("future-thing", { status: "follow-up", follow_up_date: "2099-01-01" }),
  });

  await gw.sweep();
  expect(rec.calls.runNow).toEqual([shipped.id]); // arrived date fires; future date does not

  // The check ran (a run started after the date) → the same date never re-fires.
  await store.addRun({ loopId: shipped.id, userId: "u-team", machineId: w.m1.machineId, phase: "done", role: "exec", outcome: "exec", ts: new Date().toISOString() });
  await gw.sweep();
  expect(rec.calls.runNow).toHaveLength(1);
  expect(rec.calls.runNow.filter((id) => id === notYet.id)).toHaveLength(0);

  // The follow-up dispatch prompt names the WHY (outcome check, the date).
  const prompts = await import("./prompt.js");
  const text = prompts.buildExecTask((await store.getLoop(shipped.id))!);
  expect(text).toContain("follow_up_date (2026-01-02) arrived");
  expect(text).toContain("OUTCOME CHECK");
});

// ---- doc push (`update --doc-file`): base-hash precondition + open-run refusal ----

test("doc push: fresh base applies + emits doc-updated; stale base → 409 with the diff", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  const original = readme("exp-doc", {}, "## Spec\noriginal spec\n");
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/home/u/loopany/exp-doc/README.md", taskFileContent: original,
  });

  const edited = readme("exp-doc", {}, "## Spec\noriginal spec\n\n## Current understanding\nlearned a thing\n");
  const r = await gw.editLoop(token, task.id, { doc: edited, docBase: sha(original) });
  expect(r.status).toBe(200);
  expect((r.body as { docHash: string }).docHash).toBe(sha(edited));
  expect((await store.getLoop(task.id))!.taskFileContent).toBe(edited);
  const evs = await store.listEvents(task.id, { limit: 5 });
  expect(evs.some((e) => e.type === "doc-updated")).toBe(true);

  // A second push from the ORIGINAL (now stale) base is refused with the diff.
  const conflicting = readme("exp-doc", {}, "## Spec\nconflicting rewrite\n");
  const stale = await gw.editLoop(token, task.id, { doc: conflicting, docBase: sha(original) });
  expect(stale.status).toBe(409);
  const body = stale.body as { diff: string; docHash: string };
  expect(body.docHash).toBe(sha(edited));
  expect(body.diff).toContain("learned a thing"); // the server side of the diff
  // The doc is untouched by the refused push.
  expect((await store.getLoop(task.id))!.taskFileContent).toBe(edited);
});

test("doc push during an open run is refused naming the run; identical-content push is a no-op", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  const content = readme("exp-busy", {}, "## Spec\nx\n");
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/home/u/loopany/exp-busy/README.md", taskFileContent: content,
  });
  const run = await store.addRun({ loopId: task.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });

  const refused = await gw.editLoop(token, task.id, { doc: "## Spec\nnew\n", docBase: sha(content) });
  expect(refused.status).toBe(409);
  expect((refused.body as { error: string }).error).toContain(run.id);

  // Run ends → an identical-content push succeeds without an event (nothing changed).
  await store.updateRun(run.id, { phase: "done", outcome: "exec" });
  const noop = await gw.editLoop(token, task.id, { doc: content, docBase: sha(content) });
  expect(noop.status).toBe(200);
  expect((noop.body as { text: string }).text).toContain("unchanged");
  expect((await store.countEvents(task.id))).toBe(0);

  // doc must ride alone — mixing it with field keys is a usage error.
  const mixed = await gw.editLoop(token, task.id, { doc: content, docBase: sha(content), name: "x" });
  expect(mixed.status).toBe(400);
});

// ---- U-transition guards: one write verb, server-enforced per-transition rules ----

async function runLease(over: Partial<{ loopId: string; machineId: string; canFinish: boolean; role: "exec" | "evolve" | "edit" }>) {
  const run = await store.addRun({ loopId: over.loopId!, userId: "u1", machineId: over.machineId!, phase: "running", role: over.role ?? "exec", ts: new Date().toISOString() });
  const rt = await tokens.registerRunLease({
    runId: run.id, loopId: over.loopId!, machineId: over.machineId!, role: over.role ?? "exec",
    allowControl: true, canSetUi: false, canSetSchema: false, canSetWorkflow: false, canFinish: over.canFinish ?? false,
  });
  return { run, rt };
}

test("run update writes work-state on a TASK unguarded; report on a task run teaches the grammar", async () => {
  const gw = gateway();
  const { machineId } = await seededMachine();
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/exp-t/README.md", taskFileContent: readme("exp-t", { status: "in-progress" }),
  });
  const { rt } = await runLease({ loopId: task.id, machineId });

  // The old file-era rejection is gone: status/priority write as fields.
  const r = await gw.agentApi(rt, ["update", "exp-t", "status=done", "priority=P1", "--note", "shipped the fix"]);
  expect(r.status).toBe(200);
  const after = (await store.getLoop(task.id))!;
  expect(after.taskMeta?.status).toBe("done");
  expect(after.taskMeta?.priority).toBe("P1");
  const evs = await store.listEvents(task.id, { limit: 10 });
  expect(evs.map((e) => e.type).sort()).toEqual(["note", "status-changed"]);
  expect(evs.find((e) => e.type === "status-changed")!.actor).toContain("agent:");

  // `report` on a task run is a teaching 400 naming the new grammar.
  const rep = await gw.agentApi(rt, ["report", "--status", "resolved", "--message", "x"]);
  expect(rep.status).toBe(400);
  expect((rep.body as { text: string }).text).toContain("status=done --note");
});

test("guarded done-transition on a goal loop: note required, atomic completion, once-only", async () => {
  const gw = gateway();
  const { machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId, cron: "0 9 * * *", enabled: true, notify: "never", goal: "MRR back to 12k",
    taskFile: "/h/loopany/goal-x/README.md", taskFileContent: readme("goal-x", { status: "in-progress" }),
  });
  const { rt } = await runLease({ loopId: loop.id, machineId, canFinish: true });

  // Bare status=done → the guard demands the completion evidence.
  const bare = await gw.agentApi(rt, ["update", "goal-x", "status=done"]);
  expect(bare.status).toBe(400);
  expect((bare.body as { text: string }).text).toContain("--note");

  // With the note → atomic bundle: completedAt + schedule paused + status stamped.
  const done = await gw.agentApi(rt, ["update", "goal-x", "status=done", "--note", "hit 12.1k for 2 weeks"]);
  expect(done.status).toBe(200);
  const after = (await store.getLoop(loop.id))!;
  expect(after.completedAt).toBeTruthy();
  expect(after.completionReason).toBe("hit 12.1k for 2 weeks");
  expect(after.enabled).toBe(false);
  expect(after.taskMeta?.status).toBe("done");

  // Once-only: the repeat is a legible CONFLICT, not a silent re-stamp.
  const again = await gw.agentApi(rt, ["update", "goal-x", "status=done", "--note", "again"]);
  expect(again.status).toBe(409);
});

test("open-monitor run may not close its loop (403); goal cleared mid-run refuses the transition", async () => {
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  const monitor = await store.createLoop({
    userId: "u1", machineId, cron: "0 6 * * *", enabled: true, notify: "never",
    taskFile: "/h/loopany/mon-x/README.md", taskFileContent: readme("mon-x"),
  });
  const { rt } = await runLease({ loopId: monitor.id, machineId, canFinish: false });
  const denied = await gw.agentApi(rt, ["update", "mon-x", "status=done", "--note", "looks done to me"]);
  expect(denied.status).toBe(403);

  // TOCTOU: the loop HAD a goal at claim (canFinish minted) but it was cleared mid-run.
  const goal = await store.createLoop({
    userId: "u1", machineId, cron: "0 6 * * *", enabled: true, notify: "never", goal: "ship it",
    taskFile: "/h/loopany/goal-y/README.md", taskFileContent: readme("goal-y"),
  });
  const { rt: rt2 } = await runLease({ loopId: goal.id, machineId, canFinish: true });
  await gateway().editLoop(token, goal.id, { goal: null });
  const refused = await gw.agentApi(rt2, ["update", "goal-y", "status=done", "--note", "met"]);
  expect(refused.status).toBe(400);
  expect((refused.body as { text: string }).text).toContain("goal");
});

test("finish --reason is the same transition as update status=done --note (equivalence)", async () => {
  const gw = gateway();
  const { machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId, cron: "0 9 * * *", enabled: true, notify: "never", goal: "done when green",
    taskFile: "/h/loopany/goal-z/README.md", taskFileContent: readme("goal-z", { status: "in-progress" }),
  });
  const { rt } = await runLease({ loopId: loop.id, machineId, canFinish: true });
  const r = await gw.agentApi(rt, ["finish", "--message", "all green", "--reason", "CI green 7 days"]);
  expect(r.status).toBe(200);
  const after = (await store.getLoop(loop.id))!;
  expect(after.completedAt).toBeTruthy();
  expect(after.completionReason).toBe("CI green 7 days");
  expect(after.enabled).toBe(false);
  expect(after.taskMeta?.status).toBe("done"); // the field plane is stamped like the update spelling
  const evs = await store.listEvents(loop.id, { limit: 10 });
  expect(evs.some((e) => e.type === "status-changed")).toBe(true);

  // report on a LOOP run stays unchanged.
  const loop2 = await store.createLoop({
    userId: "u1", machineId, cron: "0 9 * * *", enabled: true, notify: "never",
    taskFile: "/h/loopany/loop-r/README.md", taskFileContent: readme("loop-r"),
  });
  const { rt: rt2 } = await runLease({ loopId: loop2.id, machineId });
  expect((await gw.agentApi(rt2, ["report", "--status", "new", "--message", "tick"])).status).toBe(200);
});

// ---- run auto-close: the record synthesizes from exit + events; TASK.md rides the report ----

test("task-run auto-close: record synthesizes from events, close doc push applies, one notification on terminal", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const sent: string[] = [];
  const core = new gatewayMod.MachineGateway(
    recordingScheduler().scheduler as never,
    undefined,
    (async (_loop: unknown, message: string) => void sent.push(message)) as never,
  );
  const cli = new cliMod.CliGateway(core);
  const { token, machineId } = await seededMachine();
  const doc = readme("close-x", { status: "in-progress" }, "## Spec\ndo the thing\n");
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/close-x/README.md", taskFileContent: doc,
  });

  // Claim via poll so the delivery carries the doc + its hash.
  await store.addRun({ loopId: task.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const poll = await core.poll(token, { version: "test" });
  const delivery = ((poll.body as { deliveries?: Array<Record<string, unknown>> }).deliveries ?? [])[0]!;
  const dLoop = delivery.loop as { taskDoc?: string; taskDocHash?: string };
  expect(dLoop.taskDoc).toBe(doc);
  expect(dLoop.taskDocHash).toBe(sha(doc));
  const rt = delivery.runToken as string;

  // The run works: sets status=done (guardless — inert task) with a note.
  await cli.agentApi(rt, ["update", "close-x", "status=done", "--note", "merged the fix"]);

  // Process exit → the daemon's close report: exit 0, edited TASK.md attached.
  const edited = `${doc}\n## Current understanding\nfixed by narrowing the retry\n`;
  const rep = await core.report(rt, { ok: true, taskDoc: edited, taskDocBase: sha(doc) });
  expect(rep.status).toBe(200);

  const run = (await store.listRuns(task.id, 5))[0]!;
  expect(run.phase).toBe("done");
  expect(run.message).toContain("status → done");
  expect(run.message).toContain("1 note");
  expect(run.status).toBe("resolved");
  // Doc pushed + recorded — the run's OWN server-side field write (status=done)
  // made the claim base stale, so the close MERGES: pushed body + current front
  // matter (the working copy must never revert the run's own field writes).
  const merged = (await store.getLoop(task.id))!.taskFileContent!;
  expect(merged).toContain("## Current understanding");
  expect(merged).toContain("fixed by narrowing the retry");
  expect(merged).toContain("status: done");
  // Lease retired (a second report 401s).
  const evs = await store.listEvents(task.id, { limit: 10 });
  expect(evs.filter((e) => e.type === "doc-updated")).toHaveLength(1);
  expect((await core.report(rt, { ok: true })).status).toBe(401);
  // Terminal status change → exactly one notification.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("status → done");
});

test("task-run auto-close with nothing recorded: honest inconclusive record, no notification, unchanged doc = no event", async () => {
  const sent: string[] = [];
  const core = new gatewayMod.MachineGateway(
    recordingScheduler().scheduler as never,
    undefined,
    (async (_l: unknown, m: string) => void sent.push(m)) as never,
  );
  const { token, machineId } = await seededMachine();
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/idle-x/README.md", taskFileContent: readme("idle-x", { status: "todo" }),
  });
  await store.addRun({ loopId: task.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const poll = await core.poll(token, { version: "test" });
  const rt = ((poll.body as { deliveries?: Array<{ runToken: string }> }).deliveries ?? [])[0]!.runToken;

  // Exit 0, no events, no doc change (daemon sends no taskDoc when hash matches).
  const rep = await core.report(rt, { ok: true });
  expect(rep.status).toBe(200);
  const run = (await store.listRuns(task.id, 5))[0]!;
  expect(run.phase).toBe("done");
  expect(run.message).toContain("task unchanged");
  expect(run.status).toBe("nothing-new");
  expect((await store.getLoop(task.id))!.taskMeta?.status).toBe("todo"); // visibly still todo
  expect(sent).toHaveLength(0);
  expect((await store.listEvents(task.id, { limit: 10 })).filter((e) => e.type === "doc-updated")).toHaveLength(0);
});

test("a stale close after reclaim never clobbers a doc the owner advanced (sleep/wake case)", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const core = new gatewayMod.MachineGateway(recordingScheduler().scheduler as never, undefined);
  const { token, machineId } = await seededMachine();
  const doc = readme("stale-x", {}, "## Spec\nx\n");
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "never",
    taskFile: "/h/loopany/stale-x/README.md", taskFileContent: doc,
  });
  await store.addRun({ loopId: task.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const poll = await core.poll(token, { version: "test" });
  const d = ((poll.body as { deliveries?: Array<{ runToken: string; runId: string }> }).deliveries ?? [])[0]!;

  // Machine goes unreachable mid-run: the sweep reclaims it as a false error and
  // terminalizes the lease (grace) — then the OWNER merges the doc (the run is
  // no longer open, so the push is allowed and recorded).
  await store.updateRun(d.runId, { phase: "error", error: "machine unreachable" });
  await tokens.terminalizeLease(d.runId);
  const advanced = `${doc}\nowner merged this\n`;
  const push = await core.editLoop(token, task.id, { doc: advanced, docBase: sha(doc) });
  expect(push.status).toBe(200);

  // The machine wakes and delivers its close, still carrying the claim-base copy.
  const rep = await core.report(d.runToken, { ok: false, error: "agent crashed", taskDoc: `${doc}\nrun's stale copy\n`, taskDocBase: sha(doc) });
  expect(rep.status).toBe(200);
  expect((await store.getLoop(task.id))!.taskFileContent).toBe(advanced); // never clobbered
  const run = (await store.listRuns(task.id, 5))[0]!;
  expect(run.phase).toBe("error");
  expect(run.error).toContain("agent crashed");
});

// ---- inbox surfacing: the home `needs you` line + the get rollup ----

test("home: needs-you lists assigned-open tasks + arrived follow-ups; absent when empty", async () => {
  const { token, machineId } = await seededMachine();
  await (db.client as any).exec(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U One', 'u1@x.dev', true, now(), now()) ON CONFLICT (id) DO NOTHING;`,
  );
  const core = new gatewayMod.MachineGateway(recordingScheduler().scheduler as never, undefined);
  const cli = new cliMod.CliGateway(core);

  // Empty inbox first: the line is ABSENT (absence is the answer).
  const quiet = await cli.cli(token, ["home"]);
  expect((quiet.body as { text: string }).text).not.toContain("needs you");

  const mk = (slug: string, extra: Record<string, string>) =>
    store.createLoop({
      userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
      taskFile: `/h/loopany/${slug}/README.md`, taskFileContent: readme(slug, extra),
    });
  await mk("mine-a", { status: "in-progress", assignee: "u1@x.dev" });
  await mk("mine-b", { status: "todo", assignee: "u1@x.dev" });
  await mk("due-c", { status: "follow-up", follow_up_date: "2026-01-01" });
  await mk("not-mine", { status: "todo", assignee: "sam@x.dev" });
  await mk("not-yet", { status: "follow-up", follow_up_date: "2099-01-01" });

  const r = await cli.cli(token, ["home"]);
  const text = (r.body as { text: string }).text;
  expect(text).toContain("needs you[3]");
  expect(text).toContain("mine-a");
  expect(text).toContain("follow-up due 2026-01-01");
  expect(text).not.toContain("not-mine");
  expect(text).not.toContain("not-yet");
});

test("get rollup: children grouped by status with counts; terminal groups summarized, not enumerated", async () => {
  const { token, machineId } = await seededMachine();
  const gw = gateway();
  await store.createLoop({
    userId: "u1", machineId, cron: "0 9 * * *", enabled: true, notify: "auto",
    taskFile: "/h/loopany/parent-l/README.md", taskFileContent: readme("parent-l", { type: "strategy" }),
  });
  const mk = (slug: string, status: string) =>
    store.createLoop({
      userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
      taskFile: `/h/loopany/${slug}/README.md`, taskFileContent: readme(slug, { parent: "parent-l", status }),
    });
  await mk("kid-1", "todo");
  await mk("kid-2", "todo");
  await mk("kid-3", "in-progress");
  await mk("kid-4", "done");
  await mk("kid-5", "done");

  const r = await gw.taskGet(token, "parent-l");
  const body = r.body as { rollup: Array<{ status: string; count: number; top?: string[] }>; recentEvents: unknown[] };
  const byStatus = Object.fromEntries(body.rollup.map((g) => [g.status, g]));
  expect(byStatus["todo"]).toMatchObject({ count: 2, top: ["kid-1", "kid-2"] });
  expect(byStatus["in-progress"]).toMatchObject({ count: 1 });
  expect(byStatus["done"]!.count).toBe(2);
  expect(byStatus["done"]!.top).toBeUndefined(); // summarized, never enumerated
  expect(Array.isArray(body.recentEvents)).toBe(true); // the recurring node's record line
});

// ---- assignee roster warning (warn-not-block; open mode exempt) ----

test("assignee off the team roster: update warns but applies; on-roster and open mode stay silent", async () => {
  const { user: userTable } = await import("../db/auth-schema.js");
  const now = new Date(0);
  await db.db
    .insert(userTable)
    .values({ id: "u-roster", name: "u-roster", email: "alice@x.dev", emailVerified: true, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
  await store.ensureTeam("team-roster-test", "T", "u1");
  await store.addTeamMember("team-roster-test", "u1", "owner"); // the machine owner — puts the team in their list
  await store.addTeamMember("team-roster-test", "u-roster", "member"); // alice@x.dev — the on-roster assignee

  const { token, machineId } = await seededMachine(); // userId u1 = gated-style owner
  const gw = gateway();
  const loop = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/roster-t/README.md", taskFileContent: readme("roster-t"),
  });

  // Off-roster email → applied + warning.
  const off = await gw.editLoop(token, loop.id, { taskFileContent: readme("roster-t", { assignee: "stranger@x.dev" }) } as Record<string, unknown>);
  expect(off.status).toBe(200);
  const offBody = off.body as { warning?: string; text: string };
  expect(offBody.warning).toContain("stranger@x.dev");
  expect(offBody.text).toContain("warning:");
  expect((await store.getLoop(loop.id))!.taskMeta?.assignee).toBe("stranger@x.dev");

  // Unchanged assignee on a later edit → no re-warn.
  const again = await gw.editLoop(token, loop.id, { taskFileContent: readme("roster-t", { assignee: "stranger@x.dev", status: "todo" }) } as Record<string, unknown>);
  expect((again.body as { warning?: string }).warning).toBeUndefined();

  // On-roster email → silent.
  const on = await gw.editLoop(token, loop.id, { taskFileContent: readme("roster-t", { assignee: "alice@x.dev" }) } as Record<string, unknown>);
  expect((on.body as { warning?: string }).warning).toBeUndefined();

  // Create with an off-roster assignee warns too.
  const created = await gw.createLoop(token, {
    name: "Roster C", slug: "roster-c", taskFileContent: readme("roster-c", { assignee: "ghost@x.dev" }),
  });
  expect((created.body as { warning?: string }).warning).toContain("ghost@x.dev");

  // Open mode ("shared" owner): no membership concept, never warns.
  const shared = await seededMachine({ userId: "shared" });
  const gw2 = gateway();
  const sharedLoop = await store.createLoop({
    userId: "shared", machineId: shared.machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/roster-s/README.md", taskFileContent: readme("roster-s"),
  });
  const open = await gw2.editLoop(shared.token, sharedLoop.id, { taskFileContent: readme("roster-s", { assignee: "anyone@x.dev" }) } as Record<string, unknown>);
  expect((open.body as { warning?: string }).warning).toBeUndefined();
});

test("doc push while a run is merely PENDING (unclaimed) succeeds — the lease starts at claim", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  const content = readme("exp-parked", {}, "## Spec\nx\n");
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/home/u/loopany/exp-parked/README.md", taskFileContent: content,
  });
  // A dispatched-but-unclaimed run (daemon offline): phase pending.
  const run = await store.addRun({ loopId: task.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });

  const edited = content.replace("## Spec\nx\n", "## Spec\nx\nrefined while parked\n");
  const push = await gw.editLoop(token, task.id, { doc: edited, docBase: sha(content) });
  expect(push.status).toBe(200);
  expect((await store.getLoop(task.id))!.taskFileContent).toBe(edited);

  // Once CLAIMED (running), the same push shape is refused again.
  await store.updateRun(run.id, { phase: "running" });
  const refused = await gw.editLoop(token, task.id, { doc: content, docBase: sha(edited) });
  expect(refused.status).toBe(409);
  expect((refused.body as { error: string }).error).toContain(run.id);
});

test("taskGet merges stored events with legacy doc-Timeline lines, deduped by (day, text)", async () => {
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  // A legacy-era doc still carrying a Timeline section with two dated lines.
  const doc = `${readme("legacy-tl")}\n## Timeline\n- 2026-07-01 | Created.\n- 2026-07-02 | Shipped v1.\n`;
  const task = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/legacy-tl/README.md", taskFileContent: doc,
  });
  // One stored event DUPLICATES a doc line (same day + text — the seeded case);
  // one is events-only (a cloud note).
  await store.addEvent({ loopId: task.id, type: "note", actor: "x", at: "2026-07-02T00:00:00.000Z", text: "Shipped v1." });
  await store.addEvent({ loopId: task.id, type: "note", actor: "y", text: "cloud-only note" });

  const r = await gw.taskGet(token, "legacy-tl");
  const tl = (r.body as { timeline: Array<{ text: string | null }> }).timeline;
  const texts = tl.map((e) => e.text);
  expect(texts).toContain("Created."); // doc-only line survives
  expect(texts).toContain("cloud-only note"); // events-only survives
  expect(texts.filter((t) => t === "Shipped v1.")).toHaveLength(1); // deduped, never doubled
});

test("createLoop emits a Created. event (the scaffold no longer bakes a Timeline line)", async () => {
  const gw = gateway();
  const { token } = await seededMachine();
  const made = await gw.createLoop(token, { name: "Birth", slug: "birth-ev", taskFileContent: readme("birth-ev") });
  expect(made.status).toBe(200);
  const id = (made.body as { id: string }).id;
  const evs = await store.listEvents(id, { limit: 5 });
  expect(evs.some((e) => e.text === "Created." && e.type === "note")).toBe(true);
});

// ---- F5: artifact search ----

test("search matches markdown ARTIFACTS (path/title/content), skips binary/oversize, bounded", async () => {
  const { createHash } = await import("node:crypto");
  const { createBlobStore } = await import("./blobstore.js");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const blobStore = createBlobStore(); // in-memory under vitest
  const gw = new gatewayMod.MachineGateway(recordingScheduler().scheduler as never, blobStore);
  const { token, machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/seo-engine/README.md", taskFileContent: readme("seo-engine"),
  });

  // A content-matching report artifact.
  const report = "---\ntype: report\ntitle: Weekly SEO snapshot\n---\n\nkeyword drift on wireframe generator page\n";
  await blobStore.put(sha(report), Buffer.from(report));
  await store.recordBlob(sha(report), report.length, false, { type: "report", title: "Weekly SEO snapshot" });
  await store.upsertArtifactFile({ loopId: loop.id, path: "reports/2026-07-20.md", hash: sha(report), size: report.length, binary: false, oversize: false, lastRunId: null });

  // A binary file that would match by path — must be skipped.
  await store.upsertArtifactFile({ loopId: loop.id, path: "wireframe-shot.md.png", hash: sha("img"), size: 10, binary: true, oversize: false, lastRunId: null });

  // Content match (bytes read from the blob store).
  const r = await gw.taskSearch(token, "wireframe drift");
  expect(r.status).toBe(200);
  const body = r.body as { rows: unknown[]; artifacts: Array<{ path: string; title: string | null; snippet: string | null }> };
  expect(body.artifacts).toHaveLength(1);
  expect(body.artifacts[0]!.path).toBe("reports/2026-07-20.md");
  expect(body.artifacts[0]!.title).toBe("Weekly SEO snapshot");
  expect(body.artifacts[0]!.snippet).toContain("keyword drift");

  // Title/path match without content terms also hits (metadata-only, no bytes needed).
  const t = await gw.taskSearch(token, "snapshot");
  expect(((t.body as { artifacts: unknown[] }).artifacts)).toHaveLength(1);

  // No artifact match → empty artifacts array, task rows unaffected.
  const none = await gw.taskSearch(token, "zebra unicorn");
  expect(((none.body as { artifacts: unknown[] }).artifacts)).toHaveLength(0);
});

// ---- F7: review queue (needs-review artifacts, hash-keyed dismissal) ----

test("review queue: flagged artifact appears, clear dismisses, content change re-surfaces", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const gw = gateway();
  const { token, machineId } = await seededMachine();
  const loop = await store.createLoop({
    userId: "u1", machineId, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/reddit-loop/README.md", taskFileContent: readme("reddit-loop"),
  });

  // A drafted reply flagged for human eyes (front-matter status → blobs.meta at ingress).
  const draft = "---\ntype: draft\ntitle: Reply to r/webdev thread\nstatus: needs-review\ndue: 2026-07-28\n---\nDraft body v1\n";
  const { artifactMeta } = await import("../server/frontmatter.js");
  await store.recordBlob(sha(draft), draft.length, false, artifactMeta(draft));
  await store.upsertArtifactFile({ loopId: loop.id, path: "drafts/reply-1.md", hash: sha(draft), size: draft.length, binary: false, oversize: false, lastRunId: null });

  // 1. Queued.
  let q = await gw.reviewQueue(token);
  let items = (q.body as { items: Array<{ task: string; path: string; title: string | null; due: string | null; hash: string }> }).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ task: "reddit-loop", path: "drafts/reply-1.md", title: "Reply to r/webdev thread", due: "2026-07-28" });

  // 2. A non-flagged artifact never queues.
  const plain = "---\ntype: report\ntitle: Daily report\n---\nAll good\n";
  await store.recordBlob(sha(plain), plain.length, false, artifactMeta(plain));
  await store.upsertArtifactFile({ loopId: loop.id, path: "reports/day.md", hash: sha(plain), size: plain.length, binary: false, oversize: false, lastRunId: null });
  q = await gw.reviewQueue(token);
  expect((q.body as { items: unknown[] }).items).toHaveLength(1);

  // 3. Clear dismisses (idempotent), queue empties.
  const clear = await gw.reviewClear(token, "reddit-loop", "drafts/reply-1.md");
  expect(clear.status).toBe(200);
  await gw.reviewClear(token, "reddit-loop", "drafts/reply-1.md"); // idempotent
  q = await gw.reviewQueue(token);
  expect((q.body as { items: unknown[] }).items).toHaveLength(0);

  // 4. Content changes (still flagged) → NEW hash → re-surfaces for fresh eyes.
  const v2 = draft.replace("Draft body v1", "Draft body v2 — reworded");
  await store.recordBlob(sha(v2), v2.length, false, artifactMeta(v2));
  await store.upsertArtifactFile({ loopId: loop.id, path: "drafts/reply-1.md", hash: sha(v2), size: v2.length, binary: false, oversize: false, lastRunId: null });
  q = await gw.reviewQueue(token);
  items = (q.body as { items: Array<{ hash: string }> }).items as never;
  expect(items).toHaveLength(1);
  expect(items[0]!.hash).toBe(sha(v2));

  // 5. Clearing a nonexistent artifact is a teaching 404.
  const bad = await gw.reviewClear(token, "reddit-loop", "no/such.md");
  expect(bad.status).toBe(404);
});
