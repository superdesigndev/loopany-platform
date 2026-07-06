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
  db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
  notifyMod = await import("./notify.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.sqlite.exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
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
function seededExecRun(notify: "always" | "auto" | "never" = "auto") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  return { machineId, loop, run, rt };
}

/** Insert a team (+ optional member rows) directly, bypassing store.ensureTeam's
 *  memo/rename side effects so each test controls membership precisely. */
function makeTeam(id: string, memberUserIds: string[] = []): void {
  const ts = new Date().toISOString();
  db.sqlite.exec(`INSERT OR IGNORE INTO teams (id, name, owner_user_id, created_at) VALUES ('${id}', '${id}', NULL, '${ts}')`);
  for (const u of memberUserIds) {
    db.sqlite.exec(
      `INSERT OR IGNORE INTO team_members (id, team_id, user_id, role, created_at) VALUES ('${id}:${u}', '${id}', '${u}', 'member', '${ts}')`,
    );
  }
}

function seededLoop() {
  const machine = store.createMachine({ id: "m-gateway", userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = store.createLoop({
    userId: "u1",
    machineId: machine.id,
    name: "L",
    cron: "0 0 1 1 *",
    enabled: true,
    notify: "auto",
    stateSchema: [{ key: "mrr" }],
    ui: "<h3>{{latest.mrr}}</h3>",
  });
  const run = store.addRun({
    loopId: loop.id,
    userId: loop.userId,
    machineId: machine.id,
    phase: "running",
    role: "evolve",
    ts: new Date().toISOString(),
    state: { mrr: 10 },
  });
  return { machine, loop, run };
}

test("set-ui is only allowed for an evolution run token and is audited", () => {
  const { loop, machine, run } = seededLoop();
  const execToken = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: true,
  });
  const rejected = gateway().agentApi(execToken, ["set-ui", "--file-content", "<h3>Denied</h3>"]);
  expect(rejected.status).toBe(403);

  const evolveToken = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const ok = gateway().agentApi(evolveToken, ["set-ui", "--file-content", "<h3>{{latest.mrr}}</h3>"]);
  expect(ok.status).toBe(200);
  expect(store.getLoop(loop.id)!.ui).toBe("<h3>{{latest.mrr}}</h3>");
  expect(store.getRun(run.id)!.control?.[0]?.command).toBe("set-ui");
  expect(store.getRun(run.id)!.control?.[0]?.result).toBe("ok");
});

test("show reports the run's effective self-schedule capability", () => {
  const { loop, machine, run } = seededLoop();
  const gw = gateway();
  const showText = (allowControl: boolean, role: "exec" | "evolve" = "exec") => {
    const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId: machine.id, role, allowControl });
    return (gw.agentApi(rt, ["show"]).body as { text: string }).text;
  };
  // A run that MAY self-schedule reads `allowed`; one that may not reads `off`.
  const allowed = showText(true);
  expect(allowed).toContain("self-schedule: allowed");
  expect(allowed).toContain(`cron: ${loop.cron}`);
  const off = showText(false);
  expect(off).toContain("self-schedule: off");
  // An evolve/edit pass carries the effective (structural) capability, so it reads allowed.
  expect(showText(true, "evolve")).toContain("self-schedule: allowed");
});

test("help (and a bare/unknown-flag invocation) returns role-aware usage", () => {
  const { loop, machine, run } = seededLoop();
  const execToken = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const gw = gateway();
  const helpText = (argv: string[]) => {
    const res = gw.agentApi(execToken, argv);
    expect(res.status).toBe(200);
    return (res.body as { text: string }).text;
  };
  for (const argv of [["help"], ["--help"], []]) {
    const text = helpText(argv);
    expect(text).toContain("loopany — in-run agent CLI");
    expect(text).toContain("report");
    expect(text).toContain("set-schema");
  }
  // An exec run can't set-* or control → help says so, not "available".
  const execHelp = helpText(["help"]);
  expect(execHelp).toContain('evolve/edit pass only — this run is "exec"');
  expect(execHelp).toContain("needs allowControl");

  // An evolve run with the caps sees those groups marked available.
  const evolveToken = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetUi: true,
  });
  const evolveHelp = (gw.agentApi(evolveToken, ["help"]).body as { text: string }).text;
  expect(evolveHelp).toContain("dashboard / gate (available to this run)");
  expect(evolveHelp).toContain("schedule control (available to this run)");
});

test("set-schema rejects dropping keys still used by UI or recent runs", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetSchema: true,
  });
  const res = gateway().agentApi(token, ["set-schema", "--file-content", JSON.stringify([{ key: "paid" }])]);

  expect(res.status).toBe(400);
  expect(store.getLoop(loop.id)!.stateSchema).toEqual([{ key: "mrr" }]);
  expect(store.getRun(run.id)!.control?.[0]?.command).toBe("set-schema");
  expect(store.getRun(run.id)!.control?.[0]?.result).toBe("rejected");
});

test("report persists the slimmed transcript, retrievable by session id", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = gateway().report(token, {
    ok: true,
    durationMs: 1234,
    sessionId: "sess-abc",
    transcript: [
      { kind: "text", text: "Checking the feeder…" },
      { kind: "tool", name: "Bash", input: '{"command":"curl ha"}', extra: "dropped" },
      { kind: "result", text: "4g dispensed" },
      { kind: "bogus", text: "ignored" }, // invalid kind → filtered
    ],
  });
  expect(res.status).toBe(200);

  const stored = store.getRun(run.id);
  expect(stored?.sessionId).toBe("sess-abc");
  expect(stored?.transcript).toEqual([
    { kind: "text", text: "Checking the feeder…" },
    { kind: "tool", name: "Bash", input: '{"command":"curl ha"}' },
    { kind: "result", text: "4g dispensed" },
  ]);
});

test("report persists the claude-reported cost (usd column + usage json), rejecting garbage fields", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = gateway().report(token, {
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
  });
  expect(res.status).toBe(200);

  const stored = store.getRun(run.id);
  expect(stored?.costUsd).toBe(0.4235);
  expect(stored?.usage).toEqual({ inputTokens: 120, outputTokens: 950, cacheReadTokens: 48000, numTurns: 12 });
});

test("report with an absent or wholly-garbage cost leaves the cost columns null", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  // usd over the sanity ceiling + non-numeric tokens → everything dropped.
  const res = gateway().report(token, { ok: true, durationMs: 5, cost: { usd: 99_999_999, inputTokens: "lots" } });
  expect(res.status).toBe(200);
  const stored = store.getRun(run.id);
  expect(stored?.costUsd).toBeNull();
  expect(stored?.usage).toBeNull();
});

test("report syncs the machine's task file content onto the loop", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "exec",
    allowControl: false,
  });
  const res = gateway().report(token, {
    ok: true,
    durationMs: 1000,
    taskFileContent: "# Breakfast log\n2026-06-19: 4g dispensed\n",
  });
  expect(res.status).toBe(200);

  const stored = store.getLoop(loop.id);
  expect(stored?.taskFileContent).toBe("# Breakfast log\n2026-06-19: 4g dispensed\n");
  expect(stored?.taskFileSyncedAt).toBeTruthy();
});

test("a machine's bound loops gate its deletion (loopsForMachine drains to empty)", () => {
  const { machine, loop } = seededLoop();
  // While a loop is bound, the delete guard sees it and must block.
  expect(store.loopsForMachine(machine.id).map((l) => l.id)).toEqual([loop.id]);
  // Remove the loop first → the machine is now free to delete.
  store.deleteLoop(loop.id);
  expect(store.loopsForMachine(machine.id)).toHaveLength(0);
  expect(store.deleteMachine(machine.id)).toBe(true);
});

test("createLoop persists a valid IANA timezone and rejects a bogus one", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  const ok = gateway().createLoop(token, {
    name: "Morning report",
    cron: "0 8 * * *",
    timezone: "Asia/Shanghai",
    taskFile: "loopany/x/README.md",
  });
  expect(ok.status).toBe(200);
  expect(store.getLoop((ok.body as any).id)!.timezone).toBe("Asia/Shanghai");

  const bad = gateway().createLoop(token, {
    name: "Bad tz",
    cron: "0 8 * * *",
    timezone: "Mars/Phobos",
    taskFile: "loopany/x/README.md",
  });
  expect(bad.status).toBe(400);
  expect((bad.body as any).error).toMatch(/invalid timezone/);
});

test("createLoop records the coding agent: codex when declared, claude-code by default, and degrades an unknown value", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  // Explicit codex (the daemon's measured env / --agent codex) is persisted verbatim.
  const codex = gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "codex" });
  expect(codex.status).toBe(200);
  expect(store.getLoop((codex.body as any).id)!.agent).toBe("codex");

  // Absent agent (older daemon) back-fills to claude-code via the column default.
  const legacy = gateway().createLoop(token, { name: "Legacy loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  expect(legacy.status).toBe(200);
  expect(store.getLoop((legacy.body as any).id)!.agent).toBe("claude-code");

  // An unrecognized / "unknown" value degrades to the default rather than rejecting.
  const weird = gateway().createLoop(token, { name: "Weird loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "unknown" });
  expect(weird.status).toBe(200);
  expect(store.getLoop((weird.body as any).id)!.agent).toBe("claude-code");
});

test("createLoop accepts an initial ui (day-one dashboard) — validated, persisted, presence-flagged in dry-run", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  const ui = '<h3>React Doctor</h3><loop-chart series="score:Red Dot Score"></loop-chart><loop-kanban columns="open,merged"></loop-kanban>';

  // Real create — the ui persists on the loop row (same surface as set-ui/editLoop).
  const created = gateway().createLoop(token, {
    name: "React Doctor", cron: "0 5 * * *", taskFile: "loopany/react-doctor/README.md",
    stateSchema: [{ key: "score", label: "Red Dot Score" }], ui,
  });
  expect(created.status).toBe(200);
  const loop = store.getLoop((created.body as any).id)!;
  expect(loop.ui).toBe(ui);
  expect(loop.stateSchema).toEqual([{ key: "score", label: "Red Dot Score" }]);
  // The real create response echoes ui presence (like dry-run), no warning when applied.
  expect((created.body as any).ui).toBe(true);
  expect((created.body as any).warning).toBeUndefined();

  // Dry-run reports ui as a presence flag (like workflow), never the markup, and persists nothing.
  const before = store.loopsForMachine(machineId).length;
  const dry = gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", ui, dryRun: true });
  expect(dry.status).toBe(200);
  expect((dry.body as any).config.ui).toBe(true);
  const withoutUi = gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", dryRun: true });
  expect((withoutUi.body as any).config.ui).toBe(false);
  expect(store.loopsForMachine(machineId).length).toBe(before);
});

test("createLoop surfaces a DROPPED ui loudly — provided but validated to nothing, never silent", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  // A whitespace-only ui coerces to null: the loop is still created, but the response
  // echoes ui:false AND a warning so a dropped dashboard is never a silent no-op.
  const res = gateway().createLoop(token, { name: "NoDash", cron: "0 5 * * *", taskFile: "x", ui: "   " });
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.ui).toBe(false);
  expect(b.warning).toMatch(/not applied|without a dashboard/i);
  expect(store.getLoop(b.id)!.ui).toBeNull();

  // Same surfacing on the dry-run path (warning at top level).
  const dry = gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x", ui: "   ", dryRun: true });
  expect((dry.body as any).config.ui).toBe(false);
  expect((dry.body as any).warning).toMatch(/not applied|without a dashboard/i);

  // No warning when no ui was provided at all (a blank loop is not a dropped dashboard).
  const plain = gateway().createLoop(token, { cron: "0 5 * * *", taskFile: "x" });
  expect((plain.body as any).warning).toBeUndefined();
  expect((plain.body as any).ui).toBe(false);
});

test("editLoop changes a loop's envelope from its machine's device token", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "Daily", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const res = gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always", enabled: false });
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["cron", "notify", "enabled"]));
  const loop = store.getLoop(id)!;
  expect(loop.cron).toBe("0 9 * * *");
  expect(loop.notify).toBe("always");
  expect(loop.enabled).toBe(false);

  // A bogus cron is rejected and leaves the loop untouched.
  const bad = gateway().editLoop(token, id, { cron: "not a cron" });
  expect(bad.status).toBe(400);
  expect(store.getLoop(id)!.cron).toBe("0 9 * * *");
});

test("editLoop repoints the task file and pushes workflow/ui/schema without a run", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "Migrate", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const res = gateway().editLoop(token, id, {
    taskFile: "/home/u/newproj/README.md",
    workflow: "return { state: prev };",
    ui: "<div id='dash'>hi</div>",
    stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }],
  });
  expect(res.status).toBe(200);
  expect((res.body as any).applied).toEqual(expect.arrayContaining(["taskFile", "workflow", "ui", "stateSchema"]));
  const loop = store.getLoop(id)!;
  expect(loop.taskFile).toBe("/home/u/newproj/README.md");
  expect(loop.workflow).toContain("return { state: prev }");
  expect(loop.ui).toContain("dash");
  expect(loop.stateSchema).toEqual([{ key: "mrr", label: "MRR", unit: "$" }]);
});

test("editLoop accepts stateSchema as a JSON string too (run-token parity)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const res = gateway().editLoop(token, id, { stateSchema: '[{"key":"visits","label":"Visits"}]' } as any);
  expect(res.status).toBe(200);
  expect(store.getLoop(id)!.stateSchema).toEqual([{ key: "visits", label: "Visits" }]);
});

test("editLoop validates content fields (bad schema → 400, loop untouched)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const bad = gateway().editLoop(token, id, { stateSchema: [{ notKey: 1 }] } as any);
  expect(bad.status).toBe(400);
  expect(store.getLoop(id)!.stateSchema).toBeNull();
});

test("editLoop clips an oversized workflow to the wire cap (same discipline as createLoop)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "Big", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const res = gateway().editLoop(token, id, { workflow: "x".repeat(600 * 1024), ui: "<div>ok</div>" });
  expect(res.status).toBe(200);
  const loop = store.getLoop(id)!;
  expect(loop.workflow!.length).toBe(512 * 1024); // WIRE_TEXT_CAP
  expect(loop.ui).toBe("<div>ok</div>");
});

test("editLoop rejects an unknown patch key with a clear 400 (never silent no-op)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "S", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  // A typo (or an attempt to patch an identity column) fails loudly.
  const res = gateway().editLoop(token, id, { teamId: "other", croon: "0 9 * * *" } as any);
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/unknown field/);
  expect((res.body as any).error).toMatch(/teamId/);
  // Nothing changed.
  expect(store.getLoop(id)!.cron).toBe("0 8 * * *");
});

test("editLoop refuses a loop bound to a different machine (404, no change)", () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  store.createMachine({ id: machineA, userId: "u1", name: "A", tokenHash: tokens.sha256(tokenA), online: true });
  const created = gateway().createLoop(tokenA, { name: "Owned", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  store.createMachine({ id: machineB, userId: "u2", name: "B", tokenHash: tokens.sha256(tokenB), online: true });

  const res = gateway().editLoop(tokenB, id, { cron: "*/5 * * * *" });
  expect(res.status).toBe(404);
  expect(store.getLoop(id)!.cron).toBe("0 8 * * *"); // untouched
});

test("poll stores live progress on this machine's running run; report clears it", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });

  gateway().poll(token, undefined, [{ runId: run.id, step: 3, label: "Editing report.md" }]);
  // The signal carries a freshness stamp (`at`) alongside step/label — the sweep's
  // inactivity clock.
  expect(store.getRun(run.id)!.progress).toMatchObject({ step: 3, label: "Editing report.md" });
  expect((store.getRun(run.id)!.progress as { at?: string }).at).toBeTruthy();

  // A different machine can't write progress onto a run it doesn't own.
  const other = tokens.mintDeviceToken();
  gateway().poll(other, undefined, [{ runId: run.id, step: 9, label: "hijack" }]);
  expect(store.getRun(run.id)!.progress).toMatchObject({ step: 3, label: "Editing report.md" });

  // Finalizing the run clears the live signal (the full transcript supersedes it).
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  gateway().report(rt, { ok: true, durationMs: 10 });
  expect(store.getRun(run.id)!.progress).toBeNull();
});

test("set-tz applies the timezone through an allowControl run token", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "edit", allowControl: true });
  const res = gateway().agentApi(token, ["set-tz", "Asia/Tokyo"]);
  expect(res.status).toBe(200);
  expect(store.getLoop(loop.id)!.timezone).toBe("Asia/Tokyo");

  const bad = gateway().agentApi(token, ["set-tz", "Mars/Phobos"]);
  expect(bad.status).toBe(400);
  expect(store.getLoop(loop.id)!.timezone).toBe("Asia/Tokyo"); // unchanged
});

test("an edit run's report routes to finishEdit (the pending edit marker is cleared)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", editRequest: "run at 9am" });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "edit", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "edit", allowControl: true });

  let finished = "";
  const gw = new gatewayMod.MachineGateway({
    maybeFlagEvolve(): void {},
    finishEvolution(): void {},
    finishEdit(id: string): void {
      finished = id;
      store.updateLoop(id, { editRequest: null });
    },
    addLoop(): void {},
    removeLoop(): void {},
    runNow(): void {},
  } as any);

  const res = gw.report(rt, { ok: true, durationMs: 5 });
  expect(res.status).toBe(200);
  expect(finished).toBe(loop.id);
  expect(store.getLoop(loop.id)!.editRequest).toBeNull();
});

// ---- per-team connect-key: createLoop resolves the team from the claim intent ----

test("createLoop lands the loop in the connect-key's team, not the machine's home team (existing-machine reuse)", () => {
  makeTeam("team-reuse", ["u1"]);
  // The machine's durable identity (home team = its personal team).
  const deviceToken = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(deviceToken);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(deviceToken), online: true });
  // Team B's fresh connect-key (a different token than the device identity), minted
  // under team B — this is the realistic "one machine, second team" capture path.
  const connectKey = tokens.mintDeviceToken();
  tokens.rememberClaimIntent(connectKey, { userId: "u1", teamId: "team-reuse" });

  const res = gateway().createLoop(deviceToken, { name: "B loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: connectKey });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-reuse");
});

test("createLoop rejects (403) a claim minted by a different user — fail closed, nothing created", () => {
  makeTeam("team-x", ["u2"]);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "u2", teamId: "team-x" }); // minted by someone else

  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token });
  expect(res.status).toBe(403);
  expect(store.listLoops().length).toBe(0); // never mis-filed
});

test("createLoop rejects (403) when the minter is no longer a member of the claim team", () => {
  makeTeam("team-y", []); // team exists, u1 is NOT a member (and not an admin)
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "u1", teamId: "team-y" });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token });
  expect(res.status).toBe(403);
  expect(store.listLoops().length).toBe(0);
});

test("createLoop authorizes a superadmin for any existing team even without a membership row", () => {
  makeTeam("team-admin", []); // exists; admin is not a member
  db.sqlite.exec(`INSERT OR IGNORE INTO user (id, name, email) VALUES ('admin1', 'Admin', 'admin@example.com')`);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "admin1", teamId: "team-admin1", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "admin1", teamId: "team-admin" });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-admin");
});

test("createLoop with no claim falls back to the machine's home team (back-compat)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-home", name: "M", tokenHash: tokens.sha256(token), online: true });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-home");
});

test("createLoop with a claim for the machine's OWN home team needs no membership re-check (open-mode path)", () => {
  // Mirrors open mode: intent team === home team, so the cross-team gate is skipped
  // and no team_members row is required (there is none for the shared user).
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "shared", teamId: "team-shared", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "shared", teamId: "team-shared" });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "loopany/x/README.md", claim: token });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-shared");
});

test("claimStatus surfaces the MEASURED agent so the New-loop confirmation shows what actually ran", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const claim = "ck_confirm_agent";

  // The daemon measured Codex on the host and sent it on the create; the claim
  // result must carry that recorded value (not a removed dialog pre-selection).
  const res = gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", taskFile: "loopany/x/README.md", agent: "codex", claim });
  expect(res.status).toBe(200);
  expect(gateway().claimStatus(claim)?.agent).toBe("codex");
});

test("listMachinesForTeam is membership-scoped — a machine shows in its owner's team regardless of its home team", () => {
  makeTeam("team-lm", ["u1"]); // only u1 is a member
  const t1 = tokens.mintDeviceToken();
  const m1 = tokens.machineIdFromToken(t1);
  store.createMachine({ id: m1, userId: "u1", teamId: "team-u1", name: "Mine", tokenHash: tokens.sha256(t1), online: true });
  const t2 = tokens.mintDeviceToken();
  store.createMachine({ id: tokens.machineIdFromToken(t2), userId: "u2", teamId: "team-u2", name: "Other", tokenHash: tokens.sha256(t2), online: true });

  // u1's machine (home team-u1) appears under team-lm via membership; u2's doesn't.
  expect(store.listMachinesForTeam("team-lm").map((m) => m.id)).toEqual([m1]);
});

test("set-workflow updates only through an evolution token", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id,
    loopId: loop.id,
    machineId: machine.id,
    role: "evolve",
    allowControl: true,
    canSetWorkflow: true,
  });
  const res = gateway().agentApi(token, ["set-workflow", "--file-content", "return { state: prev }"]);

  expect(res.status).toBe(200);
  expect(store.getLoop(loop.id)!.workflow).toBe("return { state: prev }");
  expect(store.getRun(run.id)!.control?.[0]?.command).toBe("set-workflow");
});

// ---- workflow syntax validation (write-time, zero-exec) across all three paths ----
// The daemon runner wraps the body in an async arrow inside a generated ES module,
// so top-level export/import (the Claude Code Workflow tool's `export const meta`
// header) is a parse error that kills every run. The server rejects it at write time.

const EXPORT_META = 'export const meta = { name: "x" };\nreturn { state: prev };';
const STATIC_IMPORT = 'import fs from "node:fs";\nreturn { state: prev };';
const GOOD_WORKFLOW = 'const res = await tools.call("posthog.exec", { q: 1 });\nreturn { message: `${res.data?.length ?? 0} rows`, state: prev };';

test("set-workflow rejects an `export const meta` body with a fix-teaching message; loop untouched", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = gateway().agentApi(token, ["set-workflow", "--file-content", EXPORT_META]);
  expect(res.status).toBe(400);
  const text = (res.body as { text: string }).text;
  expect(text).toMatch(/syntax error/i);
  expect(text).toMatch(/export const meta/);
  expect(text).toMatch(/NOT an ES module/);
  expect(text).toMatch(/Claude Code Workflow tool/);
  // Nothing stored — the loop had no workflow and still has none.
  expect(store.getLoop(loop.id)!.workflow ?? null).toBeNull();
});

test("set-workflow rejects a static import body", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = gateway().agentApi(token, ["set-workflow", "--file-content", STATIC_IMPORT]);
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/import/i);
});

test("set-workflow accepts a real `await tools.call(...)` body unchanged", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const res = gateway().agentApi(token, ["set-workflow", "--file-content", GOOD_WORKFLOW]);
  expect(res.status).toBe(200);
  expect(store.getLoop(loop.id)!.workflow).toBe(GOOD_WORKFLOW);
});

test("set-workflow accepts a body containing the literal word `export` inside a string (no false positive)", () => {
  const { loop, machine, run } = seededLoop();
  const token = tokens.registerRunToken({
    runId: run.id, loopId: loop.id, machineId: machine.id, role: "evolve", allowControl: true, canSetWorkflow: true,
  });
  const body = 'return { message: "export const meta = not real" };';
  const res = gateway().agentApi(token, ["set-workflow", "--file-content", body]);
  expect(res.status).toBe(200);
  expect(store.getLoop(loop.id)!.workflow).toBe(body);
});

test("editLoop rejects an `export const meta` workflow with a rejection entry; loop untouched", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  // Non-dry-run editLoop surfaces the first rejection as body.error (400).
  const res = gateway().editLoop(token, id, { workflow: EXPORT_META });
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/export const meta/);
  expect(store.getLoop(id)!.workflow ?? null).toBeNull();

  // The dry-run path reports it as a per-key rejection entry instead.
  const dry = gateway().editLoop(token, id, { workflow: EXPORT_META }, true);
  expect(dry.status).toBe(200);
  const reject = ((dry.body as any).rejections as Array<{ key: string; reason: string }>).find((r) => r.key === "workflow");
  expect(reject).toBeTruthy();
  expect(reject!.reason).toMatch(/NOT an ES module/);
  expect((dry.body as any).ok).toBe(false);
});

test("createLoop rejects an `export const meta` workflow before persisting (400, nothing created)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const before = store.loopsForMachine(machineId).length;
  const res = gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: EXPORT_META });
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/export const meta/);
  expect(store.loopsForMachine(machineId).length).toBe(before);
});

test("createLoop --dry-run surfaces the workflow syntax error before persistence", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const res = gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: EXPORT_META, dryRun: true });
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/NOT an ES module/);
  expect(store.loopsForMachine(machineId).length).toBe(0);
});

test("createLoop accepts a legal `tools.call` workflow (no taskFile needed)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const res = gateway().createLoop(token, { name: "C", cron: "0 8 * * *", workflow: GOOD_WORKFLOW });
  expect(res.status).toBe(200);
  const loop = store.getLoop((res.body as any).id)!;
  expect(loop.workflow).toBe(GOOD_WORKFLOW);
});

// ---- closed-loop goal: finish verb, gating, completion side effects, reopen ----

/** A machine + a CLOSED loop (goal set unless goal:null) with an exec run RUNNING,
 *  its run token minted with the poll-derived canFinish. Ready for `finish`. */
function seededClosedRun(opts: { notify?: "always" | "auto" | "never"; goal?: string | null } = {}) {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const goal = opts.goal === undefined ? "reach the goal" : opts.goal;
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: opts.notify ?? "auto", goal });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: loop.goal != null });
  return { token, machineId, loop, run, rt };
}

test("finish completes a closed loop: run resolved, loop stamped terminal + disabled, notified", () => {
  const { loop, run, rt } = seededClosedRun();
  const { sent, fn } = recordingNotify();

  const res = gateway(fn).agentApi(rt, ["finish", "--message", "hit 100 signups", "--reason", "target met"]);
  expect(res.status).toBe(200);

  const r = store.getRun(run.id)!;
  expect(r.phase).toBe("done");
  expect(r.outcome).toBe("exec");
  expect(r.status).toBe("resolved");
  expect(r.message).toBe("hit 100 signups");

  const l = store.getLoop(loop.id)!;
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
  expect(gateway().agentApi(rt, ["show"]).status).toBe(200);
});

test("finish leaves the token live for the daemon's enriching report (durationMs + sessionId), which then revokes it", () => {
  const { loop, run, rt } = seededClosedRun();
  const gw = gateway();
  expect(gw.agentApi(rt, ["finish", "--message", "done"]).status).toBe(200);

  // The daemon's normal post-run report arrives with the precise durationMs + sessionId.
  const rep = gw.report(rt, { ok: true, durationMs: 4321, sessionId: "sess-xyz" });
  expect(rep.status).toBe(200);

  const r = store.getRun(run.id)!;
  expect(r.durationMs).toBe(4321);
  expect(r.sessionId).toBe("sess-xyz");
  // The loop stays completed (the enriching report never re-stamps).
  expect(store.getLoop(loop.id)!.completedAt).toBeTruthy();
  // Enrichment revoked the token — a second report is now a no-op (401).
  expect(gw.report(rt, { ok: true, durationMs: 9 }).status).toBe(401);
});

test("finish TOCTOU: refuses (loop untouched) when the goal was cleared after the run started", () => {
  const { token, loop, run, rt } = seededClosedRun();
  // Owner clears the goal mid-run (editLoop {goal:null}) — the run's canFinish was
  // minted at poll, so it's stale.
  expect(gateway().editLoop(token, loop.id, { goal: null } as any).status).toBe(200);

  const res = gateway().agentApi(rt, ["finish", "--message", "x"]);
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/no longer has a goal/i);
  const l = store.getLoop(loop.id)!;
  expect(l.completedAt).toBeNull();
  expect(l.enabled).toBe(true);
  expect(store.getRun(run.id)!.phase).toBe("running"); // untouched
});

test("finish is single-shot: a second finish on the same still-live run refuses, no re-stamp/re-notify", () => {
  const { loop, run, rt } = seededClosedRun();
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  expect(gw.agentApi(rt, ["finish", "--message", "first", "--reason", "target met"]).status).toBe(200);
  const first = store.getLoop(loop.id)!;
  expect(first.completedAt).toBeTruthy();
  expect(sent).toHaveLength(1);

  // The token is still live (for the enriching report), so a second finish is attempted.
  const res = gw.agentApi(rt, ["finish", "--message", "second", "--reason", "again"]);
  expect(res.status).toBe(400);
  expect((res.body as { text: string }).text).toMatch(/already finished/i);

  // Loop stamps unchanged (no re-stamp), run message unchanged, no second notification.
  const l = store.getLoop(loop.id)!;
  expect(l.completedAt).toBe(first.completedAt);
  expect(l.completionReason).toBe("target met");
  expect(store.getRun(run.id)!.message).toBe("first");
  expect(sent).toHaveLength(1);
});

test("finish alias `complete` works the same", () => {
  const { loop, rt } = seededClosedRun();
  const res = gateway().agentApi(rt, ["complete", "--reason", "done"]);
  expect(res.status).toBe(200);
  expect(store.getLoop(loop.id)!.completedAt).toBeTruthy();
});

test("finish validates --state against the loop schema like report", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "g", stateSchema: [{ key: "mrr" }] });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true, canFinish: true });

  // An unknown key is rejected (400) and nothing completes.
  const bad = gateway().agentApi(rt, ["finish", "--state", '{"nope":1}']);
  expect(bad.status).toBe(400);
  expect(store.getLoop(loop.id)!.completedAt).toBeNull();

  // A schema-valid metric is recorded on the run and the loop completes.
  const ok = gateway().agentApi(rt, ["finish", "--state", '{"mrr":9000}']);
  expect(ok.status).toBe(200);
  expect(store.getRun(run.id)!.state).toEqual({ mrr: 9000 });
  expect(store.getLoop(loop.id)!.completedAt).toBeTruthy();
});

test("finish on an OPEN loop (no goal) is refused 403 — nothing completes", () => {
  const { loop, run, rt } = seededClosedRun({ goal: null });
  const res = gateway().agentApi(rt, ["finish", "--message", "x"]);
  expect(res.status).toBe(403);
  expect((res.body as { text: string }).text).toMatch(/no goal to finish/i);
  const l = store.getLoop(loop.id)!;
  expect(l.completedAt).toBeNull();
  expect(l.enabled).toBe(true);
  expect(store.getRun(run.id)!.phase).toBe("running"); // untouched
});

test("evolve and edit runs never get canFinish — finish refused even on a closed loop", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "reach goal" });
  for (const role of ["evolve", "edit"] as const) {
    const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() });
    // Mirrors poll: structural runs get canFinish false.
    const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true, canFinish: false });
    const res = gateway().agentApi(rt, ["finish", "--message", "x"]);
    expect(res.status).toBe(403);
    expect((res.body as { text: string }).text).toMatch(/only an exec run/i);
  }
  expect(store.getLoop(loop.id)!.completedAt).toBeNull();
});

test("finish honors notify:never (no completion push)", () => {
  const { rt } = seededClosedRun({ notify: "never" });
  const { sent, fn } = recordingNotify();
  const res = gateway(fn).agentApi(rt, ["finish", "--reason", "done"]);
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(0);
});

test("poll mints canFinish only for an exec run on a closed loop (via show self-finish line)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const closed = store.createLoop({ userId: "u1", machineId, name: "C", cron: "0 0 1 1 *", enabled: true, notify: "auto", goal: "g" });
  store.addRun({ loopId: closed.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });
  const open = store.createLoop({ userId: "u1", machineId, name: "O", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  store.addRun({ loopId: open.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: new Date().toISOString() });

  const gw = gateway();
  const deliveries = (gw.poll(token).body as { deliveries: Array<{ loop: { id: string }; runToken: string }> }).deliveries;
  const tokenFor = (loopId: string) => deliveries.find((d) => d.loop.id === loopId)!.runToken;

  const closedShow = (gw.agentApi(tokenFor(closed.id), ["show"]).body as { text: string }).text;
  expect(closedShow).toContain("goal: g");
  expect(closedShow).toContain("self-finish: allowed");

  const openShow = (gw.agentApi(tokenFor(open.id), ["show"]).body as { text: string }).text;
  expect(openShow).toContain("goal: —");
  expect(openShow).toContain("self-finish: off");
});

test("createLoop accepts a goal (closed loop); absent goal ⇒ open loop", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  const closed = gateway().createLoop(token, { name: "C", cron: "0 8 * * *", taskFile: "loopany/x/README.md", goal: "reach 100 users" });
  expect(store.getLoop((closed.body as any).id)!.goal).toBe("reach 100 users");

  const open = gateway().createLoop(token, { name: "O", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  expect(store.getLoop((open.body as any).id)!.goal).toBeNull();
});

test("editLoop sets a goal, and clearing it (goal:null) also clears the completion stamps", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "G", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const id = (created.body as any).id as string;

  expect(gateway().editLoop(token, id, { goal: "ship v1" }).status).toBe(200);
  expect(store.getLoop(id)!.goal).toBe("ship v1");

  // Simulate a completed loop, then clear the goal → stamps drop (invariant held).
  store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "shipped", enabled: false });
  expect(gateway().editLoop(token, id, { goal: null } as any).status).toBe(200);
  const l = store.getLoop(id)!;
  expect(l.goal).toBeNull();
  expect(l.completedAt).toBeNull();
  expect(l.completionReason).toBeNull();
});

test("reopen: editLoop enabled:true on a completed loop clears the stamps; a plain pause leaves them", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "R", cron: "0 8 * * *", taskFile: "loopany/x/README.md", goal: "g" });
  const id = (created.body as any).id as string;
  store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "met", enabled: false });

  // Reopen: enabled:true drops the terminal stamps (goal survives).
  expect(gateway().editLoop(token, id, { enabled: true }).status).toBe(200);
  const reopened = store.getLoop(id)!;
  expect(reopened.enabled).toBe(true);
  expect(reopened.completedAt).toBeNull();
  expect(reopened.completionReason).toBeNull();
  expect(reopened.goal).toBe("g");

  // A plain pause (enabled:false) on a completed loop leaves stamps untouched.
  store.updateLoop(id, { completedAt: "2026-07-02T00:00:00Z", completionReason: "met2", enabled: false });
  expect(gateway().editLoop(token, id, { enabled: false }).status).toBe(200);
  expect(store.getLoop(id)!.completedAt).toBe("2026-07-02T00:00:00Z");
});

// ---- --dry-run: validate-only preview for new + edit (no persistence) ----

/** A connected machine + its device token, for the dry-run tests. */
function seededMachine() {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  return { token, machineId };
}

test("createLoop --dry-run returns the normalized config + 3 fire times + closed classification, persists nothing", () => {
  const { token, machineId } = seededMachine();
  const before = store.loopsForMachine(machineId).length;
  const res = gateway().createLoop(token, {
    name: "DryClosed", cron: "0 8 * * *", timezone: "America/New_York",
    taskFile: "loopany/x/README.md", goal: "ship v1", dryRun: true,
  });
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
  expect(store.loopsForMachine(machineId).length).toBe(before);
});

test("createLoop --dry-run classifies a goal-less loop as open", () => {
  const { token } = seededMachine();
  const res = gateway().createLoop(token, { cron: "0 8 * * *", taskFile: "x", dryRun: true });
  expect((res.body as any).classification).toBe("open");
  expect((res.body as any).classificationText).toMatch(/runs until paused/i);
});

test("createLoop --dry-run still validates (bad cron → 400, nothing created)", () => {
  const { token, machineId } = seededMachine();
  const res = gateway().createLoop(token, { cron: "not a cron", taskFile: "x", dryRun: true });
  expect(res.status).toBe(400);
  expect(store.loopsForMachine(machineId)).toHaveLength(0);
});

test("createLoop --dry-run rejects a config with neither workflow nor taskFile", () => {
  const { token } = seededMachine();
  const res = gateway().createLoop(token, { cron: "0 8 * * *", dryRun: true });
  expect(res.status).toBe(400);
  expect((res.body as any).error).toMatch(/workflow.*taskFile/i);
});

test("editLoop --dry-run previews per-key before→after and persists nothing", () => {
  const { token } = seededMachine();
  const created = gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" });
  const id = (created.body as any).id as string;
  const res = gateway().editLoop(token, id, { cron: "0 9 * * *", notify: "always" }, true);
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(true);
  const changes = b.changes as Array<{ key: string; from: unknown; to: unknown }>;
  expect(changes.find((c) => c.key === "cron")).toEqual({ key: "cron", from: "0 8 * * *", to: "0 9 * * *" });
  expect(changes.find((c) => c.key === "notify")?.to).toBe("always");
  // Not persisted.
  expect(store.getLoop(id)!.cron).toBe("0 8 * * *");
  expect(store.getLoop(id)!.notify).toBe("auto");
});

test("editLoop --dry-run reports whitelist + invalid-value rejections (ok:false), changes nothing", () => {
  const { token } = seededMachine();
  const created = gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x" });
  const id = (created.body as any).id as string;
  const res = gateway().editLoop(token, id, { croon: "x", cron: "not a cron" } as any, true);
  expect(res.status).toBe(200);
  const b = res.body as any;
  expect(b.dryRun).toBe(true);
  expect(b.ok).toBe(false);
  const keys = (b.rejections as Array<{ key: string }>).map((r) => r.key);
  expect(keys).toContain("croon"); // whitelist rejection
  expect(keys).toContain("cron"); // invalid-value rejection
  expect(store.getLoop(id)!.cron).toBe("0 8 * * *");
});

test("editLoop --dry-run reflects the reopen stamp-clear in the preview", () => {
  const { token } = seededMachine();
  const created = gateway().createLoop(token, { name: "E", cron: "0 8 * * *", taskFile: "x", goal: "g" });
  const id = (created.body as any).id as string;
  store.updateLoop(id, { completedAt: "2026-07-01T00:00:00Z", completionReason: "met", enabled: false });
  const res = gateway().editLoop(token, id, { enabled: true }, true);
  const keys = ((res.body as any).changes as Array<{ key: string }>).map((c) => c.key);
  expect(keys).toContain("enabled");
  expect(keys).toContain("completedAt");
  expect(keys).toContain("completionReason");
  // Dry-run persisted nothing → the loop is still completed.
  expect(store.getLoop(id)!.completedAt).toBe("2026-07-01T00:00:00Z");
});

// ---- self-schedule cadence floors (RUN path only; the owner's edit path is unlimited) ----

test("set-cron floor: a run can't schedule more often than 15 min; the owner's edit can", () => {
  const { loop, machine, run } = seededLoop();
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // Every 5 minutes is under the 15-min self floor → rejected, cron unchanged.
  const denied = gateway().agentApi(rt, ["set-cron", "*/5 * * * *"]);
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/15 min/);
  expect(store.getLoop(loop.id)!.cron).toBe("0 0 1 1 *");

  // Every 20 minutes clears the floor.
  expect(gateway().agentApi(rt, ["set-cron", "*/20 * * * *"]).status).toBe(200);
  expect(store.getLoop(loop.id)!.cron).toBe("*/20 * * * *");

  // The OWNER's editLoop path is unlimited — the same dense cron is accepted.
  const deviceToken = tokens.mintDeviceToken();
  const dm = tokens.machineIdFromToken(deviceToken);
  store.createMachine({ id: dm, userId: "u2", name: "D", tokenHash: tokens.sha256(deviceToken), online: true });
  const owned = gateway().createLoop(deviceToken, { name: "Owned", cron: "0 8 * * *", taskFile: "loopany/x/README.md" });
  const oid = (owned.body as any).id as string;
  expect(gateway().editLoop(deviceToken, oid, { cron: "*/5 * * * *" }).status).toBe(200);
  expect(store.getLoop(oid)!.cron).toBe("*/5 * * * *");
});

test("set-cron floor is timezone-aware (probes adjacent fires in the loop's tz)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", timezone: "Asia/Tokyo", enabled: true, notify: "auto" });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: true });

  // A daily cron (adjacent fires 24h apart, well over the floor) is accepted.
  expect(gateway().agentApi(rt, ["set-cron", "0 9 * * *"]).status).toBe(200);
  // A 2-minute cron is under the floor → rejected.
  expect(gateway().agentApi(rt, ["set-cron", "*/2 * * * *"]).status).toBe(400);
});

test("reschedule floor: a run can't reschedule sooner than 5 min out", () => {
  const { loop, machine, run } = seededLoop();
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId: machine.id, role: "exec", allowControl: true });

  // 2 minutes out is under the 5-min floor → rejected, nextRunAt unchanged.
  const denied = gateway().agentApi(rt, ["reschedule", "--next", "2m"]);
  expect(denied.status).toBe(400);
  expect((denied.body as { text: string }).text).toMatch(/5 min/);
  expect(store.getLoop(loop.id)!.nextRunAt).toBeNull();

  // 30 minutes out clears the floor.
  expect(gateway().agentApi(rt, ["reschedule", "--next", "30m"]).status).toBe(200);
  expect(store.getLoop(loop.id)!.nextRunAt).toBeTruthy();
});

test("show reports the goal line and self-finish gating for a run", () => {
  const { loop, rt } = seededClosedRun();
  const text = (gateway().agentApi(rt, ["show"]).body as { text: string }).text;
  expect(text).toContain("goal: reach the goal");
  expect(text).toContain("self-finish: allowed");
  expect(loop.goal).toBe("reach the goal");
});

// ---- failure visibility / alerting (notify on run failure + machine-offline) ----

/** Add a finalized exec run with an explicit ts (deterministic streak ordering). */
function addExecRun(loopId: string, machineId: string, phase: "done" | "error", ts: string) {
  return store.addRun({ loopId, userId: "u1", machineId, phase, role: "exec", ts });
}

test("a FAILED exec run notifies the user (first failure of a streak)", () => {
  const { loop, rt } = seededExecRun();
  const { sent, fn } = recordingNotify();

  const res = gateway(fn).report(rt, { ok: false, error: "claude exited 1", durationMs: 5 });
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toContain("Run failed");
  expect(sent[0]!.message).toContain("claude exited 1");
});

test("a SUCCESSFUL exec run still notifies as before (unchanged success path)", () => {
  const { loop, rt } = seededExecRun();
  const { sent, fn } = recordingNotify();

  const res = gateway(fn).report(rt, { ok: true, message: "Breakfast report ready", durationMs: 5 });
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toBe("Breakfast report ready");
});

test("repeated consecutive failures are anti-spam'd: notify on the 1st and every Nth, not every tick", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // 12 consecutive failing runs. With FAILURE_NOTIFY_EVERY === 5, the user is
  // alerted on streaks 1, 5, 10 → exactly 3 pushes (not 12).
  for (let i = 1; i <= 12; i++) {
    const run = addExecRun(loop.id, machineId, "error", `2026-06-01T00:00:${String(i).padStart(2, "0")}Z`).id;
    // The run row is already error; drive report on a token for it to exercise the path.
    const rt = tokens.registerRunToken({ runId: run, loopId: loop.id, machineId, role: "exec", allowControl: false });
    gw.report(rt, { ok: false, error: "boom", durationMs: 1 });
  }
  expect(sent).toHaveLength(3);
});

test("a success between failures resets the streak so the next failure re-alerts (transition)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const { sent, fn } = recordingNotify();

  // Prior history: a failure, then a success (the streak is broken at the success).
  addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:01Z");
  addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:02Z");

  // Now a fresh failure → streak is 1 again → it must re-alert.
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: "2026-06-01T00:00:03Z" });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
  gateway(fn).report(rt, { ok: false, error: "boom", durationMs: 1 });

  expect(sent).toHaveLength(1);
});

test("evolve and edit run failures never produce user-facing failure notifications", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "always" });
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  for (const role of ["evolve", "edit"] as const) {
    const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role, ts: new Date().toISOString() });
    const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role, allowControl: true });
    gw.report(rt, { ok: false, error: "boom", durationMs: 1 });
  }
  expect(sent).toHaveLength(0);
});

test("notify: 'never' suppresses failure alerts entirely", () => {
  const { rt } = seededExecRun("never");
  const { sent, fn } = recordingNotify();
  gateway(fn).report(rt, { ok: false, error: "boom", durationMs: 1 });
  expect(sent).toHaveLength(0);
});

test("sweep surfaces a machine-offline pending run once (anti-spam'd while it stays offline)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // Machine offline + last seen long ago.
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: false, lastSeen: "2000-01-01T00:00:00Z" });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const { sent, fn } = recordingNotify();
  const gw = gateway(fn);

  // Two stale pending exec runs (older than the 60s grace) — both reclaim as
  // "machine offline". The first is streak 1 (alert); the second is streak 2 (silent).
  store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: "2026-06-01T00:00:01Z" });
  gw.sweep();
  store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "pending", role: "exec", ts: "2026-06-01T00:00:02Z" });
  gw.sweep();

  expect(sent).toHaveLength(1);
  expect(sent[0]!.loopId).toBe(loop.id);
  expect(sent[0]!.message).toMatch(/offline/i);
});

test("execFailureStreak counts only consecutive trailing exec errors, ignoring evolve/canceled/open", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });

  addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:01Z");
  addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:02Z");
  addExecRun(loop.id, machineId, "error", "2026-06-01T00:00:03Z");
  // An interleaved evolve error must NOT count (internal role).
  store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "error", role: "evolve", ts: "2026-06-01T00:00:04Z" });
  expect(store.execFailureStreak(loop.id)).toBe(2);

  // A trailing success breaks the streak to 0.
  addExecRun(loop.id, machineId, "done", "2026-06-01T00:00:05Z");
  expect(store.execFailureStreak(loop.id)).toBe(0);
});

// ---- loopLog (device-token-scoped run-log read for `loopany log`) ----

/** A machine + a loop on it, with `count` exec runs (newest ts last). */
function seededLoopWithRuns(machineId: string, count: number) {
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h-" + machineId, online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  for (let i = 0; i < count; i++) {
    store.addRun({
      loopId: loop.id,
      userId: "u1",
      machineId,
      phase: i % 2 === 0 ? "done" : "error",
      role: "exec",
      ts: `2026-06-01T00:00:${String(i + 1).padStart(2, "0")}Z`,
      outcome: i % 2 === 0 ? "exec" : "error",
      sessionId: `sess-${i}`,
      ...(i % 2 === 0 ? { state: { mrr: 42 + i }, sample: i } : { error: `boom ${i}` }),
      transcript: [
        { kind: "text", text: `run ${i} thinking` },
        { kind: "tool", name: "Bash", input: `{"cmd":"echo ${i}"}` },
      ],
    });
  }
  return loop;
}

test("loopLog returns the loop's recent runs newest-first with transcript text", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  const loop = seededLoopWithRuns(machineId, 3);

  const res = gateway().loopLog(token, loop.id);
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
  // Each run also carries the metrics it reported (state object + single sample).
  expect(body.runs[0].state).toEqual({ mrr: 44 });
  expect(body.runs[0].sample).toBe(2);
  expect(body.runs.every((r) => "state" in r && "sample" in r)).toBe(true);
});

test("loopLog honors and caps the run limit", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  const loop = seededLoopWithRuns(machineId, 5);

  expect((gateway().loopLog(token, loop.id, 2).body as { runs: any[] }).runs).toHaveLength(2);
  // Limit is clamped to the max (20), so a huge value just returns everything.
  expect((gateway().loopLog(token, loop.id, 9999).body as { runs: any[] }).runs).toHaveLength(5);
  // A non-positive / garbage limit falls back to the default (≥ all 5 here).
  expect((gateway().loopLog(token, loop.id, -1).body as { runs: any[] }).runs).toHaveLength(5);
});

test("loopLog truncates an over-cap transcript and flags it", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h", online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  store.addRun({
    loopId: loop.id,
    userId: "u1",
    machineId,
    phase: "done",
    role: "exec",
    ts: "2026-06-01T00:00:01Z",
    transcript: [{ kind: "text", text: "x".repeat(20_000) }],
  });
  const run = (gateway().loopLog(token, loop.id).body as { runs: any[] }).runs[0];
  expect(run.transcriptTruncated).toBe(true);
  expect(run.transcript.length).toBeLessThan(20_000);
});

test("loopLog refuses a token whose machine does not own the loop (cross-device)", () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  const loop = seededLoopWithRuns(machineA, 2);

  // A different device with its own token cannot read machine A's loop's runs.
  const tokenB = tokens.mintDeviceToken();
  const machineB = tokens.machineIdFromToken(tokenB);
  store.createMachine({ id: machineB, userId: "u2", name: "MB", tokenHash: "hb", online: true });
  const res = gateway().loopLog(tokenB, loop.id);
  expect(res.status).toBe(404);
});

test("loopLog rejects an unknown loop id and an unregistered token", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: "h", online: true });
  // Loop that doesn't exist → 404 (existence never leaks).
  expect(gateway().loopLog(token, "loop-nope").status).toBe(404);
  // Missing loop id → 400.
  expect(gateway().loopLog(token, "").status).toBe(400);
  // Token for a machine that was never registered → 401.
  expect(gateway().loopLog(tokens.mintDeviceToken(), "loop-x").status).toBe(401);
});

// ---- run-lifecycle hardening: canceled ordering, sweep inactivity/revocation ----

test("a late report for a CANCELED run never advances the loop (cursor + task file untouched)", () => {
  const { loop, run, rt } = seededExecRun();
  store.updateRun(run.id, { phase: "canceled", error: "stopped by user" });

  const res = gateway().report(rt, {
    ok: true,
    durationMs: 5,
    cursor: { seenIds: [1, 2, 3] },
    taskFileContent: "# advanced past what the user saw",
  });
  expect(res.status).toBe(200);
  // The workflow cursor was NOT advanced and the task file NOT synced — the next
  // run must re-process the data whose output the user never saw.
  const stored = store.getLoop(loop.id)!;
  expect(stored.state).toBeNull();
  expect(stored.taskFileContent).toBeNull();
  expect(store.getRun(run.id)!.phase).toBe("canceled");
  // The token died with the report.
  expect(gateway().agentApi(rt, ["show"]).status).toBe(401);
});

test("a canceled EVOLVE run's report clears the evolve marker (finishEvolution), symmetric to edit", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto", evolveDue: true });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "canceled", role: "evolve", ts: new Date().toISOString() });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "evolve", allowControl: true });

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

  expect(gw.report(rt, { ok: true, durationMs: 5 }).status).toBe(200);
  // Without this, evolveDue stays set and the canceled evolve re-fires next tick.
  expect(finished).toBe(loop.id);
});

test("sweep marks a reclaimed run's token reclaimed: agent-api mutations are refused (409), but the token survives for one wake-report", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  // Claimed 30min ago, no progress heard since → past the 20min inactivity window.
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs });
  const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });

  const gw = gateway();
  expect(gw.agentApi(rt, ["show"]).status).toBe(200); // live before the sweep
  gw.sweep();
  expect(store.getRun(run.id)!.phase).toBe("error");
  expect(store.getRun(run.id)!.error).toBe("machine timed out / disconnected");
  // The orphaned agent can no longer MUTATE the loop (reclaimed → 409, not silent),
  // but the token is not revoked outright: it survives to accept one wake-report.
  expect(gw.agentApi(rt, ["show"]).status).toBe(409);
  expect(tokens.resolveRunToken(rt)).toBeTruthy();
});

test("sweep is INACTIVITY-based: a >20min run with a fresh progress heartbeat is NOT reclaimed", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "never" });
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString();
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: staleTs });

  const gw = gateway();
  // The daemon's heartbeat just refreshed the progress stamp → healthy long run.
  gw.poll(token, undefined, [{ runId: run.id, step: 7, label: "still working" }]);
  gw.sweep();
  expect(store.getRun(run.id)!.phase).toBe("running"); // never falsely failed

  // Once the stamp itself goes stale (nothing heard for the full window) → reclaimed.
  store.updateRun(run.id, { progress: { step: 7, label: "still working", at: staleTs } as { step: number; label: string } });
  gw.sweep();
  expect(store.getRun(run.id)!.phase).toBe("error");
  expect(store.getRun(run.id)!.error).toBe("machine timed out / disconnected");
});

test("execFailureStreak is exact past any cap, so the every-Nth reminder keeps firing", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });

  // A success, then 70 consecutive failures — beyond the old capped scan (64),
  // which pinned the streak at 64 and silenced reminders forever.
  addExecRun(loop.id, machineId, "done", "2026-05-31T23:59:59Z");
  for (let i = 1; i <= 70; i++) {
    const mm = String(Math.floor(i / 60)).padStart(2, "0");
    const ss = String(i % 60).padStart(2, "0");
    addExecRun(loop.id, machineId, "error", `2026-06-01T00:${mm}:${ss}Z`);
  }
  expect(store.execFailureStreak(loop.id)).toBe(70);
  // 70 % FAILURE_NOTIFY_EVERY(5) === 0 → the "still broken" reminder fires.
  expect(notifyMod.shouldNotifyFailure("auto", 70)).toBe(true);
});

test("show computes `next` in the loop's timezone", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const gw = gateway();
  const showNext = (timezone: string) => {
    const loop = store.createLoop({ userId: "u1", machineId, name: `L-${timezone}`, cron: "0 8 * * *", timezone, enabled: true, notify: "auto" });
    const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });
    const rt = tokens.registerRunToken({ runId: run.id, loopId: loop.id, machineId, role: "exec", allowControl: false });
    return (gw.agentApi(rt, ["show"]).body as { text: string }).text.split("\n")[0]!;
  };
  // Same cron, timezones 25h apart — honoring the loop tz must yield different
  // next-fire instants (the old tz-less probe rendered both in server time).
  expect(showNext("Pacific/Kiritimati")).not.toBe(showNext("Pacific/Niue"));
});

// ---- wire-input bounds ----

test("poll processes at most 32 progress entries (excess is dropped)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const loop = store.createLoop({ userId: "u1", machineId, name: "L", cron: "0 0 1 1 *", enabled: true, notify: "auto" });
  const run = store.addRun({ loopId: loop.id, userId: "u1", machineId, phase: "running", role: "exec", ts: new Date().toISOString() });

  // 32 junk entries pad the front; the real run's entry sits past the cap.
  const junk = Array.from({ length: 32 }, (_, i) => ({ runId: `nope-${i}`, step: 1, label: "x" }));
  gateway().poll(token, undefined, [...junk, { runId: run.id, step: 5, label: "past the cap" }]);
  expect(store.getRun(run.id)!.progress).toBeNull();

  // Within the cap it lands normally.
  gateway().poll(token, undefined, [{ runId: run.id, step: 5, label: "in the cap" }]);
  expect(store.getRun(run.id)!.progress).toMatchObject({ step: 5, label: "in the cap" });
});

test("createLoop clips an oversized workflow to the 512KB wire cap", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  const res = gateway().createLoop(token, { name: "Big", cron: "0 8 * * *", workflow: "x".repeat(512 * 1024 + 100) });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.workflow!.length).toBe(512 * 1024);
});

test("report ignores an over-cap workflow cursor but still finalizes the run", () => {
  const { loop, run, rt } = seededExecRun();
  const res = gateway().report(rt, { ok: true, durationMs: 5, cursor: { blob: "y".repeat(300 * 1024) } });
  expect(res.status).toBe(200);
  expect(store.getRun(run.id)!.phase).toBe("done"); // the run still records
  expect(store.getLoop(loop.id)!.state).toBeNull(); // the runaway cursor does not

  // A sane cursor persists as before.
  const again = seededExecRun();
  gateway().report(again.rt, { ok: true, durationMs: 5, cursor: { seen: 3 } });
  expect(store.getLoop(again.loop.id)!.state).toEqual({ seen: 3 });
});

test("report whitelists the claimed outcome (unknown values fall back to the role default)", () => {
  const bogus = seededExecRun();
  gateway().report(bogus.rt, { ok: true, durationMs: 5, outcome: "hijack" as any });
  expect(store.getRun(bogus.run.id)!.outcome).toBe("exec"); // role default, not "hijack"

  const direct = seededExecRun();
  gateway().report(direct.rt, { ok: true, durationMs: 5, outcome: "direct" });
  expect(store.getRun(direct.run.id)!.outcome).toBe("direct"); // known value passes
});

test("agent-api report clips --message to the 2000-char cap", () => {
  const { run, rt } = seededExecRun();
  const res = gateway().agentApi(rt, ["report", "--message", "m".repeat(5000)]);
  expect(res.status).toBe(200);
  expect(store.getRun(run.id)!.message!.length).toBe(2000);
});

test("report clips sessionId and error (untrusted wire input, same discipline as message)", () => {
  const { run, rt } = seededExecRun();
  const res = gateway().report(rt, {
    ok: false,
    durationMs: 1,
    sessionId: "s".repeat(500),
    error: "e".repeat(5000),
  });
  expect(res.status).toBe(200);
  const stored = store.getRun(run.id)!;
  expect(stored.sessionId!.length).toBe(200); // SESSION_ID_CAP
  expect(stored.error!.length).toBe(2000); // MESSAGE_CAP
  // A non-string error degrades to the server's default reason.
  const again = seededExecRun();
  gateway().report(again.rt, { ok: false, durationMs: 1, error: 42 as never });
  expect(store.getRun(again.run.id)!.error).toBe("run failed on machine");
});

test("poll persists the daemon version, updating only when it changes", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  // First poll self-registers and records the reported version.
  gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64", version: "0.8.0" });
  expect(store.getMachine(machineId)!.daemonVersion).toBe("0.8.0");
  // A newer version on the next poll updates it.
  gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64", version: "0.9.0" });
  expect(store.getMachine(machineId)!.daemonVersion).toBe("0.9.0");
  // A poll with no version leaves it as-is (older daemons don't report it).
  gateway().poll(token, { host: "mac", platform: "darwin", arch: "arm64" });
  expect(store.getMachine(machineId)!.daemonVersion).toBe("0.9.0");
  // An over-long version is clipped defensively (untrusted wire input).
  gateway().poll(token, { host: "mac", version: "9".repeat(200) });
  expect(store.getMachine(machineId)!.daemonVersion!.length).toBe(64);
});
