/**
 * The executor registry — poll-time agent registration, the `team` verb (roster +
 * rename), and agent-slug executor assignment. Bootstrap mirrors events.test.ts
 * (pglite, temp dir, async store imports).
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-agents-"));
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
    "DELETE FROM agents; DELETE FROM events; DELETE FROM run_leases; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
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

async function seedMachine(userId = "u1", name = "Studio") {
  const token = tokens.mintDeviceToken();
  const machineId = tokens.machineIdFromToken(token);
  await store.createMachine({ id: machineId, userId, name, tokenHash: tokens.sha256(token), online: true, lastSeen: new Date().toISOString() });
  return { token, machineId };
}

test("poll registers reported runtimes as agents; unknown values dropped; rename survives re-poll", async () => {
  const { token, machineId } = await seedMachine();
  const { core } = cli();

  await core.poll(token, { version: "test", agents: ["claude-code", "codex", "emacs", "claude-code"] });
  const rows = await store.agentsForMachines([machineId]);
  expect(rows.map((a) => a.runtime).sort()).toEqual(["claude-code", "codex"]);
  const claude = rows.find((a) => a.runtime === "claude-code")!;
  expect(claude.id).toBe(`${machineId}:claude-code`);
  expect(claude.slug).toBe("claude-studio");

  // A rename is durable: registration is insert-only, never a name clobber.
  await store.renameAgent(claude.id, "Design Mac");
  await core.poll(token, { version: "test", agents: ["claude-code", "codex"] });
  const after = await store.agentsForMachines([machineId]);
  expect(after.find((a) => a.runtime === "claude-code")!.name).toBe("Design Mac");
  expect(after).toHaveLength(2);
});

test("team lists the roster with presence; rename relabels; unknown flag fails loud", async () => {
  const { token, machineId } = await seedMachine();
  const { core, cli: c } = cli();
  await core.poll(token, { version: "test", agents: ["claude-code"] });

  const r = await c.cli(token, ["team"]);
  expect(r.status).toBe(200);
  const text = (r.body as { text: string }).text;
  expect(text).toContain("agents[1]{agent,name,runtime,machine,presence}");
  expect(text).toContain("claude-studio");
  expect(text).toContain("online");

  const renamed = await c.cli(token, ["team", "rename", "claude-studio", "Design", "Mac"]);
  expect(renamed.status).toBe(200);
  expect((renamed.body as { text: string }).text).toContain("Design Mac");
  expect((await store.agentsForMachines([machineId]))[0]!.name).toBe("Design Mac");

  const bad = await c.cli(token, ["team", "--verbose"]);
  expect(bad.status).toBe(400);
  expect((bad.body as { exitCode: number }).exitCode).toBe(2);

  // --json emits the parseable roster.
  const j = await c.cli(token, ["team", "--json"]);
  const parsed = JSON.parse((j.body as { text: string }).text) as { agents: Array<{ agent: string }> };
  expect(parsed.agents[0]!.agent).toBe("claude-studio");
});

test("assignee=<agent-slug> resolves through the registry; a stranger's agent never resolves", async () => {
  const owner = await seedMachine("u1", "Studio");
  const second = await seedMachine("u1", "Laptop");
  const { core, cli: c } = cli();
  await core.poll(owner.token, { version: "test", agents: ["claude-code"] });
  await core.poll(second.token, { version: "test", agents: ["codex"] });

  const task = await store.createLoop({
    userId: "u1", machineId: owner.machineId, teamId: null, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/exp-x/README.md", taskFileContent: "---\nid: exp-x\ntitle: T\nstatus: idea\n---\n\n## Spec\nx\n",
  });

  // Slug form re-binds machine + runtime in one ref.
  const r = await core.editLoop(owner.token, task.id, { assignee: "codex-laptop" });
  expect(r.status).toBe(200);
  const updated = (await store.getLoop(task.id))!;
  expect(updated.machineId).toBe(second.machineId);
  expect(updated.agent).toBe("codex");

  // The legacy <machine>/<runtime> form still works as an alias (issued from the
  // task's current host — the edit surface stays machine-scoped for writes).
  const back = await core.editLoop(second.token, task.id, { assignee: "Studio/claude-code" });
  expect(back.status).toBe(200);
  expect((await store.getLoop(task.id))!.machineId).toBe(owner.machineId);

  // A teammate's agent is invisible: same flat rejection as an unknown ref.
  const stranger = await seedMachine("u2", "Intruder");
  await core.poll(stranger.token, { version: "test", agents: ["grok"] });
  const foreign = await core.editLoop(owner.token, task.id, { assignee: "grok-intruder" });
  expect(foreign.status).toBe(400);
  expect((foreign.body as { error: string }).error).toContain("no such agent of yours");
  void c;
});

test("ambiguous agent ref 409s with candidates instead of guessing", async () => {
  const a = await seedMachine("u1", "Same Name");
  const b = await seedMachine("u1", "Same Name");
  const { core } = cli();
  await core.poll(a.token, { version: "test", agents: ["claude-code"] });
  await core.poll(b.token, { version: "test", agents: ["claude-code"] });

  const task = await store.createLoop({
    userId: "u1", machineId: a.machineId, teamId: null, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/exp-y/README.md", taskFileContent: "---\nid: exp-y\ntitle: T\n---\n\n## Spec\nx\n",
  });
  const r = await core.editLoop(a.token, task.id, { assignee: "claude-same-name" });
  expect(r.status).toBe(409);
  const body = r.body as { candidates: Array<{ id: string }> };
  expect(body.candidates).toHaveLength(2);
});

// ---- combined update: fields first, then the assignee op against the NEW state ----

test("update {status:todo}+assignee in ONE call: fields apply, THEN the op sees todo and dispatches", async () => {
  const owner = await seedMachine("u1", "Studio");
  const { core } = cli();
  const dispatched: string[] = [];
  (core as never as { scheduler: { runNow(id: string): void } }).scheduler.runNow = (id: string) => void dispatched.push(id);
  await core.poll(owner.token, { version: "test", agents: ["claude-code"] });

  const doc = "---\nid: combo-t\ntitle: T\nstatus: idea\n---\n\n## Spec\nx\n";
  const task = await store.createLoop({
    userId: "u1", machineId: owner.machineId, teamId: null, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/combo-t/README.md", taskFileContent: doc,
  });

  const r = await core.editLoop(owner.token, task.id, {
    taskFileContent: doc.replace("status: idea", "status: todo"),
    assignee: "claude-studio",
  });
  expect(r.status).toBe(200);
  const body = r.body as { applied: string[]; dispatched?: boolean; text: string };
  expect(body.applied).toContain("assignee");
  expect(body.dispatched).toBe(true);
  expect(dispatched).toEqual([task.id]); // the op ran against the NEW (todo) state
  expect((await store.getLoop(task.id))!.taskMeta?.status).toBe("todo");
});

test("combined update partial failure: fields STAND, error names the failed part", async () => {
  const owner = await seedMachine("u1", "Studio");
  const { core } = cli();
  const doc = "---\nid: combo-f\ntitle: T\nstatus: idea\n---\n\n## Spec\nx\n";
  const task = await store.createLoop({
    userId: "u1", machineId: owner.machineId, teamId: null, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/combo-f/README.md", taskFileContent: doc,
  });

  const r = await core.editLoop(owner.token, task.id, {
    taskFileContent: doc.replace("status: idea", "status: todo"),
    assignee: "no-such-agent-anywhere",
  });
  expect(r.status).toBe(400);
  const err = (r.body as { error: string }).error;
  expect(err).toContain("applied");
  expect(err).toContain("assignee failed");
  // The field write survived the failed op.
  expect((await store.getLoop(task.id))!.taskMeta?.status).toBe("todo");
});

test("bare status→todo update never dispatches but returns the teaching hint", async () => {
  const owner = await seedMachine("u1", "Studio");
  const { core } = cli();
  const dispatched: string[] = [];
  (core as never as { scheduler: { runNow(id: string): void } }).scheduler.runNow = (id: string) => void dispatched.push(id);
  const doc = "---\nid: hint-t\ntitle: T\nstatus: idea\n---\n\n## Spec\nx\n";
  const task = await store.createLoop({
    userId: "u1", machineId: owner.machineId, teamId: null, cron: null, enabled: true, notify: "auto",
    taskFile: "/h/loopany/hint-t/README.md", taskFileContent: doc,
  });

  const r = await core.editLoop(owner.token, task.id, { taskFileContent: doc.replace("status: idea", "status: todo") });
  expect(r.status).toBe(200);
  const body = r.body as { hint?: string; text: string };
  expect(body.hint).toContain("status alone never dispatches");
  expect(body.text).toContain("hint:");
  expect(dispatched).toEqual([]); // bookkeeping, never a trigger

  // A todo→todo no-change edit does NOT re-hint.
  const again = await core.editLoop(owner.token, task.id, {
    taskFileContent: doc.replace("status: idea", "status: todo").replace("title: T", "title: T2"),
  });
  expect((again.body as { hint?: string }).hint).toBeUndefined();
});
