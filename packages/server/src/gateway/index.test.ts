import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let gatewayMod: typeof import("./index.js");
let tokens: typeof import("./tokens.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-gateway-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  db.runMigrations();
  store = await import("../db/store.js");
  gatewayMod = await import("./index.js");
  tokens = await import("./tokens.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.sqlite.exec("DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;");
});

function gateway(): InstanceType<typeof gatewayMod.MachineGateway> {
  return new gatewayMod.MachineGateway({
    maybeFlagEvolve(): void {},
    finishEvolution(): void {},
    finishEdit(): void {},
    addLoop(): void {},
    removeLoop(): void {},
    runNow(): void {},
  } as any);
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
    task: "do the thing",
  });
  expect(ok.status).toBe(200);
  expect(store.getLoop((ok.body as any).id)!.timezone).toBe("Asia/Shanghai");

  const bad = gateway().createLoop(token, {
    name: "Bad tz",
    cron: "0 8 * * *",
    timezone: "Mars/Phobos",
    task: "do the thing",
  });
  expect(bad.status).toBe(400);
  expect((bad.body as any).error).toMatch(/invalid timezone/);
});

test("createLoop records the coding agent: codex when declared, claude-code by default, and degrades an unknown value", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });

  // Explicit codex (the dialog pick / --agent codex) is persisted verbatim.
  const codex = gateway().createLoop(token, { name: "Codex loop", cron: "0 8 * * *", task: "x", agent: "codex" });
  expect(codex.status).toBe(200);
  expect(store.getLoop((codex.body as any).id)!.agent).toBe("codex");

  // Absent agent (older daemon) back-fills to claude-code via the column default.
  const legacy = gateway().createLoop(token, { name: "Legacy loop", cron: "0 8 * * *", task: "x" });
  expect(legacy.status).toBe(200);
  expect(store.getLoop((legacy.body as any).id)!.agent).toBe("claude-code");

  // An unrecognized / "unknown" value degrades to the default rather than rejecting.
  const weird = gateway().createLoop(token, { name: "Weird loop", cron: "0 8 * * *", task: "x", agent: "unknown" });
  expect(weird.status).toBe(200);
  expect(store.getLoop((weird.body as any).id)!.agent).toBe("claude-code");
});

test("editLoop changes a loop's envelope from its machine's device token", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  const created = gateway().createLoop(token, { name: "Daily", cron: "0 8 * * *", task: "x" });
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

test("editLoop refuses a loop bound to a different machine (404, no change)", () => {
  const tokenA = tokens.mintDeviceToken();
  const machineA = tokens.machineIdFromToken(tokenA);
  store.createMachine({ id: machineA, userId: "u1", name: "A", tokenHash: tokens.sha256(tokenA), online: true });
  const created = gateway().createLoop(tokenA, { name: "Owned", cron: "0 8 * * *", task: "x" });
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
  expect(store.getRun(run.id)!.progress).toEqual({ step: 3, label: "Editing report.md" });

  // A different machine can't write progress onto a run it doesn't own.
  const other = tokens.mintDeviceToken();
  gateway().poll(other, undefined, [{ runId: run.id, step: 9, label: "hijack" }]);
  expect(store.getRun(run.id)!.progress).toEqual({ step: 3, label: "Editing report.md" });

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
