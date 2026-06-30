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
  // Must be set BEFORE importing the gateway (which loads superadmin.ts, read once
  // at module load) so the cross-team superadmin-authorization test below works.
  process.env.LOOPANY_SUPERADMINS = "admin@example.com";
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

  const res = gateway().createLoop(deviceToken, { name: "B loop", cron: "0 8 * * *", task: "x", claim: connectKey });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-reuse");
});

test("createLoop rejects (403) a claim minted by a different user — fail closed, nothing created", () => {
  makeTeam("team-x", ["u2"]);
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "u2", teamId: "team-x" }); // minted by someone else

  const res = gateway().createLoop(token, { cron: "0 8 * * *", task: "x", claim: token });
  expect(res.status).toBe(403);
  expect(store.listLoops().length).toBe(0); // never mis-filed
});

test("createLoop rejects (403) when the minter is no longer a member of the claim team", () => {
  makeTeam("team-y", []); // team exists, u1 is NOT a member (and not an admin)
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-u1", name: "M", tokenHash: tokens.sha256(token), online: true });
  tokens.rememberClaimIntent(token, { userId: "u1", teamId: "team-y" });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", task: "x", claim: token });
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

  const res = gateway().createLoop(token, { cron: "0 8 * * *", task: "x", claim: token });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-admin");
});

test("createLoop with no claim falls back to the machine's home team (back-compat)", () => {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  store.createMachine({ id: machineId, userId: "u1", teamId: "team-home", name: "M", tokenHash: tokens.sha256(token), online: true });

  const res = gateway().createLoop(token, { cron: "0 8 * * *", task: "x" });
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

  const res = gateway().createLoop(token, { cron: "0 8 * * *", task: "x", claim: token });
  expect(res.status).toBe(200);
  expect(store.getLoop((res.body as any).id)!.teamId).toBe("team-shared");
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
