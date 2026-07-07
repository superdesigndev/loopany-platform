import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");
let notifyMod: typeof import("./notify.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-gateway-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  // Must be set BEFORE importing the gateway (which loads superadmin.ts, read once
  // at module load) so the cross-team superadmin-authorization test below works.
  process.env.LOOPANY_SUPERADMINS = "admin@example.com";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
  notifyMod = await import("./notify.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function gateway(
  notify?: (loop: any, message: string) => Promise<void>,
): InstanceType<typeof gatewayMod.MachineGateway> {
  return new gatewayMod.MachineGateway(
    {
      maybeFlagEvolve(): void {},
      finishEvolution(): void {},
      finishEdit(): void {},
      addLoop(): void {},
      removeLoop(): void {},
      runNow(): void {},
    } as any,
    undefined, // default in-memory blobstore
    notify,
  );
}

/** A recording notifier: captures (loopId, message) instead of pushing to a channel. */
function recordingNotify() {
  const sent: Array<{ loopId: string; message: string }> = [];
  const fn = (loop: any, message: string): Promise<void> => {
    sent.push({ loopId: loop.id, message });
    return Promise.resolve();
  };
  return { sent, fn };
}

/** Seed a loop with an exec run already RUNNING, ready for a report() call. */
async function seededExecRun(notify: "always" | "auto" | "never" = "auto") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  return { machineId, loop, run, rt };
}

/** Insert a team (+ optional member rows) directly, bypassing store.ensureTeam's
 *  memo/rename side effects so each test controls membership precisely. */
async function makeTeam(id: string, memberUserIds: string[] = []): Promise<void> {
  const ts = new Date().toISOString();
  await (db.client as any).exec(`INSERT INTO teams (id, name, owner_user_id, created_at) VALUES ('${id}', '${id}', NULL, '${ts}') ON CONFLICT DO NOTHING`);
  for (const u of memberUserIds) {
    await (db.client as any).exec(
      `INSERT INTO team_members (id, team_id, user_id, role, created_at) VALUES ('${id}:${u}', '${id}', '${u}', 'member', '${ts}') ON CONFLICT DO NOTHING`,
    );
  }
}

async function seededLoop() {
  const machine = (await store.createMachine({ id: "m-gateway", userId: "u1", name: "M", tokenHash: "h", online: true }));
  const loop = (await store.createLoop({
    userId: "u1",
    machineId: machine.id,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    stateSchema: [{ key: "mrr" }],
    ui: "<h3>{{latest.mrr}}</h3>",
  }));
  const run = (await store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: machine.id,
    phase: "running",
    role: "evolve",
    ts: new Date().toISOString(),
    state: { mrr: 10 },
  }));
  return { machine, loop, run };
}

test("set-ui is only allowed for an evolution run token and is audited", async () => {
  const { loop, machine, run } = (await seededLoop());
  const execToken = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: true,
  });
  const rejected = (await gateway().agentApi(execToken, ["set-ui", "--file-content", "<h3>Denied</h3>"]));
  expect(rejected.status).toBe(403);

  const evolveToken = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const ok = (await gateway().agentApi(evolveToken, ["set-ui", "--file-content", "<h3>{{latest.mrr}}</h3>"]));
  expect(ok.status).toBe(200);
  expect((await store.getLoop(loop.id))!.ui).toBe("<h3>{{latest.mrr}}</h3>");
  expect((await store.getRun(run.id))!.control?.[0]?.command).toBe("set-ui");
  expect((await store.getRun(run.id))!.control?.[0]?.result).toBe("ok");
});

test("show reports the run's effective self-schedule capability", async () => {
  const { loop, machine, run } = (await seededLoop());
  const gw = gateway();
  const showText = async (allowControl: boolean, role: "exec" | "evolve" = "exec") => {
    const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role, allowControl });
    return ((await gw.agentApi(rt, ["show"])).body as { text: string }).text;
  };
  // A run that MAY self-schedule reads `allowed`; one that may not reads `off`.
  const allowed = (await showText(true));
  expect(allowed).toContain("selfSchedule: allowed");
  // cron carries spaces → TOON-quoted inside the envelope block.
  expect(allowed).toContain(`cron: "${loop.cron}"`);
  const off = (await showText(false));
  expect(off).toContain("selfSchedule: off");
  // An evolve/edit pass carries the effective (structural) capability, so it reads allowed.
  expect((await showText(true, "evolve"))).toContain("selfSchedule: allowed");
});

test("help (and a bare/unknown-flag invocation) returns role-aware usage", async () => {
  const { loop, machine, run } = (await seededLoop());
  const execToken = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const gw = gateway();
  const helpText = async (argv: string[]) => {
    const res = (await gw.agentApi(execToken, argv));
    expect(res.status).toBe(200);
    return (res.body as { text: string }).text;
  };
  for (const argv of [["help"], ["--help"], []]) {
    const text = (await helpText(argv));
    // The §4.9 TOON: a `verbs:` top key with grouped, typed lists + a trailing help[].
    expect(text).toContain("verbs:");
    expect(text).toContain("always[3]{verb,syntax}:");
    expect(text).toContain("report");
    expect(text).toContain("reschedule");
    expect(text).toContain("help[2]:");
  }
  // An exec run can't set-* or control → the availability TAGS say so, not "available".
  const execHelp = (await helpText(["help"]));
  expect(execHelp).toContain('dashboard/gate: evolve/edit pass only — this run is "exec"');
  expect(execHelp).toContain("schedule[4]{verb,syntax}: needs allowControl (off for this loop)");
  expect(execHelp).toContain('finish: exec run on a goal (closed) loop only — this run is "exec"');

  // An evolve run with the caps sees those same tags FLIP to available.
  const evolveToken = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const evolveHelp = ((await gw.agentApi(evolveToken, ["help"])).body as { text: string }).text;
  expect(evolveHelp).toContain("dashboard/gate: available to this run");
  expect(evolveHelp).toContain("schedule[4]{verb,syntax}: available to this run");
});

test("set-schema rejects dropping keys still used by UI or recent runs", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetSchema: true,
  });
  const res = (await gateway().agentApi(token, ["set-schema", "--file-content", JSON.stringify([{ key: "paid" }])]));

  expect(res.status).toBe(400);
  expect((await store.getLoop(loop.id))!.stateSchema).toEqual([{ key: "mrr" }]);
  expect((await store.getRun(run.id))!.control?.[0]?.command).toBe("set-schema");
  expect((await store.getRun(run.id))!.control?.[0]?.result).toBe("rejected");
});

test("report persists the slimmed transcript, retrievable by session id", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = (await gateway().report(token, {
    ok: true,
    durationMs: 1234,
    sessionId: "sess-abc",
    transcript: [
      { kind: "text", text: "Checking the feeder…" },
      { kind: "tool", name: "Bash", input: '{"command":"curl ha"}', extra: "dropped" },
      { kind: "result", text: "4g dispensed" },
      { kind: "bogus", text: "ignored" }, // invalid kind → filtered
    ],
  }));
  expect(res.status).toBe(200);

  const stored = (await store.getRun(run.id));
  expect(stored?.sessionId).toBe("sess-abc");
  expect(stored?.transcript).toEqual([
    { kind: "text", text: "Checking the feeder…" },
    { kind: "tool", name: "Bash", input: '{"command":"curl ha"}' },
    { kind: "result", text: "4g dispensed" },
  ]);
});

test("report persists the claude-reported cost (usd column + usage json), rejecting garbage fields", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = (await gateway().report(token, {
    ok: true,
    durationMs: 1000,
    cost: {
      usd: 0.4235,
      inputTokens: 120,
      outputTokens: 950,
      cacheReadTokens: 48000,
      numTurns: 12,
      cacheCreationTokens: -5, // negative → dropped
    },
  }));
  expect(res.status).toBe(200);

  const stored = (await store.getRun(run.id));
  expect(stored?.costUsd).toBe(0.4235);
  expect(stored?.usage).toEqual({ inputTokens: 120, outputTokens: 950, cacheReadTokens: 48000, numTurns: 12 });
});

test("report with an absent or wholly-garbage cost leaves the cost columns null", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  // usd over the sanity ceiling + non-numeric tokens → everything dropped.
  const res = (await gateway().report(token, { ok: true, durationMs: 5, cost: { usd: 99_999_999, inputTokens: "lots" } }));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id));
  expect(stored?.costUsd).toBeNull();
  expect(stored?.usage).toBeNull();
});

test("report syncs the machine's task file content onto the loop", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = (await gateway().report(token, {
    ok: true,
    durationMs: 1000,
    taskFileContent: "# Breakfast log\n2026-06-19: 4g dispensed\n",
  }));
  expect(res.status).toBe(200);

  const stored = (await store.getLoop(loop.id));
  expect(stored?.taskFileContent).toBe("# Breakfast log\n2026-06-19: 4g dispensed\n");
  expect(stored?.taskFileSyncedAt).toBeTruthy();
});

test("report strips NUL (U+0000) from wire text so the Postgres write can't throw", async () => {
  // Postgres text/jsonb columns REJECT U+0000 (SQLite tolerated it). A daemon-supplied
  // transcript/message/taskFileContent/cursor carrying a NUL must persist with the byte
  // removed rather than throwing mid-finalize (which the sweep later mis-reads as a timeout).
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = (await gateway().report(token, {
    ok: true,
    durationMs: 1000,
    sessionId: "sess\u0000abc",
    message: "done\u0000ok",
    taskFileContent: "# Log\u0000\n2026-06-19: ok\n",
    transcript: [{ kind: "text", text: "step\u0000one" }],
    cursor: { note: "cur\u0000sor", count: 3 },
  }));
  expect(res.status).toBe(200);

  const storedRun = (await store.getRun(run.id));
  expect(storedRun?.message).toBe("doneok");
  expect(storedRun?.sessionId).toBe("sessabc");
  expect(storedRun?.transcript).toEqual([{ kind: "text", text: "stepone" }]);

  const storedLoop = (await store.getLoop(loop.id));
  expect(storedLoop?.taskFileContent).toBe("# Log\n2026-06-19: ok\n");
  expect(storedLoop?.state).toEqual({ note: "cursor", count: 3 });
});

test("a machine's bound loops gate its deletion (loopsForMachine drains to empty)", async () => {
  const { machine, loop } = (await seededLoop());
  // While a loop is bound, the delete guard sees it and must block.
  expect((await store.loopsForMachine(machine.id)).map((l) => l.id)).toEqual([loop.id]);
  // Remove the loop first → the machine is now free to delete.
  (await store.deleteLoop(loop.id));
  expect((await store.loopsForMachine(machine.id))).toHaveLength(0);
  expect((await store.deleteMachine(machine.id))).toBe(true);
});

test("createLoop persists a valid IANA timezone and rejects a bogus one", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const ok = (await gateway().createLoop(token, {
    name: "Morning report",
    cron: "0 8 * * *",
    timezone: "Asia/Shanghai",
    taskFile: "loopany/x/README.md",
  }));
  expect(ok.status).toBe(200);
  expect((await store.getLoop((ok.body as any).id))!.timezone).toBe("Asia/Shanghai");

  const bad = (await gateway().createLoop(token, {
    name: "Bad tz",
    cron: "0 8 * * *",
    timezone: "Mars/Phobos",
    taskFile: "loopany/x/README.md",
  }));
  expect(bad.status).toBe(400);
  expect((bad.body as any).error).toMatch(/invalid timezone/);
});

test("createLoop records the coding agent: codex when declared, claude-code by default, and degrades an unknown value", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  // Explicit codex (the daemon's measured env / --agent codex) is persisted verbatim.
  const codex = (await gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "codex" }));
  expect(codex.status).toBe(200);
  expect((await store.getLoop((codex.body as any).id))!.agent).toBe("codex");

  // Absent agent (older daemon) back-fills to claude-code via the column default.
  const legacy = (await gateway().createLoop(token, { name: "Legacy loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  expect(legacy.status).toBe(200);
  expect((await store.getLoop((legacy.body as any).id))!.agent).toBe("claude-code");

  // An unrecognized / "unknown" value degrades to the default rather than rejecting.
  const weird = (await gateway().createLoop(token, { name: "Weird loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "unknown" }));
  expect(weird.status).toBe(200);
  expect((await store.getLoop((weird.body as any).id))!.agent).toBe("claude-code");
});

test("createLoop accepts an initial ui (day-one dashboard) — validated, persisted, presence-flagged in dry-run", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const ui = '<h3>React Doctor</h3><loop-chart series="score:Red Dot Score"></loop-chart><loop-kanban columns="open,merged"></loop-kanban>';

  // Real create — the ui persists on the loop row (same surface as set-ui/editLoop).
  const created = (await gateway().createLoop(token, {
    name: "React Doctor", cron: "0 5 * * *", taskFile: "loopany/react-doctor/README.md",
    stateSchema: [{ key: "score", label: "Red Dot Score" }], ui,
  }));
  expect(created.status).toBe(200);
  const loop = (await store.getLoop((created.body as any).id))!;
  expect(loop.ui).toBe(ui);
  expect(loop.stateSchema).toEqual([{ key: "score", label: "Red Dot Score" }]);
  // The real create response echoes ui presence (like dry-run), no warning when applied.
  expect((created.body as any).ui).toBe(true);
  expect((created.body as any).warning).toBeUndefined();

  // Dry-run reports ui as a presence flag (like workflow), never the markup, and persists nothing.
  const before = (await store.loopsForMachine(machineId)).length;
  const dry = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", ui, dryRun: true }));
  expect(dry.status).toBe(200);
  expect((dry.body as any).config.ui).toBe(true);
  const withoutUi = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", dryRun: true }));
  expect((withoutUi.body as any).config.ui).toBe(false);
  expect((await store.loopsForMachine(machineId)).length).toBe(before);
});

test("createLoop surfaces a DROPPED ui loudly — provided but validated to nothing, never silent", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  // A whitespace-only ui coerces to null: the loop is still created, but the response
  // echoes ui:false AND a warning so a dropped dashboard is never a silent no-op.
  const res = (await gateway().createLoop(token, { name: "NoDash", cron: "0 5 * * *", taskFile: "x", ui: "   " }));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.ui).toBe(false);
  expect(b.warning).toMatch(/not applied|without a dashboard/i);
  expect((await store.getLoop(b.id))!.ui).toBeNull();

  // Same surfacing on the dry-run path (warning at top level).
  const dry = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", ui: "   ", dryRun: true }));
  expect((dry.body as any).config.ui).toBe(false);
  expect((dry.body as any).warning).toMatch(/not applied|without a dashboard/i);

  // No warning when no ui was provided at all (a blank loop is not a dropped dashboard).
  const plain = (await gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x" }));
  expect((plain.body as any).warning).toBeUndefined();
  expect((plain.body as any).ui).toBe(false);
});

test("editLoop changes a loop's envelope from its machine's device token", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "Daily", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always", enabled: false }));
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["cron", "notify", "enabled"]));
  const loop = (await store.getLoop(id))!;
  expect(loop.cron).toBe("0 9 * * *");
  expect(loop.notify).toBe("always");
  expect(loop.enabled).toBe(false);

  // A bogus cron is rejected and leaves the loop untouched.
  const bad = (await gateway().editLoop(token, id, { cron: "not a cron" }));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(id))!.cron).toBe("0 9 * * *");
});

test("editLoop repoints the task file and pushes workflow/ui/schema without a run", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "Migrate", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, {
    taskFile: "/home/u/newproj/README.md",
    workflow: "return { state: prev };",
    ui: "<div id='dash'>hi</div>",
    stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }],
  }));
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["taskFile", "workflow", "ui", "stateSchema"]));
  const loop = (await store.getLoop(id))!;
  expect(loop.taskFile).toBe("/home/u/newproj/README.md");
  expect(loop.workflow).toContain("return { state: prev }");
  expect(loop.ui).toContain("dash");
  expect(loop.stateSchema).toEqual([{ key: "mrr", label: "MRR", unit: "$" }]);
});

test("editLoop accepts stateSchema as a JSON string too (run-token parity)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, { stateSchema: '[{"key":"visits","label":"Visits"}]' } as any));
  expect(res.status).toBe(200);
  expect((await store.getLoop(id))!.stateSchema).toEqual([{ key: "visits", label: "Visits" }]);
});

test("editLoop validates content fields (bad schema → 400, loop untouched)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const bad = (await gateway().editLoop(token, id, { stateSchema: [{ notKey: 1 }] } as any));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(id))!.stateSchema).toBeNull();
});

test("editLoop clips an oversized workflow to the wire cap (same discipline as createLoop)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "Big", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const res = (await gateway().editLoop(token, id, { workflow: "x".repeat(600 * 1024), ui: "<div>ok</div>" }));
  expect(res.status).toBe(200);
  const loop = (await store.getLoop(id))!;
  expect(loop.workflow!.length).toBe(512 * 1024); // WIRE_TEXT_CAP
  expect(loop.ui).toBe("<div>ok</div>");
});

test("editLoop rejects an unknown patch key with a clear 400 (never silent no-op)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  // A typo (or an attempt to patch an identity column) fails loudly.
  const res = (await gateway().editLoop(token, id, { teamId: "other", croon: "0 9 * * *" } as any));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/unknown field/);
  expect((res.body as any).error).toMatch(/teamId/);
  // Nothing changed.
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
});

test("editLoop refuses a loop bound to a different machine (404, no change)", async () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  (await store.createMachine({ id: machineA, userId: "u1", name: "A", tokenHash: tokens.sha256(tokenA), online: true }));
  const created = (await gateway().createLoop(tokenA, { name: "Owned", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true }));

  const res = (await gateway().editLoop(tokenB, id, { cron: "*/5 * * * *" }));
  expect(res.status).toBe(404);
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *"); // untouched
});

test("poll stores live progress on this machine's running run; report clears it", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));

  (await gateway().poll(token, undefined, [{ runId: run.id, step: 3, label: "Editing report.md" }]));
  // The signal carries a freshness stamp (`at`) alongside step/label — the sweep's
  // inactivity clock.
  expect((await store.getRun(run.id))!.progress).toMatchObject({ step: 3, label: "Editing report.md" });
  expect(((await store.getRun(run.id))!.progress as { at?: string }).at).toBeTruthy();

  // A different machine can't write progress onto a run it doesn't own.
  const other = tokens.mintDeviceToken();
  (await gateway().poll(other, undefined, [{ runId: run.id, step: 9, label: "hijack" }]));
  expect((await store.getRun(run.id))!.progress).toMatchObject({ step: 3, label: "Editing report.md" });

  // Finalizing the run clears the live signal (the full transcript supersedes it).
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  (await gateway().report(rt, { ok: true, durationMs: 10 }));
  expect((await store.getRun(run.id))!.progress).toBeNull();
});

test("concurrent polls deliver a pending run exactly once (atomic pending->running claim)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() }));

  // Two polls in flight at once (an HTTP retry racing its timed-out original, or
  // two daemons sharing one device token = the same machineId). The conditional
  // pending->running claim must let exactly ONE of them deliver the run - the old
  // unconditional read-then-write let both, double-executing it on the machine.
  const gw = gateway();
  const results = await Promise.all([gw.poll(token), gw.poll(token)]);
  const delivered = results.flatMap((r) => (r.body as { deliveries: Array<{ runId: string }> }).deliveries);
  expect(delivered.filter((d) => d.runId === run.id)).toHaveLength(1);
  expect((await store.getRun(run.id))!.phase).toBe("running");

  // A later poll sees the run as already claimed - no re-delivery, no error.
  const again = ((await gw.poll(token)).body as { deliveries: unknown[] }).deliveries;
  expect(again).toHaveLength(0);
});

test("set-tz applies the timezone through an allowControl run token", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "edit", allowControl: true });
  const res = (await gateway().agentApi(token, ["set-tz", "Asia/Tokyo"]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.timezone).toBe("Asia/Tokyo");

  const bad = (await gateway().agentApi(token, ["set-tz", "Mars/Phobos"]));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(loop.id))!.timezone).toBe("Asia/Tokyo"); // unchanged
});

test("an edit run's report routes to finishEdit (the pending edit marker is cleared)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", editRequest: "run at 9am" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "edit", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "edit", allowControl: true });

  let finished = "";
  const gw = new gatewayMod.MachineGateway({
    maybeFlagEvolve(): void {},
    finishEvolution(): void {},
    async finishEdit(id: string): Promise<void> {
      finished = id;
      (await store.updateLoop(id, { editRequest: null }));
    },
    addLoop(): void {},
    removeLoop(): void {},
    runNow(): void {},
  } as any);

  const res = (await gw.report(rt, { ok: true, durationMs: 5 }));
  expect(res.status).toBe(200);
  expect(finished).toBe(loop.id);
  expect((await store.getLoop(loop.id))!.editRequest).toBeNull();
});

// ---- per-team connect-key: createLoop resolves the team from the claim intent ----

test("createLoop lands the loop in the connect-key's team, not the machine's home team (existing-machine reuse)", async () => {
  (await makeTeam("team-reuse", ["u1"]));
  // The machine's durable identity (home team = its personal team).
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  // Team B's fresh connect-key (a different token than the device identity), minted
  // under team B — this is the realistic "one machine, second team" capture path.
  const connectKey = tokens.mintDeviceToken();
  tokens.rememberClaimIntent(connectKey, { userId: "u1", teamId: "team-reuse" });

  const res = (await gateway().createLoop(deviceToken, { name: "B loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: connectKey }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-reuse");
});

test("createLoop rejects (403) a claim minted by a different user — fail closed, nothing created", async () => {
  (await makeTeam("team-x", ["u2"]));
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  tokens.rememberClaimIntent(token, { userId: "u2", teamId: "team-x" }); // minted by someone else

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token }));
  expect(res.status).toBe(403);
  expect((await store.listLoops()).length).toBe(0); // never mis-filed
});

test("createLoop rejects (403) when the minter is no longer a member of the claim team", async () => {
  (await makeTeam("team-y", [])); // team exists, u1 is NOT a member (and not an admin)
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  tokens.rememberClaimIntent(token, { userId: "u1", teamId: "team-y" });

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token }));
  expect(res.status).toBe(403);
  expect((await store.listLoops()).length).toBe(0);
});

test("createLoop authorizes a superadmin for any existing team even without a membership row", async () => {
  (await makeTeam("team-admin", [])); // exists; admin is not a member
  await (db.client as any).exec(`INSERT INTO "user" (id, name, email) VALUES ('admin1', 'Admin', 'admin@example.com') ON CONFLICT DO NOTHING`);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "admin1", teamId: "team-admin1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  tokens.rememberClaimIntent(token, { userId: "admin1", teamId: "team-admin" });

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-admin");
});

test("createLoop with no claim falls back to the machine's home team (back-compat)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", teamId: "team-home", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-home");
});

test("createLoop with a claim for the machine's OWN home team needs no membership re-check (open-mode path)", async () => {
  // Mirrors open mode: intent team === home team, so the cross-team gate is skipped
  // and no team_members row is required (there is none for the shared user).
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "shared", teamId: "team-shared", name: "M", tokenHash: tokens.sha256(token), online: true }));
  tokens.rememberClaimIntent(token, { userId: "shared", teamId: "team-shared" });

  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.teamId).toBe("team-shared");
});

test("claimStatus surfaces the MEASURED agent so the New-loop confirmation shows what actually ran", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const claim = "ck_confirm_agent";

  // The daemon measured Codex on the host and sent it on the create; the claim
  // result must carry that recorded value (not a removed dialog pre-selection).
  const res = (await gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "codex", claim }));
  expect(res.status).toBe(200);
  expect(gateway().claimStatus(claim)?.agent).toBe("codex");
});

test("listMachinesForTeam is membership-scoped — a machine shows in its owner's team regardless of its home team", async () => {
  (await makeTeam("team-lm", ["u1"])); // only u1 is a member
  const t1 = tokens.mintDeviceToken();
  const m1 = tokens.machineIdFromToken(t1);
  (await store.createMachine({ id: m1, userId: "u1", teamId: "team-u1", name: "Mine", tokenHash: tokens.sha256(t1), online: true }));
  const t2 = tokens.mintDeviceToken();
  (await store.createMachine({ id: tokens.machineIdFromToken(t2), userId: "u2", teamId: "team-u2", name: "Other", tokenHash: tokens.sha256(t2), online: true }));

  // u1's machine (home team-u1) appears under team-lm via membership; u2's doesn't.
  expect((await store.listMachinesForTeam("team-lm")).map((m) => m.id)).toEqual([m1]);
});

test("set-workflow updates only through an evolution token", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetWorkflow: true,
  });
  const res = (await gateway().agentApi(token, ["set-workflow", "--file-content", "return { state: prev }"]));

  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.workflow).toBe("return { state: prev }");
  expect((await store.getRun(run.id))!.control?.[0]?.command).toBe("set-workflow");
});

// ---- workflow syntax validation (write-time, zero-exec) across all three paths ----
// The daemon runner wraps the body in an async arrow inside a generated ES module,
// so top-level export/import (the Claude Code Workflow tool's `export const meta`
// header) is a parse error that kills every run. The server rejects it at write time.

const EXPORT_META = 'export const meta = { name: "x" };\nreturn { state: prev };';
const STATIC_IMPORT = 'import fs from "node:fs";\nreturn { state: prev };';
const GOOD_WORKFLOW = 'const res = await tools.call("posthog.exec", { q: 1 });\nreturn { message: `${res.data?.length ?? 0} rows`, state: prev };';

test("set-workflow rejects an `export const meta` body with a fix-teaching message; loop untouched", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = (await gateway().agentApi(token, ["set-workflow", "--file-content", EXPORT_META]));
  expect(res.status).toBe(400);
  const text = (res.body as { text: string }).text;
  expect(text).toMatch(/syntax error/i);
  expect(text).toMatch(/export const meta/);
  expect(text).toMatch(/NOT an ES module/);
  expect(text).toMatch(/Claude Code Workflow tool/);
  // Nothing stored — the loop had no workflow and still has none.
  expect((await store.getLoop(loop.id))!.workflow ?? null).toBeNull();
});

test("set-workflow rejects a static import body", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = (await gateway().agentApi(token, ["set-workflow", "--file-content", STATIC_IMPORT]));
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/import/i);
});

test("set-workflow accepts a real `await tools.call(...)` body unchanged", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = (await gateway().agentApi(token, ["set-workflow", "--file-content", GOOD_WORKFLOW]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.workflow).toBe(GOOD_WORKFLOW);
});

test("set-workflow accepts a body containing the literal word `export` inside a string (no false positive)", async () => {
  const { loop, machine, run } = (await seededLoop());
  const token = tokens.registerRunLease({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const body = 'return { message: "export const meta = not real" };';
  const res = (await gateway().agentApi(token, ["set-workflow", "--file-content", body]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.workflow).toBe(body);
});

test("editLoop rejects an `export const meta` workflow with a rejection entry; loop untouched", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  // Non-dry-run editLoop surfaces the first rejection as body.error (400).
  const res = (await gateway().editLoop(token, id, { workflow: EXPORT_META }));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/export const meta/);
  expect((await store.getLoop(id))!.workflow ?? null).toBeNull();

  // The dry-run path reports it as a per-key rejection entry instead.
  const dry = (await gateway().editLoop(token, id, { workflow: EXPORT_META }, true));
  expect(dry.status).toBe(200);
  const reject = ((dry.body as any).rejections as Array<{ key: string; reason: string }>).find((r) => r.key === "workflow");
  expect(reject).toBeTruthy();
  expect(reject!.reason).toMatch(/NOT an ES module/);
  expect((dry.body as any).ok).toBe(false);
});

test("createLoop rejects an `export const meta` workflow before persisting (400, nothing created)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const before = (await store.loopsForMachine(machineId)).length;
  const res = (await gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: EXPORT_META }));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/export const meta/);
  expect((await store.loopsForMachine(machineId)).length).toBe(before);
});

test("createLoop --dry-run surfaces the workflow syntax error before persistence", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const res = (await gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: EXPORT_META, dryRun: true }));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/NOT an ES module/);
  expect((await store.loopsForMachine(machineId)).length).toBe(0);
});

test("createLoop accepts a legal `tools.call` workflow (no taskFile needed)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const res = (await gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: GOOD_WORKFLOW }));
  expect(res.status).toBe(200);
  const loop = (await store.getLoop((res.body as any).id))!;
  expect(loop.workflow).toBe(GOOD_WORKFLOW);
});

// ---- closed-loop goal: finish verb, gating, completion side effects, reopen ----

/** A machine + a CLOSED loop (goal set unless goal:null) with an exec run RUNNING,
 *  its run token minted with the poll-derived canFinish. Ready for `finish`. */
async function seededClosedRun(opts: { notify?: "always" | "auto" | "never"; goal?: string | null } = {}) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const goal = opts.goal === undefined ? "reach the goal" : opts.goal;
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: opts.notify ?? "auto", goal }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: loop.goal != null });
  return { token, machineId, loop, run, rt };
}

test("finish completes a closed loop: run resolved, loop stamped terminal + disabled, notified", async () => {
  const { loop, run, rt } = (await seededClosedRun());
  const { sent, fn } = recordingNotify();

  const res = (await gateway(fn).agentApi(rt, ["finish", "--message", "hit 100 signups", "--reason", "target met"]));
  expect(res.status).toBe(200);

  const r = (await store.getRun(run.id))!;
  expect(r.phase).toBe("done");
  expect(r.outcome).toBe("exec");
  expect(r.status).toBe("resolved");
  expect(r.message).toBe("hit 100 signups");

  const l = (await store.getLoop(loop.id))!;
  expect(l.completedAt).toBeTruthy();
  expect(l.completionReason).toBe("target met");
  expect(l.enabled).toBe(false);
  expect(l.goal).toBe("reach the goal"); // invariant: completedAt != null implies goal != null

  // Completion notification fired (a distinct terminal event).
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toContain("Goal reached");

  // finish records a server-computed durationMs even before the daemon's report.
  expect(typeof r.durationMs).toBe("number");

  // The run token stays live for exactly ONE enriching post-run report (which then
  // revokes it) — so the daemon's report can add the precise durationMs/sessionId.
  expect((await gateway().agentApi(rt, ["show"])).status).toBe(200);
});

test("finish leaves the token live for the daemon's enriching report (durationMs + sessionId), which then revokes it", async () => {
  const { loop, run, rt } = (await seededClosedRun());
  const gw = gateway();
  expect((await gw.agentApi(rt, ["finish", "--message", "done"])).status).toBe(200);

  // The daemon's normal post-run report arrives with the precise durationMs + sessionId.
  const rep = (await gw.report(rt, { ok: true, durationMs: 4321, sessionId: "sess-xyz" }));
  expect(rep.status).toBe(200);

  const r = (await store.getRun(run.id))!;
  expect(r.durationMs).toBe(4321);
  expect(r.sessionId).toBe("sess-xyz");
  // The loop stays completed (the enriching report never re-stamps).
  expect((await store.getLoop(loop.id))!.completedAt).toBeTruthy();
  // Enrichment revoked the token — a second report is now a no-op (401).
  expect((await gw.report(rt, { ok: true, durationMs: 9 })).status).toBe(401);
});

test("finish TOCTOU: refuses (loop untouched) when the goal was cleared after the run started", async () => {
  const { token, loop, run, rt } = (await seededClosedRun());
  // Owner clears the goal mid-run (editLoop {goal:null}) — the run's canFinish was
  // minted at poll, so it's stale.
  expect((await gateway().editLoop(token, loop.id, { goal: null } as any)).status).toBe(200);

  const res = (await gateway().agentApi(rt, ["finish", "--message", "x"]));
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/no longer has a goal/i);
  const l = (await store.getLoop(loop.id))!;
  expect(l.completedAt).toBeNull();
  expect(l.enabled).toBe(true);
  expect((await store.getRun(run.id))!.phase).toBe("running"); // untouched
});

test("finish is single-shot: a second finish on the same still-live run refuses, no re-stamp/re-notify", async () => {
  const { loop, run, rt } = (await seededClosedRun());
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  expect((await gw.agentApi(rt, ["finish", "--message", "first", "--reason", "target met"])).status).toBe(200);
  const first = (await store.getLoop(loop.id))!;
  expect(first.completedAt).toBeTruthy();
  expect(sent).toHaveLength(1);

  // The token is still live (for the enriching report), so a second finish is attempted.
  const res = (await gw.agentApi(rt, ["finish", "--message", "second", "--reason", "again"]));
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/already finished/i);

  // Loop stamps unchanged (no re-stamp), run message unchanged, no second notification.
  const l = (await store.getLoop(loop.id))!;
  expect(l.completedAt).toBe(first.completedAt);
  expect(l.completionReason).toBe("target met");
  expect((await store.getRun(run.id))!.message).toBe("first");
  expect(sent).toHaveLength(1);
});

test("finish alias `complete` works the same", async () => {
  const { loop, rt } = (await seededClosedRun());
  const res = (await gateway().agentApi(rt, ["complete", "--reason", "done"]));
  expect(res.status).toBe(200);
  expect((await store.getLoop(loop.id))!.completedAt).toBeTruthy();
});

test("finish validates --state against the loop schema like report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "g", stateSchema: [{ key: "mrr" }] }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: true });

  // An unknown key is rejected (400) and nothing completes.
  const bad = (await gateway().agentApi(rt, ["finish", "--state", '{"nope":1}']));
  expect(bad.status).toBe(400);
  expect((await store.getLoop(loop.id))!.completedAt).toBeNull();

  // A schema-valid metric is recorded on the run and the loop completes.
  const ok = (await gateway().agentApi(rt, ["finish", "--state", '{"mrr":9000}']));
  expect(ok.status).toBe(200);
  expect((await store.getRun(run.id))!.state).toEqual({ mrr: 9000 });
  expect((await store.getLoop(loop.id))!.completedAt).toBeTruthy();
});

test("finish on an OPEN loop (no goal) is refused 403 — nothing completes", async () => {
  const { loop, run, rt } = (await seededClosedRun({ goal: null }));
  const res = (await gateway().agentApi(rt, ["finish", "--message", "x"]));
  expect(res.status).toBe(403);
  expect((res.body as { text: string }).text).toMatch(/no goal to finish/i);
  const l = (await store.getLoop(loop.id))!;
  expect(l.completedAt).toBeNull();
  expect(l.enabled).toBe(true);
  expect((await store.getRun(run.id))!.phase).toBe("running"); // untouched
});

test("evolve and edit runs never get canFinish — finish refused even on a closed loop", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "reach goal" }));
  for (const role of ["evolve", "edit"] as const) {
    const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() }));
    // Mirrors poll: structural runs get canFinish false.
    const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true, canFinish: false });
    const res = (await gateway().agentApi(rt, ["finish", "--message", "x"]));
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/only an exec run/i);
  }
  expect((await store.getLoop(loop.id))!.completedAt).toBeNull();
});

test("finish honors notify:never (no completion push)", async () => {
  const { rt } = (await seededClosedRun({ notify: "never" }));
  const { sent, fn } = recordingNotify();
  const res = (await gateway(fn).agentApi(rt, ["finish", "--reason", "done"]));
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(0);
});

test("poll mints canFinish only for an exec run on a closed loop (via show self-finish line)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const closed = (await store.createLoop({ userId: "u1", machineId, name: "C", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "g" }));
  (await store.addRun({ loopId: closed.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() }));
  const open = (await store.createLoop({ userId: "u1", machineId, name: "O", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  (await store.addRun({ loopId: open.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() }));

  const gw = gateway();
  const deliveries = ((await gw.poll(token)).body as { deliveries: Array<{ loop: { id: string }; runToken: string }> }).deliveries;
  const tokenFor = (loopId: string) => deliveries.find((d) => d.loop.id === loopId)!.runToken;

  const closedShow = ((await gw.agentApi(tokenFor(closed.id), ["show"])).body as { text: string }).text;
  expect(closedShow).toContain("goal: g");
  expect(closedShow).toContain("selfFinish: allowed");

  const openShow = ((await gw.agentApi(tokenFor(open.id), ["show"])).body as { text: string }).text;
  expect(openShow).toContain("goal: —");
  expect(openShow).toContain("selfFinish: off");
});

test("createLoop accepts a goal (closed loop); absent goal ⇒ open loop", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const closed = (await gateway().createLoop(token, { name: "C", cron: "0 8 * * *", taskFile: "loopany/x/README.md", goal: "reach 100 users" }));
  expect((await store.getLoop((closed.body as any).id))!.goal).toBe("reach 100 users");

  const open = (await gateway().createLoop(token, { name: "O", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  expect((await store.getLoop((open.body as any).id))!.goal).toBeNull();
});

test("editLoop sets a goal, and clearing it (goal:null) also clears the completion stamps", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "G", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const id = (created.body as any).id as string;

  expect((await gateway().editLoop(token, id, { goal: "ship v1" })).status).toBe(200);
  expect((await store.getLoop(id))!.goal).toBe("ship v1");

  // Simulate a completed loop, then clear the goal → stamps drop (invariant held).
  (await store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "shipped", enabled: false }));
  expect((await gateway().editLoop(token, id, { goal: null } as any)).status).toBe(200);
  const l = (await store.getLoop(id))!;
  expect(l.goal).toBeNull();
  expect(l.completedAt).toBeNull();
  expect(l.completionReason).toBeNull();
});

test("reopen: editLoop enabled:true on a completed loop clears the stamps; a plain pause leaves them", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const created = (await gateway().createLoop(token, { name: "R", cron: "0 8 * * *", taskFile: "loopany/x/README.md", goal: "g" }));
  const id = (created.body as any).id as string;
  (await store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "met", enabled: false }));

  // Reopen: enabled:true drops the terminal stamps (goal survives).
  expect((await gateway().editLoop(token, id, { enabled: true })).status).toBe(200);
  const reopened = (await store.getLoop(id))!;
  expect(reopened.enabled).toBe(true);
  expect(reopened.completedAt).toBeNull();
  expect(reopened.completionReason).toBeNull();
  expect(reopened.goal).toBe("g");

  // A plain pause (enabled:false) on a completed loop leaves stamps untouched.
  (await store.updateLoop(id, { completedAt: "2026-07-02T00:00:00Z", completionReason: "met2", enabled: false }));
  expect((await gateway().editLoop(token, id, { enabled: false })).status).toBe(200);
  expect((await store.getLoop(id))!.completedAt).toBe("2026-07-02T00:00:00Z");
});

// ---- --dry-run: validate-only preview for new + edit (no persistence) ----

/** A connected machine + its device token, for the dry-run tests. */
async function seededMachine() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  return { token, machineId };
}

test("createLoop --dry-run returns the normalized config + 3 fire times + closed classification, persists nothing", async () => {
  const { token, machineId } = (await seededMachine());
  const before = (await store.loopsForMachine(machineId)).length;
  const res = (await gateway().createLoop(token, {
    name: "DryClosed", cron: "0 8 * * *", timezone: "America/New_York",
    taskFile: "loopany/x/README.md", goal: "ship v1", dryRun: true,
  }));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(true);
  expect(b.classification).toBe("closed");
  expect(b.classificationText).toMatch(/self-finish/i);
  expect(b.nextRuns).toHaveLength(3);
  expect(b.timezone).toBe("America/New_York");
  expect(b.config.taskFile).toBe("loopany/x/README.md");
  expect(b.config.goal).toBe("ship v1");
  expect(b.config.workflow).toBe(false); // presence flag, not the source
  // Nothing was persisted (no loop row created).
  expect((await store.loopsForMachine(machineId)).length).toBe(before);
});

test("createLoop --dry-run classifies a goal-less loop as open", async () => {
  const { token } = (await seededMachine());
  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "x", dryRun: true }));
  expect((res.body as any).classification).toBe("open");
  expect((res.body as any).classificationText).toMatch(/runs until paused/i);
});

test("createLoop --dry-run still validates (bad cron → 400, nothing created)", async () => {
  const { token, machineId } = (await seededMachine());
  const res = (await gateway().createLoop(token, { cron: "not a cron", taskFile: "x", dryRun: true }));
  expect(res.status).toBe(400);
  expect((await store.loopsForMachine(machineId))).toHaveLength(0);
});

test("createLoop --dry-run rejects a config with neither workflow nor taskFile", async () => {
  const { token } = (await seededMachine());
  const res = (await gateway().createLoop(token, { cron: "0 8 * * *", dryRun: true }));
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/workflow.*taskFile/i);
});

test("editLoop --dry-run previews per-key before→after and persists nothing", async () => {
  const { token } = (await seededMachine());
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" }));
  const id = (created.body as any).id as string;
  const res = (await gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always" }, true));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(true);
  const changes = b.changes as Array<{ key: string; from: unknown; to: unknown }>;
  expect(changes.find((c) => c.key === "cron")).toEqual({ key: "cron", from: "0 8 * * *", to: "0 9 * * *" });
  expect(changes.find((c) => c.key === "notify")?.to).toBe("always");
  // Not persisted.
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
  expect((await store.getLoop(id))!.notify).toBe("auto");
});

test("editLoop --dry-run reports whitelist + invalid-value rejections (ok:false), changes nothing", async () => {
  const { token } = (await seededMachine());
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" }));
  const id = (created.body as any).id as string;
  const res = (await gateway().editLoop(token, id, { croon: "x", cron: "not a cron" } as any, true));
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(false);
  const keys = (b.rejections as Array<{ key: string }>).map((r) => r.key);
  expect(keys).toContain("croon"); // whitelist rejection
  expect(keys).toContain("cron"); // invalid-value rejection
  expect((await store.getLoop(id))!.cron).toBe("0 8 * * *");
});

test("editLoop --dry-run reflects the reopen stamp-clear in the preview", async () => {
  const { token } = (await seededMachine());
  const created = (await gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x", goal: "g" }));
  const id = (created.body as any).id as string;
  (await store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "met", enabled: false }));
  const res = (await gateway().editLoop(token, id, { enabled: true }, true));
  const keys = ((res.body as any).changes as Array<{ key: string }>).map((c) => c.key);
  expect(keys).toContain("enabled");
  expect(keys).toContain("completedAt");
  expect(keys).toContain("completionReason");
  // Dry-run persisted nothing → the loop is still completed.
  expect((await store.getLoop(id))!.completedAt).toBe("2026-07-01T00:00:00Z");
});

// ---- self-schedule cadence floors (RUN path only; the owner's edit path is unlimited) ----

test("set-cron floor: a run can't schedule more often than 15 min; the owner's edit can", async () => {
  const { loop, machine, run } = (await seededLoop());
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // Every 5 minutes is under the 15-min self floor → rejected, cron unchanged.
  const denied = (await gateway().agentApi(rt, ["set-cron", "*/5 * * * *"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/15 min/);
  expect((await store.getLoop(loop.id))!.cron).toBe("0 0 1 1 *");

  // Every 20 minutes clears the floor.
  expect((await gateway().agentApi(rt, ["set-cron", "*/20 * * * *"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.cron).toBe("*/20 * * * *");

  // The OWNER's editLoop path is unlimited — the same dense cron is accepted.
  const deviceToken = tokens.mintDeviceToken();
  const dm = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: dm, userId: "u2", name: "D", tokenHash: tokens.sha256(deviceToken), online: true }));
  const owned = (await gateway().createLoop(deviceToken, { name: "Owned", cron: "0 8 * * *", taskFile: "loopany/x/README.md" }));
  const oid = (owned.body as any).id as string;
  expect((await gateway().editLoop(deviceToken, oid, { cron: "*/5 * * * *" })).status).toBe(200);
  expect((await store.getLoop(oid))!.cron).toBe("*/5 * * * *");
});

test("set-cron floor is timezone-aware (probes adjacent fires in the loop's tz)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", timezone: "Asia/Tokyo", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  // A daily cron (adjacent fires 24h apart, well over the floor) is accepted.
  expect((await gateway().agentApi(rt, ["set-cron", "0 9 * * *"])).status).toBe(200);
  // A 2-minute cron is under the floor → rejected.
  expect((await gateway().agentApi(rt, ["set-cron", "*/2 * * * *"])).status).toBe(400);
});

test("reschedule floor: a run can't reschedule sooner than 5 min out", async () => {
  const { loop, machine, run } = (await seededLoop());
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // 2 minutes out is under the 5-min floor → rejected, nextRunAt unchanged.
  const denied = (await gateway().agentApi(rt, ["reschedule", "--next", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();

  // 30 minutes out clears the floor.
  expect((await gateway().agentApi(rt, ["reschedule", "--next", "30m"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeTruthy();
});

test("show reports the goal line and self-finish gating for a run", async () => {
  const { loop, rt } = (await seededClosedRun());
  const text = ((await gateway().agentApi(rt, ["show"])).body as { text: string }).text;
  expect(text).toContain('goal: "reach the goal"');
  expect(text).toContain("selfFinish: allowed");
  expect(loop.goal).toBe("reach the goal");
});

// ---- failure visibility / alerting (notify on run failure + machine-offline) ----

/** Add a finalized exec run with an explicit ts (deterministic streak ordering). */
async function addExecRun(loopId: string, machineId: string, phase: "done" | "error", ts: string) {
  return (await store.addRun({ loopId, userId: "u1", machineId, phase, role: "exec", ts }));
}

test("a FAILED exec run notifies the user (first failure of a streak)", async () => {
  const { loop, rt } = (await seededExecRun());
  const { sent, fn } = recordingNotify();

  const res = (await gateway(fn).report(rt, { ok: false, error: "claude exited 1", durationMs: 5 }));
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toContain("Run failed");
  expect(sent[0]!.message).toContain("claude exited 1");
});

test("a SUCCESSFUL exec run still notifies as before (unchanged success path)", async () => {
  const { loop, rt } = (await seededExecRun());
  const { sent, fn } = recordingNotify();

  const res = (await gateway(fn).report(rt, { ok: true, message: "Breakfast report ready", durationMs: 5 }));
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toBe("Breakfast report ready");
});

test("repeated consecutive failures are anti-spam'd: notify on the 1st and every Nth, not every tick", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // 12 consecutive failing runs. With FAILURE_NOTIFY_EVERY === 5, the user is
  // alerted on streaks 1, 5, 10 → exactly 3 pushes (not 12).
  for (let i = 1; i <= 12; i++) {
    const run = (await addExecRun(loop.id, machineId, "error", `2026-06-01T00:00:${String(i).padStart(2, "0")}Z`)).id;
    // The run row is already error; drive report on a token for it to exercise the path.
    const rt = tokens.registerRunLease({ runId: run, loopId: loop.id, machineId, role: "exec", allowControl: false });
    (await gw.report(rt, { ok: false, error: "boom", durationMs: 1 }));
  }
  expect(sent).toHaveLength(3);
});

test("a success between failures resets the streak so the next failure re-alerts (transition)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();

  // Prior history: a failure, then a success (the streak is broken at the success).
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:01Z"));
  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:02Z"));

  // Now a fresh failure → streak is 1 again → it must re-alert.
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: "2026-06-01T00:00:03Z" }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  (await gateway(fn).report(rt, { ok: false, error: "boom", durationMs: 1 }));

  expect(sent).toHaveLength(1);
});

test("evolve and edit run failures never produce user-facing failure notifications", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "always" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  for (const role of ["evolve", "edit"] as const) {
    const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() }));
    const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true });
    (await gw.report(rt, { ok: false, error: "boom", durationMs: 1 }));
  }
  expect(sent).toHaveLength(0);
});

test("notify: 'never' suppresses failure alerts entirely", async () => {
  const { rt } = (await seededExecRun("never"));
  const { sent, fn } = recordingNotify();
  (await gateway(fn).report(rt, { ok: false, error: "boom", durationMs: 1 }));
  expect(sent).toHaveLength(0);
});

test("sweep surfaces a machine-offline pending run once (anti-spam'd while it stays offline)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // Machine offline + last seen long ago.
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false, lastSeen: "2000-01-01T00:00:00Z" }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // Two stale pending exec runs (older than the 60s grace) — both reclaim as
  // "machine offline". The first is streak 1 (alert); the second is streak 2 (silent).
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: "2026-06-01T00:00:01Z" }));
  (await gw.sweep());
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: "2026-06-01T00:00:02Z" }));
  (await gw.sweep());

  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toMatch(/offline/i);
});

test("execFailureStreak counts only consecutive trailing exec errors, ignoring evolve/canceled/open", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));

  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:01Z"));
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:02Z"));
  (await addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:03Z"));
  // An interleaved evolve error must NOT count (internal role).
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "error", role: "evolve", ts: "2026-06-01T00:00:04Z" }));
  expect((await store.execFailureStreak(loop.id))).toBe(2);

  // A trailing success breaks the streak to 0.
  (await addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:05Z"));
  expect((await store.execFailureStreak(loop.id))).toBe(0);
});

// ---- loopLog (device-token-scoped run-log read for `loopany log`) ----

/** A machine + a loop on it, with `count` exec runs (newest ts last). */
async function seededLoopWithRuns(machineId: string, count: number) {
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h-" + machineId, online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  for (let i = 0; i < count; i++) {
    (await store.addRun({
      loopId: loop.id,
      userId: "u1",
      machineId,
      phase: i % 2 === 0 ? "done" : "error",
      role: "exec",
      ts: `2026-06-01T00:00:${String(i + 1).padStart(2, "0")}Z`,
      outcome: i % 2 === 0 ? "exec" : "error",
      sessionId: `sess-${i}`,
      ...(i % 2 === 0 ? { state: { mrr: 42 + i } } : { error: `boom ${i}` }),
      transcript: [
        { kind: "text", text: `run ${i} thinking` },
        { kind: "tool", name: "Bash", input: `{"cmd":"echo ${i}"}` },
      ],
    }));
  }
  return loop;
}

test("loopLog returns the loop's recent runs newest-first with transcript text", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  const loop = (await seededLoopWithRuns(machineId, 3));

  const res = (await gateway().loopLog(token, loop.id));
  expect(res.status).toBe(200);
  const body = res.body as { ok: boolean; loopId: string; runs: any[] };
  expect(body.ok).toBe(true);
  expect(body.loopId).toBe(loop.id);
  expect(body.runs).toHaveLength(3);
  // Newest-first.
  expect(body.runs[0].ts > body.runs[1].ts).toBe(true);
  // Transcript flattened to text (tool steps render as `$ <name> <input>`).
  expect(body.runs[0].transcript).toContain("$ Bash");
  expect(body.runs[0].transcript).toContain("thinking");
  // Each run carries its claude-code session id so the reader can jump to the
  // on-disk `<session>.jsonl` for a deep dive (newest-first → run index 2's id).
  expect(body.runs[0].sessionId).toBe("sess-2");
  expect(body.runs.every((r) => "sessionId" in r)).toBe(true);
  // Each run also carries the metrics it reported (the state object).
  expect(body.runs[0].state).toEqual({ mrr: 44 });
  expect(body.runs.every((r) => "state" in r)).toBe(true);
});

test("loopLog honors and caps the run limit", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  const loop = (await seededLoopWithRuns(machineId, 5));

  expect(((await gateway().loopLog(token, loop.id, 2)).body as { runs: any[] }).runs).toHaveLength(2);
  // Limit is clamped to the max (20), so a huge value just returns everything.
  expect(((await gateway().loopLog(token, loop.id, 9999)).body as { runs: any[] }).runs).toHaveLength(5);
  // A non-positive / garbage limit falls back to the default (≥ all 5 here).
  expect(((await gateway().loopLog(token, loop.id, -1)).body as { runs: any[] }).runs).toHaveLength(5);
});

test("loopLog truncates an over-cap transcript and flags it", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h", online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  (await store.addRun({
    loopId: loop.id,
    userId: "u1",
    machineId,
    phase: "done",
    role: "exec",
    ts: "2026-06-01T00:00:01Z",
    transcript: [{ kind: "text", text: "x".repeat(20_000) }],
  }));
  const run = ((await gateway().loopLog(token, loop.id)).body as { runs: any[] }).runs[0];
  expect(run.transcriptTruncated).toBe(true);
  expect(run.transcript.length).toBeLessThan(20_000);
});

test("loopLog refuses a token whose machine does not own the loop (cross-device)", async () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  const loop = (await seededLoopWithRuns(machineA, 2));

  // A different device with its own token cannot read machine A's loop's runs.
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u2", name: "MB", tokenHash: "hb", online: true }));
  const res = (await gateway().loopLog(tokenB, loop.id));
  expect(res.status).toBe(404);
});

test("loopLog rejects an unknown loop id and an unregistered token", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h", online: true }));
  // Loop that doesn't exist → 404 (existence never leaks).
  expect((await gateway().loopLog(token, "loop-nope")).status).toBe(404);
  // Missing loop id → 400.
  expect((await gateway().loopLog(token, "")).status).toBe(400);
  // Token for a machine that was never registered → 401.
  expect((await gateway().loopLog(tokens.mintDeviceToken(), "loop-x")).status).toBe(401);
});

// ---- run-lifecycle hardening: canceled ordering, sweep inactivity/revocation ----

test("a late report for a CANCELED run never advances the loop (cursor + task file untouched)", async () => {
  const { loop, run, rt } = (await seededExecRun());
  (await store.updateRun(run.id, { phase: "canceled", error: "stopped by user" }));

  const res = (await gateway().report(rt, {
    ok: true,
    durationMs: 5,
    cursor: { seenIds: [1, 2, 3] },
    taskFileContent: "# advanced past what the user saw",
  }));
  expect(res.status).toBe(200);
  // The workflow cursor was NOT advanced and the task file NOT synced — the next
  // run must re-process the data whose output the user never saw.
  const stored = (await store.getLoop(loop.id))!;
  expect(stored.state).toBeNull();
  expect(stored.taskFileContent).toBeNull();
  expect((await store.getRun(run.id))!.phase).toBe("canceled");
  // The token died with the report.
  expect((await gateway().agentApi(rt, ["show"])).status).toBe(401);
});

test("a canceled EVOLVE run's report clears the evolve marker (finishEvolution), symmetric to edit", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", evolveDue: true }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "canceled", role: "evolve", ts: new Date().toISOString() }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "evolve", allowControl: true });

  let finished = "";
  const gw = new gatewayMod.MachineGateway({
    maybeFlagEvolve(): void {},
    finishEvolution(id: string): void {
      finished = id;
    },
    finishEdit(): void {},
    addLoop(): void {},
    removeLoop(): void {},
    runNow(): void {},
  } as any);

  expect((await gw.report(rt, { ok: true, durationMs: 5 })).status).toBe(200);
  // Without this, evolveDue stays set and the canceled evolve re-fires next tick.
  expect(finished).toBe(loop.id);
});

test("sweep marks a reclaimed run's token reclaimed: agent-api mutations are refused (409), but the token survives for one wake-report", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" }));
  // Claimed 30min ago, no progress heard since → past the 20min inactivity window.
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs }));
  const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });

  const gw = gateway();
  expect((await gw.agentApi(rt, ["show"])).status).toBe(200); // live before the sweep
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
  // The orphaned agent can no longer MUTATE the loop (reclaimed → 409, not silent),
  // but the token is not revoked outright: it survives to accept one wake-report.
  expect((await gw.agentApi(rt, ["show"])).status).toBe(409);
  expect(tokens.resolveLease(rt)).toBeTruthy();
});

test("sweep is INACTIVITY-based: a >20min run with a fresh progress heartbeat is NOT reclaimed", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" }));
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs }));

  const gw = gateway();
  // The daemon's heartbeat just refreshed the progress stamp → healthy long run.
  (await gw.poll(token, undefined, [{ runId: run.id, step: 7, label: "still working" }]));
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("running"); // never falsely failed

  // Once the stamp itself goes stale (nothing heard for the full window) → reclaimed.
  (await store.updateRun(run.id, { progress: { step: 7, label: "still working", at: staleTs } as { step: number; label: string } }));
  (await gw.sweep());
  expect((await store.getRun(run.id))!.phase).toBe("error");
  expect((await store.getRun(run.id))!.error).toBe("machine timed out / disconnected");
});

test("execFailureStreak is exact past any cap, so the every-Nth reminder keeps firing", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));

  // A success, then 70 consecutive failures — beyond the old capped scan (64),
  // which pinned the streak at 64 and silenced reminders forever.
  (await addExecRun(loop.id, machineId, "done", "2026-05-31T23:59:59Z"));
  for (let i = 1; i <= 70; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, "0");
    const ss = String(i % 60).padStart(2, "0");
    (await addExecRun(loop.id, machineId, "error", `2026-06-01T00:${mm}:${ss}Z`));
  }
  expect((await store.execFailureStreak(loop.id))).toBe(70);
  // 70 % FAILURE_NOTIFY_EVERY(5) === 0 → the "still broken" reminder fires.
  expect(notifyMod.shouldNotifyFailure("auto", 70)).toBe(true);
});

test("show computes `next` in the loop's timezone", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const gw = gateway();
  const showNext = async (timezone: string) => {
    const loop = (await store.createLoop({ userId: "u1", machineId, name: `L-${timezone}`, cron: "0 8 * * *", timezone, enabled: true, notify: "auto" }));
    const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
    const rt = tokens.registerRunLease({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
    const text = ((await gw.agentApi(rt, ["show"])).body as { text: string }).text;
    return text.split("\n").find((l) => l.startsWith("nextFire:"))!;
  };
  // Same cron, timezones 25h apart — the derived nextFire, rendered IN the loop's own
  // timezone, must read differently for the two zones.
  expect((await showNext("Pacific/Kiritimati"))).not.toBe((await showNext("Pacific/Niue")));
});

// ---- wire-input bounds ----

test("poll processes at most 32 progress entries (excess is dropped)", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));

  // 32 junk entries pad the front; the real run's entry sits past the cap.
  const junk = Array.from({ length: 32 }, (_, i) => ({ runId: `nope-${i}`, step: 1, label: "x" }));
  (await gateway().poll(token, undefined, [...junk, { runId: run.id, step: 5, label: "past the cap" }]));
  expect((await store.getRun(run.id))!.progress).toBeNull();

  // Within the cap it lands normally.
  (await gateway().poll(token, undefined, [{ runId: run.id, step: 5, label: "in the cap" }]));
  expect((await store.getRun(run.id))!.progress).toMatchObject({ step: 5, label: "in the cap" });
});

test("createLoop clips an oversized workflow to the 512KB wire cap", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true }));

  const res = (await gateway().createLoop(token, { name: "Big", cron: "0 8 * * *", workflow: "x".repeat(512 * 1024 + 100) }));
  expect(res.status).toBe(200);
  expect((await store.getLoop((res.body as any).id))!.workflow!.length).toBe(512 * 1024);
});

test("report ignores an over-cap workflow cursor but still finalizes the run", async () => {
  const { loop, run, rt } = (await seededExecRun());
  const res = (await gateway().report(rt, { ok: true, durationMs: 5, cursor: { blob: "y".repeat(300 * 1024) } }));
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))!.phase).toBe("done"); // the run still records
  expect((await store.getLoop(loop.id))!.state).toBeNull(); // the runaway cursor does not

  // A sane cursor persists as before.
  const again = (await seededExecRun());
  (await gateway().report(again.rt, { ok: true, durationMs: 5, cursor: { seen: 3 } }));
  expect((await store.getLoop(again.loop.id))!.state).toEqual({ seen: 3 });
});

test("report whitelists the claimed outcome (unknown values fall back to the role default)", async () => {
  const bogus = (await seededExecRun());
  (await gateway().report(bogus.rt, { ok: true, durationMs: 5, outcome: "hijack" as any }));
  expect((await store.getRun(bogus.run.id))!.outcome).toBe("exec"); // role default, not "hijack"

  const direct = (await seededExecRun());
  (await gateway().report(direct.rt, { ok: true, durationMs: 5, outcome: "direct" }));
  expect((await store.getRun(direct.run.id))!.outcome).toBe("direct"); // known value passes
});

test("agent-api report clips --message to the 2000-char cap", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().agentApi(rt, ["report", "--message", "m".repeat(5000)]));
  expect(res.status).toBe(200);
  expect((await store.getRun(run.id))!.message!.length).toBe(2000);
});

test("report clips sessionId and error (untrusted wire input, same discipline as message)", async () => {
  const { run, rt } = (await seededExecRun());
  const res = (await gateway().report(rt, {
    ok: false,
    durationMs: 1,
    sessionId: "s".repeat(500),
    error: "e".repeat(5000),
  }));
  expect(res.status).toBe(200);
  const stored = (await store.getRun(run.id))!;
  expect(stored.sessionId!.length).toBe(200); // SESSION_ID_CAP
  expect(stored.error!.length).toBe(2000); // MESSAGE_CAP
  // A non-string error degrades to the server's default reason.
  const again = (await seededExecRun());
  (await gateway().report(again.rt, { ok: false, durationMs: 1, error: 42 as never }));
  expect((await store.getRun(again.run.id))!.error).toBe("run failed on machine");
});

test("poll persists the daemon version, updating only when it changes", async () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // First poll self-registers and records the reported version.
  (await gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64", version: "0.8.0" }));
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.8.0");
  // A newer version on the next poll updates it.
  (await gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64", version: "0.9.0" }));
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  // A poll with no version leaves it as-is (older daemons don't report it).
  (await gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64" }));
  expect((await store.getMachine(machineId))!.daemonVersion).toBe("0.9.0");
  // An over-long version is clipped defensively (untrusted wire input).
  (await gateway().poll(token, { host: "mac", version: "9".repeat(200) }));
  expect((await store.getMachine(machineId))!.daemonVersion!.length).toBe(64);
});

// ---- /api/machine/cli — unified dispatch, verb × credential matrix (§4.1) ----

/** A machine seeded from a REAL device token, an OPEN loop bound to it, and an exec
 *  run RUNNING with a fresh run token — so one setup drives both the device-credential
 *  and run-credential branches of `cli()` against the same loop. */
async function seededCli(opts: { allowControl?: boolean; goal?: string | null } = {}) {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const loop = (await store.createLoop({
    userId: "u1",
    machineId,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    goal: opts.goal === undefined ? null : opts.goal,
  }));
  const run = (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() }));
  const runToken = tokens.registerRunLease({
    runId: run.id,
    loopId: loop.id,
    machineId,
    role: "exec",
    allowControl: opts.allowControl ?? true,
    canFinish: loop.goal != null,
  });
  return { deviceToken, machineId, loop, run, runToken };
}

test("cli branches by credential: dk_ prefix → device path, bare-UUID → run path", async () => {
  const { deviceToken, runToken, loop } = (await seededCli());
  const gw = gateway();
  // Device credential lists the machine's loops (owner authority).
  const dev = (await gw.cli(deviceToken, ["loops"]));
  expect(dev.status).toBe(200);
  expect((dev.body as any).loops.map((l: any) => l.id)).toContain(loop.id);
  // The same `loops` verb on a RUN credential is owner-only → 403.
  const run = (await gw.cli(runToken, ["loops"]));
  expect(run.status).toBe(403);
});

test("cli run credential: log returns the run's OWN-loop history (closes the note.md seam)", async () => {
  const { runToken, loop, run } = (await seededCli());
  (await store.updateRun(run.id, { status: "new", message: "did a thing", sessionId: "sess-abc" }));
  const res = (await gateway().cli(runToken, ["log"]));
  expect(res.status).toBe(200);
  const body = res.body as any;
  expect(body.text).toContain(loop.id); // loopId is render-only (stripped); the survey text carries it
  expect(body.runs.some((r: any) => r.id === run.id && r.message === "did a thing")).toBe(true); // runs channel retained
  // Batch 4 wired a `log` case into dispatch, so the legacy `/agent-api/loop`
  // transport now yields the run's OWN-loop log too — the help that advertises
  // `log` is truthful on both transports (the seam is closed everywhere).
  const legacy = (await gateway().agentApi(runToken, ["log"]));
  expect(legacy.status).toBe(200);
  expect((legacy.body as { text: string }).text).toContain(loop.id);
});

test("cli run credential: show is scoped to the run's own loop with its caps", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: true }));
  const res = (await gateway().cli(runToken, ["show"]));
  expect(res.status).toBe(200);
  const text = (res.body as { text: string }).text;
  expect(text).toContain(`cron: "${loop.cron}"`);
  expect(text).toContain("selfSchedule: allowed");
});

test("cli run credential: owner-only verbs (new/edit/loops/status) are 403, not unknown-command", async () => {
  const { runToken } = (await seededCli());
  const gw = gateway();
  for (const argv of [["new"], ["edit"], ["loops"], ["status"]]) {
    const res = (await gw.cli(runToken, argv));
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/device credential|own loop/);
  }
});

test("cli device credential: report/finish are run-only → 403", async () => {
  const { deviceToken } = (await seededCli());
  const gw = gateway();
  for (const verb of ["report", "finish", "complete"]) {
    const res = (await gw.cli(deviceToken, [verb]));
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/run-only verb/); // error → text (P6)
  }
});

test("cli run credential: a --loop naming another loop is 403 (never a silent retarget)", async () => {
  const { runToken, loop } = (await seededCli());
  const gw = gateway();
  // Own loop id via --loop is accepted (it equals the slot's loop).
  expect((await gw.cli(runToken, ["log", "--loop", loop.id])).status).toBe(200);
  expect((await gw.cli(runToken, ["show", "--loop", loop.id])).status).toBe(200);
  // A different loop id → hard 403 on both the read verbs and a mutation.
  expect((await gw.cli(runToken, ["log", "--loop", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["show", "--loop", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["reschedule", "--loop", "loop-other", "--next", "30m"])).status).toBe(403);
  // A positional loop id on a read verb is checked the same way.
  expect((await gw.cli(runToken, ["log", "loop-other"])).status).toBe(403);
  expect((await gw.cli(runToken, ["show", "loop-other"])).status).toBe(403);
  // The mismatch must not have touched the loop.
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();
});

test("cli run credential: the reschedule floor still applies through the unified dispatch", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: true }));
  const denied = (await gateway().cli(runToken, ["reschedule", "--next", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeNull();
  // 30m clears the floor — the floor logic is identical to the agent-api path.
  expect((await gateway().cli(runToken, ["reschedule", "--next", "30m"])).status).toBe(200);
  expect((await store.getLoop(loop.id))!.nextRunAt).toBeTruthy();
});

test("reschedule: --run-at (canonical) and --next (alias) both drive the pinned next fire, floors enforced", async () => {
  // F4: the in-run help documents `--run-at` while the code historically only read
  // `--next` — following the help guaranteed a failure. Now BOTH parse.
  const runAt = (await seededCli({ allowControl: true }));
  const viaRunAt = (await gateway().cli(runAt.runToken, ["reschedule", "--run-at", "30m"]));
  expect(viaRunAt.status).toBe(200);
  expect((await store.getLoop(runAt.loop.id))!.nextRunAt).toBeTruthy();

  const next = (await seededCli({ allowControl: true }));
  const viaNext = (await gateway().cli(next.runToken, ["reschedule", "--next", "30m"]));
  expect(viaNext.status).toBe(200);
  expect((await store.getLoop(next.loop.id))!.nextRunAt).toBeTruthy();

  // The self-schedule floor applies to the canonical flag exactly as to the alias.
  const floored = (await seededCli({ allowControl: true }));
  const denied = (await gateway().cli(floored.runToken, ["reschedule", "--run-at", "2m"]));
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect((await store.getLoop(floored.loop.id))!.nextRunAt).toBeNull();
});

test("the in-run help documents exactly what parses (no --run-at drift): its reschedule syntax succeeds verbatim", async () => {
  const { runToken } = (await seededCli({ allowControl: true }));
  const gw = gateway();
  const help = ((await gw.agentApi(runToken, ["help"])).body as { text: string }).text;
  // Help shows the canonical `--run-at` flag (not the retired `--next`).
  expect(help).toContain("--run-at <30m|2h|ISO>");
  // And the flag the help documents actually parses — following the help succeeds,
  // never the shipped drift where the documented flag was silently rejected.
  const followed = (await gw.cli(runToken, ["reschedule", "--run-at", "2h"]));
  expect(followed.status).toBe(200);
});

test("per-verb --help (run credential): role-aware syntax + availability from the lease caps", async () => {
  const { runToken } = (await seededCli({ allowControl: true, goal: "reach the goal" }));
  const gw = gateway();
  // reschedule --help: syntax + the canonical flag + an availability line.
  const resched = (await gw.cli(runToken, ["reschedule", "--help"]));
  expect(resched.status).toBe(200);
  const rt = (resched.body as { text: string }).text;
  expect(rt).toContain("verb: reschedule");
  expect(rt).toContain("--run-at <30m|2h|ISO>");
  // Multi-word values render quoted (TOON), matching the reference tool.
  expect(rt).toContain('availability: "available to this run"');
  expect(rt).toContain("help[");

  // report --help is always available regardless of caps.
  const report = ((await gw.cli(runToken, ["report", "--help"])).body as { text: string }).text;
  expect(report).toContain("verb: report");
  expect(report).toContain("--status new|resolved|nothing-new");
  expect(report).toContain('availability: "always available"');

  // finish --help flips its availability with canFinish: allowed on a closed exec run…
  const finishClosed = ((await gw.cli(runToken, ["finish", "--help"])).body as { text: string }).text;
  expect(finishClosed).toContain('availability: "available — declare the goal met"');
  // …and unavailable on an open (goal-less) loop's exec run.
  const open = (await seededCli({ allowControl: true, goal: null }));
  const finishOpen = ((await gateway().cli(open.runToken, ["finish", "--help"])).body as { text: string }).text;
  expect(finishOpen).toContain("goal (closed) loop only");

  // A structural set-* verb reflects the (missing) evolve/edit cap on an exec run.
  const setUi = ((await gw.cli(runToken, ["set-ui", "--help"])).body as { text: string }).text;
  expect(setUi).toContain("verb: set-ui");
  expect(setUi).toContain("evolve/edit pass only");
});

test("per-verb --help (device credential): owner verbs print full syntax + templates, no availability line", async () => {
  const { deviceToken } = (await seededCli());
  const gw = gateway();
  const edit = (await gw.cli(deviceToken, ["edit", "--help"]));
  expect(edit.status).toBe(200);
  const et = (edit.body as { text: string }).text;
  expect(et).toContain("verb: edit");
  expect(et).toContain("edit <id> --json '<patch>'");
  // The owner surface lists the editable envelope keys (discoverable without failing).
  expect(et).toContain("cron");
  expect(et).toContain("taskFile");
  expect(et).toContain("help[");
  // No run-lease availability caveat on the owner surface.
  expect(et).not.toContain("availability:");

  for (const verb of ["new", "loops", "show", "log"]) {
    const text = ((await gw.cli(deviceToken, [verb, "--help"])).body as { text: string }).text;
    expect(text).toContain(`verb: ${verb}`);
  }
});

test("--help on an unknown verb falls through to unknown-command (no fabricated help)", async () => {
  const { deviceToken, runToken } = (await seededCli());
  const gw = gateway();
  // Device: unknown verb + --help → the switch default 400 (unchanged behavior).
  const dev = (await gw.cli(deviceToken, ["frobnicate", "--help"]));
  expect(dev.status).toBe(400);
  // Run: an owner-only verb is still 403 even with --help (role-aware, not help).
  expect((await gw.cli(runToken, ["new", "--help"])).status).toBe(403);
  // Run: a genuinely unknown verb + --help → dispatch's unknown-command 400.
  expect((await gw.cli(runToken, ["frobnicate", "--help"])).status).toBe(400);
});

test("cli run credential: allowControl still gates schedule mutations through the unified dispatch", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: false }));
  const res = (await gateway().cli(runToken, ["pause"]));
  expect(res.status).toBe(403);
  expect((res.body as { text: string }).text).toMatch(/allowControl/);
  expect((await store.getLoop(loop.id))!.enabled).toBe(true);
});

test("cli run credential: canFinish still gates finish (open loop refused, closed loop honored)", async () => {
  // Open loop → the exec run's canFinish is false → finish 403.
  const open = (await seededCli({ goal: null }));
  const refused = (await gateway().cli(open.runToken, ["finish", "--message", "done"]));
  expect(refused.status).toBe(403);
  expect((refused.body as { text: string }).text).toMatch(/open\/monitor loop/);

  // Closed loop → exec run carries canFinish → finish completes the loop.
  const closed = (await seededCli({ goal: "reach the goal" }));
  const ok = (await gateway().cli(closed.runToken, ["finish", "--message", "goal met"]));
  expect(ok.status).toBe(200);
  expect((await store.getLoop(closed.loop.id))!.completedAt).toBeTruthy();
});

test("cli device credential: new/edit/loops/log/show route to the existing gateway logic", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const gw = gateway();
  // new → createLoop
  const created = (await gw.cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Daily", cron: "0 8 * * *", taskFile: "loopany/x/README.md" })]));
  expect(created.status).toBe(200);
  const newId = idIn(created);
  expect((await store.getLoop(newId))!.machineId).toBe(machineId);
  // loops → listLoops (includes the just-created loop; the `loops` channel is retained)
  const loops = (await gw.cli(deviceToken, ["loops"]));
  expect((loops.body as any).loops.map((l: any) => l.id)).toContain(newId);
  // edit → editLoop (positional loop id + --json patch)
  const edited = (await gw.cli(deviceToken, ["edit", newId, "--json", JSON.stringify({ cron: "0 9 * * *", notify: "always" })]));
  expect(edited.status).toBe(200);
  expect((await store.getLoop(newId))!.cron).toBe("0 9 * * *");
  expect((await store.getLoop(newId))!.notify).toBe("always");
  // log → loopLog for that loop
  const log = (await gw.cli(deviceToken, ["log", newId]));
  expect(log.status).toBe(200);
  expect(textOf(log)).toContain(newId); // loopId is render-only; the survey text carries it
  // show → describe for that loop
  const show = (await gw.cli(deviceToken, ["show", newId]));
  expect(show.status).toBe(200);
  expect((show.body as { text: string }).text).toContain('cron: "0 9 * * *"');
});

test("cli device credential: edit honors --dry-run (validate-only, no persistence)", async () => {
  const { deviceToken, loop } = (await seededCli());
  const before = (await store.getLoop(loop.id))!.cron;
  const dry = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *" }), "--dry-run"]));
  expect(dry.status).toBe(200);
  expect(textOf(dry)).toContain("dry-run:"); // the dry-run render (structured dryRun flag retired)
  expect((await store.getLoop(loop.id))!.cron).toBe(before); // unchanged
});

test("cli device credential: log/show of a loop on ANOTHER machine is a flat 404 (existence never leaks)", async () => {
  const { deviceToken } = (await seededCli());
  // A second machine + loop the first device does not own.
  const otherDevice = tokens.mintDeviceToken();
  const otherMachineId = tokens.machineIdFromToken(otherDevice);
  (await store.createMachine({ id: otherMachineId, userId: "u2", name: "M2", tokenHash: tokens.sha256(otherDevice), online: true }));
  const otherLoop = (await store.createLoop({ userId: "u2", machineId: otherMachineId, name: "Other", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const gw = gateway();
  expect((await gw.cli(deviceToken, ["log", otherLoop.id])).status).toBe(404);
  expect((await gw.cli(deviceToken, ["show", otherLoop.id])).status).toBe(404);
});

test("cli device credential: bad --json for new is a legible 400", async () => {
  const { deviceToken } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["new", "--json", "{not json"]));
  expect(res.status).toBe(400);
  expect(textOf(res)).toMatch(/--json/); // error → text (P6)
});

test("cli rejects an unknown machine (unregistered device token) and a stale run token", async () => {
  const gw = gateway();
  const unknown = tokens.mintDeviceToken();
  expect((await gw.cli(unknown, ["loops"])).status).toBe(401);
  // A bare-UUID that maps to no live run lease → run path 401.
  expect((await gw.cli("00000000-0000-0000-0000-000000000000", ["show"])).status).toBe(401);
});

test("cli run credential: a reclaimed run refuses mutations (409), same as agent-api", async () => {
  const { runToken } = (await seededCli({ allowControl: true }));
  tokens.terminalizeLease(seededReclaimTarget(runToken));
  const res = (await gateway().cli(runToken, ["reschedule", "--next", "30m"]));
  expect(res.status).toBe(409);
});

/** Resolve the runId behind a token so the test can drive terminalizeLease
 *  (which keys on runId) without threading the run through every helper. */
function seededReclaimTarget(runToken: string): string {
  return tokens.resolveLease(runToken)!.runId;
}

// ---- batch 1: the axi-conformance spine — every cli verb carries a TOON `text` ----
// Batch 7 retired the superset render fields: a `/api/machine/cli` body now carries only
// `text` + `exitCode` (+ the retained data channels `loops`/`runs` the daemon reads for
// client-side loop resolution and the `log --json`/`--transcript` escape hatch). Errors
// render as `error:`/`code:` TOON in `text` to stdout. So these tests assert on `text`,
// never the retired `ok`/`id`/`loop`/`changes`/`config`/`ui`/`warning`/… fields.

const textOf = (res: { body: unknown }) => (res.body as { text?: string }).text ?? "";
/** The loop id the server embeds in a `text` render (`created: "X" (loop-abc)`, `loop:
 *  "X" (loop-abc)`, …) — for tests that used to read the now-stripped `body.id`. */
const idIn = (res: { body: unknown }) => textOf(res).match(/\((loop-[a-z0-9-]+)\)/i)?.[1] ?? "";

test("cli loops: text is a TOON list (count + typed header + help), the `loops` channel is retained", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["loops"]));
  expect(res.status).toBe(200);
  const body = res.body as { loops: any[]; text: string; exitCode: number };
  // `loops` is a RETAINED data channel (client-side cwd→loop resolution); `ok` retired.
  expect(body.loops.map((l) => l.id)).toContain(loop.id);
  // TOON surface — default columns are the minimal id/name/cron/enabled/nextFire (P2).
  expect(body.text).toContain("count: 1");
  expect(body.text).toContain("loops[1]{id,name,cron,enabled,nextFire}:");
  expect(body.text).toContain(loop.id);
  expect(body.text).toContain("help[2]:");
  expect(body.exitCode).toBe(0);
});

test("cli loops: an empty machine renders the definitive empty state (count: 0 + loops: [])", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const res = (await gateway().cli(deviceToken, ["loops"]));
  const text = textOf(res);
  expect(text).toContain("count: 0");
  expect(text).toContain("loops: []");
  expect((res.body as { loops: any[] }).loops).toEqual([]);
});

test("cli log [D+R]: text is the TOON run survey (F2), structured runs intact", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const withRuns = (await store.createLoop({ userId: "u1", machineId, name: "Docs Sweep", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  (await store.addRun({
    loopId: withRuns.id, userId: "u1", machineId, phase: "done", role: "exec",
    ts: "2026-07-05T06:00:00Z", outcome: "exec", status: "nothing-new", sessionId: "sess-abc",
    costUsd: 0.08, state: { drift: 0 }, message: "no drift since last sweep",
  }));
  const res = (await gateway().cli(deviceToken, ["log", withRuns.id]));
  expect(res.status).toBe(200);
  const body = res.body as { ok: boolean; runs: any[]; text: string; exitCode: number };
  // Structured fields still there.
  expect(body.runs).toHaveLength(1);
  expect(body.runs[0].sessionId).toBe("sess-abc");
  // F2: a non-empty TOON survey the in-run callback can print.
  expect(body.text.length).toBeGreaterThan(0);
  expect(body.text).toContain(`loop: "Docs Sweep" (${withRuns.id})`);
  expect(body.text).toContain("count: 1 of 1 total");
  expect(body.text).toContain("runs[1]{ts,role,outcome,cost,metrics,session,message}:");
  expect(body.text).toContain("exec,ok/nothing-new,$0.08,drift=0,sess-abc");
  expect(body.text).toContain("summary:");
  expect(body.exitCode).toBe(0);
});

test("cli log: an empty loop renders count: 0 of 0 total + runs: []", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const empty = (await store.createLoop({ userId: "u1", machineId, name: "Empty", cron: "0 0 1 1 *", enabled: true, notify: "auto" }));
  const text = textOf((await gateway().cli(deviceToken, ["log", empty.id])));
  expect(text).toContain("count: 0 of 0 total");
  expect(text).toContain("runs: []");
});

test("cli log [R]: the in-run run credential also gets the TOON survey text (F2 in-run)", async () => {
  const { runToken, run } = (await seededCli());
  (await store.updateRun(run.id, { status: "new", message: "did a thing", sessionId: "sess-run" }));
  const res = (await gateway().cli(runToken, ["log"]));
  expect(res.status).toBe(200);
  expect(textOf(res)).toContain("runs[1]{");
  expect(textOf(res)).toContain("sess-run");
});

test("cli show [D]: text is the config detail with exitCode 0", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["show", loop.id]));
  expect(res.status).toBe(200);
  expect(textOf(res)).toContain(`cron: "${loop.cron}"`);
  expect((res.body as { exitCode: number }).exitCode).toBe(0);
});

// ---- Batch 2: `show` full editable envelope + read/write identity (§4.1, F1/F6) ----

/** Create a richly-configured loop (every editable field non-default) so the
 *  roundtrip actually exercises each key, not just the defaults. */
async function seededRichLoop() {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const gw = gateway();
  const created = (await gw.cli(deviceToken, [
    "new",
    "--json",
    JSON.stringify({
      name: "Docs Sweep",
      cron: "0 6 * * 1",
      timezone: "America/Los_Angeles",
      notify: "always",
      taskFile: "loopany/docs-sweep/README.md",
      goal: "ship v1",
      workflow: "return { state: prev };",
      ui: "<div id=\"dash\">hello dashboard body that is comfortably over the size hint threshold</div>",
      stateSchema: [{ key: "drift", label: "Drift", unit: "files" }],
    }),
  ]));
  const id = idIn(created);
  // model/allowControl aren't create fields; the pinned runAt override is edit-only.
  // Set them so the envelope carries non-default values for every editable key.
  const edited = (await gw.cli(deviceToken, ["edit", id, "--json", JSON.stringify({ model: "opus", allowControl: false, runAt: "2h" })]));
  expect(edited.status).toBe(200);
  return { deviceToken, machineId, id, gw };
}

test("show --json → edit --dry-run roundtrip: the envelope minus id is a no-op patch (read/write identity)", async () => {
  const { deviceToken, id, gw } = (await seededRichLoop());

  const show = (await gw.cli(deviceToken, ["show", id, "--json"]));
  expect(show.status).toBe(200);
  // The wire `text` IS the JSON envelope (what a text-sink daemon prints); the retired
  // structured `loop` field is gone, so parse the envelope out of `text` (§4.1 transport).
  const env = JSON.parse((show.body as { text: string }).text) as Record<string, unknown>;
  // Keyed EXACTLY as edit --json accepts: id + every EDITABLE_LOOP_FIELDS key.
  expect(Object.keys(env).sort()).toEqual(
    ["allowControl", "cron", "enabled", "goal", "id", "model", "name", "notify", "runAt", "stateSchema", "taskFile", "timezone", "ui", "workflow"].sort(),
  );
  expect(env.id).toBe(id);
  // No derived read-only aggregates leak into the editable envelope.
  for (const k of ["nextFire", "classification", "runs", "selfSchedule", "selfFinish"]) {
    expect(env).not.toHaveProperty(k);
  }

  // Drop id (identity, not editable); the rest fed verbatim to edit --dry-run changes nothing.
  const { id: _drop, ...patch } = env;
  const dry = (await gw.cli(deviceToken, ["edit", id, "--json", JSON.stringify(patch), "--dry-run"]));
  expect(dry.status).toBe(200);
  // Read/write identity via `text` (structured changes/rejections retired): a no-op dry-run
  // renders "nothing changed" + "changes: none" + "rejections: none", never a change/rejection block.
  expect(dry.body).toHaveProperty("exitCode", 0);
  const dryText = textOf(dry);
  expect(dryText).toContain("nothing changed");
  expect(dryText).toContain("changes: none");
  expect(dryText).toContain("rejections: none");
  expect(dryText).not.toMatch(/changes\[\d+\]/);
  expect(dryText).not.toMatch(/rejections\[\d+\]/);
});

test("show --json → edit roundtrip holds when the pinned runAt is stale (past): re-feeding it is a no-op, never a 400", async () => {
  const { deviceToken, id, gw } = (await seededRichLoop());
  // A paused/completed loop keeps a stale (past) pin — the scheduler never clears
  // nextRunAt for a disabled loop, so `show --json` echoes a past ISO.
  const pastPin = "2020-01-01T00:00:00.000Z";
  (await store.updateLoop(id, { nextRunAt: pastPin, enabled: false }));

  const show = (await gw.cli(deviceToken, ["show", id, "--json"]));
  expect(show.status).toBe(200);
  const env = JSON.parse((show.body as { text: string }).text) as Record<string, unknown>;
  expect(env.runAt).toBe(pastPin);

  const { id: _drop, ...patch } = env;
  const dry = (await gw.cli(deviceToken, ["edit", id, "--json", JSON.stringify(patch), "--dry-run"]));
  expect(dry.status).toBe(200);
  expect(dry.body).toHaveProperty("exitCode", 0);
  const dryText = textOf(dry);
  expect(dryText).toContain("nothing changed");
  expect(dryText).not.toMatch(/changes\[\d+\]/);
  expect(dryText).not.toMatch(/rejections\[\d+\]/);
});

test("show: large ui/workflow show a size hint by default and inline under --full", async () => {
  const { deviceToken, id, gw } = (await seededRichLoop());

  const def = textOf((await gw.cli(deviceToken, ["show", id])));
  // Presence + size hint, NOT the body (feedback #2 — never a char-clipped body).
  expect(def).toMatch(/ui: present, \d+ bytes — use --full to see/);
  expect(def).toMatch(/workflow: present, \d+ bytes — use --full to see/);
  expect(def).not.toContain("hello dashboard body");
  expect(def).not.toContain("return { state: prev }");

  const full = textOf((await gw.cli(deviceToken, ["show", id, "--full"])));
  // --full inlines the complete bodies.
  expect(full).toContain("hello dashboard body");
  expect(full).toContain("return { state: prev }");
  expect(full).not.toContain("use --full to see");
});

test("show: runAt (pinned override) and nextFire (derived cron fire) are both present and distinct (F4)", async () => {
  const { deviceToken, id, gw } = (await seededRichLoop());
  const text = textOf((await gw.cli(deviceToken, ["show", id])));
  const runAtLine = text.split("\n").find((l) => l.trim().startsWith("runAt:"))!;
  const nextFireLine = text.split("\n").find((l) => l.startsWith("nextFire:"))!;
  expect(runAtLine).toBeTruthy();
  expect(nextFireLine).toBeTruthy();
  // runAt was pinned (2h out) — a real ISO, not the em-dash placeholder.
  expect(runAtLine).not.toContain("—");
  // The two carry different values (override instant ≠ next weekly cron fire).
  expect(runAtLine.replace("runAt:", "").trim()).not.toBe(nextFireLine.replace("nextFire:", "").trim());
});

test("show: derived aggregates (nextFire/classification/runs) accompany the envelope", async () => {
  const { deviceToken, id, gw } = (await seededRichLoop());
  const text = textOf((await gw.cli(deviceToken, ["show", id])));
  expect(text).toMatch(/^nextFire: /m);
  // Closed loop (has a goal).
  expect(text).toContain("classification: closed (has goal");
  expect(text).toMatch(/^runs: \d+ total/m);
});

test("show --json [R]: the run credential emits the same envelope, scoped to its own loop", async () => {
  const { runToken, loop } = (await seededCli({ allowControl: true }));
  const res = (await gateway().cli(runToken, ["show", "--json"]));
  expect(res.status).toBe(200);
  const env = JSON.parse((res.body as { text: string }).text) as Record<string, unknown>;
  expect(env.id).toBe(loop.id);
  // The run's effective selfSchedule/selfFinish lines are TOON-only — never in the
  // read/write envelope.
  expect(env).not.toHaveProperty("selfSchedule");
  expect(env).not.toHaveProperty("selfFinish");
});

test("cli new: text is the created-loop confirmation (id/name are render-only now, in `text`)", async () => {
  const { deviceToken } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Docs Sweep", cron: "0 6 * * 1", taskFile: "loopany/x/README.md" })]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string; exitCode: number };
  const text = body.text;
  expect(text).toContain(`created: "Docs Sweep" (${idIn(res)})`);
  expect(text).toContain("classification: open — runs until paused");
  expect(text).toContain("dashboard: not applied");
  expect(text).toContain("nextRuns[3]:");
  expect(text).toContain("help[2]:");
  expect(body.exitCode).toBe(0);
});

test("cli new: a closed loop reads classification closed; a provided-but-dropped ui warns loud", async () => {
  const { deviceToken } = (await seededCli());
  const closed = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Ship v1", cron: "0 9 * * *", taskFile: "x", goal: "ship v1" })]));
  expect(textOf(closed)).toContain("classification: closed — self-finishes when the goal is met");
  // A ui that sanitizes to nothing is surfaced as a warning line, not silently dropped.
  const dropped = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "W", cron: "0 8 * * *", taskFile: "x", ui: "   " })]));
  expect(textOf(dropped)).toContain("warning:"); // the dropped-dashboard warning rides in `text` (structured `warning` retired)
});

test("cli new --dry-run: text is the normalized config detail + fire preview (structured config retired)", async () => {
  const { deviceToken } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Docs Sweep", cron: "0 6 * * 1", taskFile: "loopany/x/README.md" }), "--dry-run"]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string };
  expect(body.text).toContain("dry-run:");
  expect(body.text).toContain('cron: "0 6 * * 1"');
  expect(body.text).toContain("nextRuns[3]:");
});

test("F9: cli new nextRuns renders in the loop's OWN timezone with a zone label, not raw UTC (matches show's nextFire)", async () => {
  const { deviceToken } = (await seededCli());
  // 0 5 * * * Asia/Shanghai → 05:00 local == 21:00Z. The OLD render showed the raw UTC
  // slice ("… 21:00", unlabeled); the fix shows the loop-local time + zone.
  const res = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "SH", cron: "0 5 * * *", timezone: "Asia/Shanghai", taskFile: "x" })]));
  const nextRunsLine = textOf(res).split("\n").find((l) => l.startsWith("nextRuns[3]:"))!;
  expect(nextRunsLine).toBeTruthy();
  expect(nextRunsLine).toContain("05:00"); // loop-local hour, not the 21:00 UTC hour
  expect(nextRunsLine).not.toContain("21:00");
  expect(nextRunsLine).toMatch(/GMT\+8|GMT\+08/); // carries the zone label like show's nextFire
  // Dry-run shares the same zoned render.
  const dry = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "SH", cron: "0 5 * * *", timezone: "Asia/Shanghai", taskFile: "x" }), "--dry-run"]));
  const dryLine = textOf(dry).split("\n").find((l) => l.startsWith("nextRuns[3]:"))!;
  expect(dryLine).toContain("05:00");
  expect(dryLine).toMatch(/GMT\+8|GMT\+08/);
});

test("F4: cli loops --json returns REAL JSON (the full records), not TOON", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["loops", "--json"]));
  expect(res.status).toBe(200);
  const text = textOf(res);
  // First non-space byte is `[` (a JSON array), NOT `c` (TOON's `count:`).
  expect(text.trimStart()[0]).toBe("[");
  const parsed = JSON.parse(text);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.map((l: { id: string }) => l.id)).toContain(loop.id);
  // `--json` mirrors `show --json`: `runs`/`lastOutcome` are computed unconditionally,
  // never the lazy 0/null the TOON path uses without `--fields`.
  const rec = parsed.find((l: { id: string }) => l.id === loop.id) as { runs: number; lastOutcome: string | null };
  expect(rec.runs).toBe(await store.countRuns(loop.id));
  expect(rec.runs).toBeGreaterThan(0);
  // The `loops` data channel still rides alongside (retained for client-side resolution).
  expect((res.body as { loops: unknown[] }).loops.length).toBeGreaterThan(0);
  expect((res.body as { exitCode: number }).exitCode).toBe(0);
});

test("F8: cli edit with an empty patch is a valid no-op reporting 'nothing to change' + the editable-key list (exit 0)", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", "{}"]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string; exitCode: number };
  expect(body.exitCode).toBe(0);
  expect(body.text).toContain(`nothing to change: L (${loop.id})`); // nothingToChange flag retired → asserted via text
  expect(body.text).toContain("editable[");
  expect(body.text).toContain("cron"); // the key list is present so the next attempt is well-formed
});

test("cli edit: text is the updated-loop confirmation with the applied keys inline", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *", notify: "always" })]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string; exitCode: number };
  expect(body.text).toContain(`updated: L (${loop.id})`); // bare: "L" needs no quoting; `applied` now render-only in `text`
  expect(body.text).toMatch(/applied\[2\]: (cron, notify|notify, cron)/);
  expect(body.exitCode).toBe(0);
});

test("cli edit --dry-run: text renders the changes list; a rejection flips the header + adds a rejections block", async () => {
  const { deviceToken, loop } = (await seededCli());
  const ok = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *" }), "--dry-run"]));
  expect(textOf(ok)).toContain("nothing changed");
  expect(textOf(ok)).toContain("changes[1]{key,from,to}:");
  expect(textOf(ok)).toContain("rejections: none");
  // A bad notify value is a per-key rejection in dry-run.
  const bad = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *", notify: "sometimes" }), "--dry-run"]));
  const text = textOf(bad);
  expect(text).toContain("1 change valid, 1 rejected");
  expect(text).toContain("rejections[1]{key,reason}:");
  expect(text).toContain("notify,");
});

test("cli report [R]: success renders the compact TOON line; state metrics inline", async () => {
  const { runToken } = (await seededCli());
  const res = (await gateway().cli(runToken, ["report", "--status", "nothing-new"]));
  expect(res.status).toBe(200);
  expect(textOf(res)).toBe("reported: status=nothing-new");
  expect((res.body as { exitCode: number }).exitCode).toBe(0);

  const withMetrics = (await gateway().cli(runToken, ["report", "--status", "new", "--state", '{"drift":3}', "--message", "opened a PR"]));
  expect(textOf(withMetrics)).toBe("reported: status=new · metrics drift=3 · message recorded");
});

test("F5: cli report rejects an invalid --status with a 400 VALIDATION_ERROR (no silent drop)", async () => {
  const { runToken, run } = (await seededCli());
  const res = (await gateway().cli(runToken, ["report", "--status", "wibble"]));
  expect(res.status).toBe(400);
  const text = textOf(res);
  expect(text).toContain('error: "status must be new|resolved|nothing-new (got \\"wibble\\")"');
  expect(text).toContain("code: VALIDATION_ERROR");
  expect((res.body as { exitCode: number }).exitCode).toBe(1);
  // Fail-loud: the run's status was NOT mutated (the old code dropped it, exit 0).
  expect((await store.getRun(run.id))!.status ?? null).toBeNull();
});

test("F5: the same fail-loud guard applies through the raw agent-api transport too", async () => {
  const { rt, run } = (await seededExecRun());
  const res = (await gateway().agentApi(rt, ["report", "--status", "bogus"]));
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toContain("code: VALIDATION_ERROR");
  expect((await store.getRun(run.id))!.status ?? null).toBeNull();
});

test("cli finish [R]: success renders the goal-met detail; a second finish is a CONFLICT", async () => {
  const closed = (await seededCli({ goal: "reach the goal" }));
  const ok = (await gateway().cli(closed.runToken, ["finish", "--message", "goal met", "--reason", "shipped"]));
  expect(ok.status).toBe(200);
  const text = textOf(ok);
  expect(text).toContain(`finished: L (${closed.loop.id}) — goal met`); // bare: "L" needs no quoting
  expect(text).toContain("completedAt:");
  expect(text).toContain("completionReason: shipped");
  // The lease stays live for one enriching report, so a second finish is a legible CONFLICT.
  const again = (await gateway().cli(closed.runToken, ["finish", "--message", "again"]));
  expect(again.status).toBe(400);
  expect(textOf(again)).toContain("code: CONFLICT");
});

test("cli errors render as error:/code: TOON to stdout with exitCode 1", async () => {
  const { deviceToken } = (await seededCli());
  // A createLoop validation error (bad --json) → structured error + rendered text.
  const badJson = (await gateway().cli(deviceToken, ["new", "--json", "{not json"]));
  expect(badJson.status).toBe(400);
  expect(textOf(badJson)).toMatch(/--json/); // structured `error` → rendered into `text`
  expect(textOf(badJson)).toContain("error: ");
  expect(textOf(badJson)).toContain("code: VALIDATION_ERROR");
  expect((badJson.body as { exitCode: number }).exitCode).toBe(1);

  // The device-credential run-only denial surfaces as a FORBIDDEN error to stdout.
  const denied = (await gateway().cli(deviceToken, ["report"]));
  expect(denied.status).toBe(403);
  expect(textOf(denied)).toContain("code: FORBIDDEN");
  expect(textOf(denied)).toContain("run-only verb");
});

// ---- batch 3: list/create aggregates, edit no-op, error contract, `new` idempotency ----

test("cli loops: count aggregate + nextFire on an enabled loop, — on a paused one", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  // An enabled loop that fires soon, and a paused one (no next fire).
  const on = (await store.createLoop({ userId: "u1", machineId, name: "Docs Sweep", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  const off = (await store.createLoop({ userId: "u1", machineId, name: "Ship v1", cron: "0 9 * * *", enabled: false, notify: "auto" }));
  const text = textOf((await gateway().cli(deviceToken, ["loops"])));
  expect(text).toContain("count: 2");
  expect(text).toContain("loops[2]{id,name,cron,enabled,nextFire}:");
  // The enabled loop shows a computed fire time; the paused loop shows the em-dash.
  const rows = text.split("\n");
  const onRow = rows.find((r) => r.includes(on.id))!;
  expect(onRow).toContain("on");
  expect(onRow).toMatch(/"\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/); // a quoted fire time
  const offRow = rows.find((r) => r.includes(off.id))!;
  expect(offRow).toContain("paused");
  expect(offRow.trimEnd().endsWith("—")).toBe(true); // paused ⇒ nextFire is —
});

test("cli loops --fields: extends the default columns from the optional set (in request order)", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 6 * * 1", enabled: true, notify: "always", goal: "ship it" }));
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-07-05T06:00:00Z", outcome: "exec", status: "nothing-new" }));
  const text = textOf((await gateway().cli(deviceToken, ["loops", "--fields", "notify,goal,runs,lastOutcome"])));
  expect(text).toContain("loops[1]{id,name,cron,enabled,nextFire,notify,goal,runs,lastOutcome}:");
  const row = text.split("\n").find((r) => r.includes(loop.id))!;
  expect(row).toContain("always");
  expect(row).toContain('"ship it"'); // goal (quoted, has a space)
  expect(row).toContain("nothing-new"); // lastOutcome token
  expect(row).toMatch(/,1,/); // runs count = 1
});

test("cli loops --fields lastOutcome: tracks the last EXEC run, never masked by a later evolve/edit", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  // A loop whose newest run is a SUCCESSFUL evolve but whose last scheduled exec FAILED.
  const masked = (await store.createLoop({ userId: "u1", machineId, name: "Masked", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  (await store.addRun({ loopId: masked.id, userId: "u1", machineId, phase: "error", role: "exec", ts: "2026-07-05T06:00:00Z", outcome: "error", status: null }));
  (await store.addRun({ loopId: masked.id, userId: "u1", machineId, phase: "done", role: "evolve", ts: "2026-07-05T07:00:00Z", outcome: "evolve", status: null }));
  // A loop with only an exec run.
  const execOnly = (await store.createLoop({ userId: "u1", machineId, name: "ExecOnly", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  (await store.addRun({ loopId: execOnly.id, userId: "u1", machineId, phase: "done", role: "exec", ts: "2026-07-05T06:00:00Z", outcome: "exec", status: "nothing-new" }));
  // A loop with no exec runs at all (only an edit).
  const noExec = (await store.createLoop({ userId: "u1", machineId, name: "NoExec", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  (await store.addRun({ loopId: noExec.id, userId: "u1", machineId, phase: "done", role: "edit", ts: "2026-07-05T06:00:00Z", outcome: "exec", status: null }));

  const text = textOf((await gateway().cli(deviceToken, ["loops", "--fields", "lastOutcome"])));
  const rows = text.split("\n");
  const maskedRow = rows.find((r) => r.includes(masked.id))!;
  expect(maskedRow).toContain("failed"); // the failed exec, NOT the later successful evolve
  expect(maskedRow).not.toContain("evolve");
  const execRow = rows.find((r) => r.includes(execOnly.id))!;
  expect(execRow).toContain("ok/nothing-new");
  const noExecRow = rows.find((r) => r.includes(noExec.id))!;
  expect(noExecRow.trimEnd().endsWith("—")).toBe(true); // no exec run ⇒ lastOutcome is —
});

test("cli loops --fields: an unknown field fails loud (VALIDATION_ERROR, exit 1, available set listed)", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  (await store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  const res = (await gateway().cli(deviceToken, ["loops", "--fields", "notify,bogus"]));
  expect(res.status).toBe(400);
  const text = textOf(res);
  expect(text).toContain("unknown field(s): bogus");
  expect(text).toContain("available: timezone, notify, model, goal, taskFile, runs, lastOutcome");
  expect(text).toContain("code: VALIDATION_ERROR");
  expect((res.body as { exitCode: number }).exitCode).toBe(1);
});

test("cli loops --fields: a default column requested as an extra is rejected (only the optional set extends)", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true }));
  const res = (await gateway().cli(deviceToken, ["loops", "--fields", "name"]));
  expect(res.status).toBe(400);
  expect(textOf(res)).toContain("unknown field(s): name");
});

test("cli new: an idempotent replay with the same key returns the SAME loop (never a twin)", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const gw = gateway();
  const cfg = JSON.stringify({ name: "Docs Sweep", cron: "0 6 * * 1", taskFile: "loopany/x/README.md", ui: "<div id='dash'>hi</div>", idempotencyKey: "key-abc" });
  const before = (await store.loopsForMachine(machineId)).length;
  const first = (await gw.cli(deviceToken, ["new", "--json", cfg]));
  expect(first.status).toBe(200);
  const firstId = idIn(first);
  expect(textOf(first)).not.toContain("idempotent replay"); // a genuine first create
  expect((await store.getLoop(firstId))!.ui).toBeTruthy(); // a dashboard was applied on the real create
  expect((await store.loopsForMachine(machineId)).length).toBe(before + 1);

  // A retry with the SAME key returns the SAME loop — the §4.5 replay TOON, no twin.
  const replay = (await gw.cli(deviceToken, ["new", "--json", cfg]));
  expect(replay.status).toBe(200);
  expect(idIn(replay)).toBe(firstId); // same loop, no twin
  expect(textOf(replay)).toContain("[idempotent replay — existing loop returned]");
  // The replayed loop still carries its dashboard (id/idempotent/ui are render-only now).
  expect((await store.getLoop(firstId))!.ui).toBeTruthy();
  expect((await store.loopsForMachine(machineId)).length).toBe(before + 1); // still exactly one
});

test("cli new: an idempotent replay of a no-dashboard loop stays dashboard-less", async () => {
  const { deviceToken } = (await seededCli());
  const gw = gateway();
  const cfg = JSON.stringify({ name: "Plain", cron: "0 6 * * 1", taskFile: "x", idempotencyKey: "key-noui" });
  const first = (await gw.cli(deviceToken, ["new", "--json", cfg]));
  expect((await store.getLoop(idIn(first)))!.ui ?? null).toBeNull(); // no dashboard applied
  const replay = (await gw.cli(deviceToken, ["new", "--json", cfg]));
  expect(textOf(replay)).toContain("idempotent replay");
  expect((await store.getLoop(idIn(replay)))!.ui ?? null).toBeNull();
});

test("cli new: a different key (different config) does NOT collide — an intentional twin survives", async () => {
  const { deviceToken, machineId } = (await seededCli());
  const gw = gateway();
  const a = (await gw.cli(deviceToken, ["new", "--json", JSON.stringify({ name: "A", cron: "0 6 * * 1", taskFile: "x", idempotencyKey: "k-a" })]));
  const b = (await gw.cli(deviceToken, ["new", "--json", JSON.stringify({ name: "B", cron: "0 6 * * 1", taskFile: "x", idempotencyKey: "k-b" })]));
  expect(idIn(a)).not.toBe(idIn(b));
  expect(textOf(b)).not.toContain("idempotent replay"); // an intentional twin, not a replay
});

test("cli new: idempotency binds the machine — the same key from another machine is not a replay", async () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  (await store.createMachine({ id: machineA, userId: "u1", name: "A", tokenHash: tokens.sha256(tokenA), online: true }));
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  (await store.createMachine({ id: machineB, userId: "u1", name: "B", tokenHash: tokens.sha256(tokenB), online: true }));
  const gw = gateway();
  const cfg = JSON.stringify({ name: "Shared", cron: "0 6 * * 1", taskFile: "x", idempotencyKey: "shared-key" });
  const a = (await gw.cli(tokenA, ["new", "--json", cfg]));
  const b = (await gw.cli(tokenB, ["new", "--json", cfg]));
  // Same content key, different machines ⇒ two distinct loops (no cross-machine replay).
  expect(idIn(a)).not.toBe(idIn(b));
  expect(textOf(b)).not.toContain("idempotent replay");
  expect((await store.getLoop(idIn(a)))!.machineId).toBe(machineA);
  expect((await store.getLoop(idIn(b)))!.machineId).toBe(machineB);
});

test("cli new: an EXPIRED idempotency key allows a genuine re-create (TTL window elapsed)", async () => {
  const { deviceToken, machineId } = (await seededCli());
  // Seed a stale record (older than the 15-min window) for a known key, pointing at a
  // loop that no longer needs to be returned — the read must drop it and create fresh.
  tokens.recordNewIdempotency("stale-key", machineId, "loop-ancient", Date.now() - (tokens.NEW_IDEMPOTENCY_TTL_MS + 1000));
  const res = (await gateway().cli(deviceToken, ["new", "--json", JSON.stringify({ name: "Fresh", cron: "0 6 * * 1", taskFile: "x", idempotencyKey: "stale-key" })]));
  expect(res.status).toBe(200);
  expect(textOf(res)).not.toContain("idempotent replay"); // NOT a replay — the stale key expired
  expect(idIn(res)).not.toBe("loop-ancient");
  expect((await store.getLoop(idIn(res)))!.machineId).toBe(machineId);
});

test("cli edit --json '{}': an empty patch is a valid no-op (nothing to change + the editable keys), exit 0", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", "{}"]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string; exitCode: number };
  expect(body.text).toContain("nothing to change:"); // ok/applied/nothingToChange retired → asserted via text
  expect(body.text).toContain("editable[");
  expect(body.text).toContain("cron"); // the allowed-key list is surfaced
  expect(body.exitCode).toBe(0);
});

test("cli edit --dry-run: a rejection flips the header, lists changes + rejections, and exits 1", async () => {
  const { deviceToken, loop } = (await seededCli());
  const res = (await gateway().cli(deviceToken, ["edit", loop.id, "--json", JSON.stringify({ cron: "0 9 * * *", notify: "sometimes" }), "--dry-run"]));
  // A dry-run with a rejection is not ok → exit 1 (the error contract). ok/changes/
  // rejections are render-only now → the whole shape is asserted via `text`.
  const body = res.body as { text: string; exitCode: number };
  expect(body.exitCode).toBe(1);
  const text = body.text;
  expect(text).toContain("1 change valid, 1 rejected");
  expect(text).toContain("changes[1]{key,from,to}:");
  expect(text).toContain("cron"); // the valid change
  expect(text).toContain("rejections[1]{key,reason}:");
  expect(text).toContain("notify"); // the rejected key
});

// ---- content-first home (P8/§5.1, Batch 6) ----------------------------------

test("cli home [device]: an unregistered machine renders the DEFINITIVE not-connected state (never a 401/empty)", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const res = (await gateway().cli(deviceToken, ["home"]));
  expect(res.status).toBe(200);
  const body = res.body as { ok: boolean; text: string; exitCode: number };
  expect(body.exitCode).toBe(0);
  expect(body.text).toContain("machine: not connected — run `loopany up`");
  expect(body.text).toContain("description:");
  expect(body.text).toContain("help[");
  // No loops/recent blocks when not connected, but never empty output.
  expect(body.text).not.toContain("loops[");
});

test("cli home [device]: a registered machine shows presence + its loops + recent runs + help, with the daemon-passed context", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true, lastSeen: new Date().toISOString() }));
  const loop = (await store.createLoop({ userId: "u1", machineId, name: "Docs Sweep", cron: "0 6 * * 1", enabled: true, notify: "auto" }));
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "done", role: "exec", status: "nothing-new", outcome: "exec", ts: new Date().toISOString() }));

  const res = (await gateway().cli(deviceToken, ["home", "--bin", "/Users/x/.local/bin/loopany", "--pid", "4821", "--server", "https://srv.example"]));
  expect(res.status).toBe(200);
  const text = (res.body as { text: string }).text;
  expect(text).toContain("bin: /Users/x/.local/bin/loopany");
  expect(text).toContain("machine: online · daemon pid 4821 · https://srv.example");
  expect(text).toContain("loops[1]{name,cron,enabled,nextFire,lastOutcome}:");
  expect(text).toContain("Docs Sweep");
  expect(text).toContain("recent[1]{ts,loop,outcome}:");
  expect(text).toContain("help[");
});

test("cli home [device]: --cwd scopes 'loops here' to the loop rooted at the directory, counting the rest as elsewhere", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true, lastSeen: new Date().toISOString() }));
  const here = (await store.createLoop({ userId: "u1", machineId, name: "Here", cron: "0 6 * * *", enabled: true, notify: "auto", taskFile: "/work/here/README.md" }));
  (await store.createLoop({ userId: "u1", machineId, name: "Elsewhere", cron: "0 7 * * *", enabled: true, notify: "auto", taskFile: "/work/other/README.md" }));

  const res = (await gateway().cli(deviceToken, ["home", "--cwd", "/work/here"]));
  const text = (res.body as { text: string }).text;
  expect(text).toContain("Here");
  expect(text).not.toContain("Elsewhere,"); // not listed as a row
  // F11: the cwd-scoped block header is `loops here[N]` (design §5.1), against the
  // `loops elsewhere: N more` count — the "here" only makes sense with an "elsewhere".
  expect(text).toContain("loops here[1]{name,cron,enabled,nextFire,lastOutcome}:");
  expect(text).not.toContain("\nloops[1]{"); // NOT the plain unscoped header
  expect(text).toContain("loops elsewhere: 1 more on this machine");
  expect(here.id).toBeTruthy();
});

test("cli home [device]: an UNSCOPED full-machine view keeps the plain `loops[N]` header (no 'here')", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true, lastSeen: new Date().toISOString() }));
  (await store.createLoop({ userId: "u1", machineId, name: "Only", cron: "0 6 * * *", enabled: true, notify: "auto", taskFile: "/work/only/README.md" }));
  // No --cwd (or a cwd matching nothing) ⇒ all loops are "here", elsewhere 0 ⇒ plain header.
  const text = ((await gateway().cli(deviceToken, ["home"])).body as { text: string }).text;
  expect(text).toContain("loops[1]{name,cron,enabled,nextFire,lastOutcome}:");
  expect(text).not.toContain("loops here[");
  expect(text).not.toContain("loops elsewhere:");
});

test("F7: cli home [device] ALWAYS leads with a `bin:` line — the durable path when passed, else the honest not-on-PATH fallback", async () => {
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  (await store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true, lastSeen: new Date().toISOString() }));
  // Durable: the daemon passes --bin with the resolved shim/global path.
  const withBin = ((await gateway().cli(deviceToken, ["home", "--bin", "/Users/x/.local/bin/loopany"])).body as { text: string }).text;
  expect(withBin.split("\n")[0]).toBe("bin: /Users/x/.local/bin/loopany");
  // Non-durable (npx-without-global): no --bin ⇒ the fallback line still leads (P8), never missing.
  const noBin = ((await gateway().cli(deviceToken, ["home"])).body as { text: string }).text;
  expect(noBin.split("\n")[0]).toBe("bin: (not on PATH — run `npm i -g @crewlet/loopany`)");
});

test("F7: the not-connected home also leads with the `bin:` fallback line", async () => {
  const deviceToken = tokens.mintDeviceToken(); // unregistered → not-connected branch
  const text = ((await gateway().cli(deviceToken, ["home"])).body as { text: string }).text;
  expect(text.split("\n")[0]).toBe("bin: (not on PATH — run `npm i -g @crewlet/loopany`)");
  expect(text).toContain("machine: not connected — run `loopany up`");
});

test("cli home [run]: renders the run's OWN loop context (role + goal + recent) scoped to the lease's loop", async () => {
  const { runToken, loop } = (await seededCli({ goal: "ship v1" }));
  (await store.addRun({ loopId: loop.id, userId: "u1", machineId: loop.machineId, phase: "done", role: "exec", status: "new", outcome: "exec", message: "did a thing", ts: new Date().toISOString() }));
  const res = (await gateway().cli(runToken, ["home"]));
  expect(res.status).toBe(200);
  const body = res.body as { text: string; exitCode: number };
  expect(body.exitCode).toBe(0);
  expect(body.text).toContain(`loop: L (${loop.id}) · role exec · goal ${JSON.stringify("ship v1")}`);
  expect(body.text).toContain("recent[");
  expect(body.text).toContain("Run `loopany report --status nothing-new` to close this run");
});
