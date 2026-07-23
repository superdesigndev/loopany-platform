import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { todoDecision, todoTitle, type RunLike } from "./todo.js";

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let todo: typeof import("./todo.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-todo-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  todo = await import("./todo.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await (db.client as any).exec(
    "DELETE FROM todo_items; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

const runLike = (over: Partial<RunLike>): RunLike => ({
  role: "exec",
  phase: "done",
  outcome: "exec",
  status: null,
  message: null,
  error: null,
  ...over,
});

describe("todoDecision (the ingestion rule)", () => {
  test("a successful ok/new run creates an item", () => {
    expect(todoDecision(runLike({ phase: "done", outcome: "exec", status: "new" }))).toBe(true);
  });

  test("a successful run with no status still creates an item", () => {
    expect(todoDecision(runLike({ phase: "done", outcome: "exec", status: null }))).toBe(true);
  });

  test("a resolved (closed-loop finish) run creates an item", () => {
    expect(todoDecision(runLike({ phase: "done", outcome: "exec", status: "resolved" }))).toBe(true);
  });

  test("an evolve run creates an item", () => {
    expect(todoDecision(runLike({ role: "evolve", phase: "done", outcome: "evolve" }))).toBe(true);
  });

  test("a failure creates an item", () => {
    expect(todoDecision(runLike({ phase: "error", outcome: "error", error: "boom" }))).toBe(true);
  });

  test("an ok/nothing-new run does NOT create an item", () => {
    expect(todoDecision(runLike({ phase: "done", outcome: "exec", status: "nothing-new" }))).toBe(false);
  });

  test("a silent workflow pass does NOT create an item", () => {
    expect(todoDecision(runLike({ phase: "done", outcome: "silent" }))).toBe(false);
  });

  test("an edit run never creates an item", () => {
    expect(todoDecision(runLike({ role: "edit", phase: "done", outcome: "exec", status: "new" }))).toBe(false);
  });

  test("a canceled run never creates an item", () => {
    expect(todoDecision(runLike({ phase: "canceled" }))).toBe(false);
  });

  test("a skipped (deferred) run never creates an item", () => {
    expect(todoDecision(runLike({ phase: "canceled", outcome: "skipped" }))).toBe(false);
  });

  test("a still-running run creates no item yet", () => {
    expect(todoDecision(runLike({ phase: "running", outcome: null }))).toBe(false);
  });
});

describe("todoTitle (derivation)", () => {
  test("uses the message's first non-empty line, stripping a heading marker", () => {
    expect(todoTitle(runLike({ message: "# Daily report\n\nbody" }), "Weather")).toBe("Daily report");
  });

  test("a failure uses its error", () => {
    expect(todoTitle(runLike({ phase: "error", error: "connection refused" }), "Watcher")).toBe("connection refused");
  });

  test("falls back to a calm label when there is no message", () => {
    expect(todoTitle(runLike({ message: null }), "Cookie report")).toBe("Cookie report — new result");
    expect(todoTitle(runLike({ role: "evolve", message: null }), "X")).toBe("X — self-improvement pass");
    expect(todoTitle(runLike({ phase: "error", error: null }), "X")).toBe("X — run failed");
  });

  test("clips a very long title", () => {
    const long = "z".repeat(400);
    const t = todoTitle(runLike({ message: long }), "L");
    expect(t.length).toBeLessThanOrEqual(140);
    expect(t.endsWith("…")).toBe(true);
  });
});

async function seedMachine(id = "m1") {
  await store.createMachine({ id, userId: "u1", teamId: "team-a", name: "Laptop", tokenHash: "h", token: "dk_x" } as any);
}

async function seedLoop(id = "loop1", over: Record<string, unknown> = {}) {
  await seedMachine((over.machineId as string) ?? "m1");
  return store.createLoop({
    id,
    userId: "u1",
    teamId: "team-a",
    machineId: "m1",
    name: "My Loop",
    cron: "0 9 * * *",
    ...over,
  } as any);
}

async function seedRun(id: string, over: Record<string, unknown> = {}) {
  return store.addRun({
    id,
    loopId: "loop1",
    userId: "u1",
    machineId: "m1",
    phase: "done",
    role: "exec",
    outcome: "exec",
    status: "new",
    message: `result ${id}`,
    ts: new Date().toISOString(),
    ...over,
  } as any);
}

describe("ingestRunTodo (idempotent, preserves user edits)", () => {
  test("creates one item per run, keyed by runId", async () => {
    const loop = await seedLoop();
    const run = await seedRun("r1");
    const created = await todo.ingestRunTodo(run, loop);
    expect(created).toBeTruthy();
    expect(created!.title).toBe("result r1");
    expect(created!.teamId).toBe("team-a");
    expect(created!.status).toBe("new");

    // Re-ingest (a re-report) → the SAME row, no duplicate.
    await todo.ingestRunTodo(run, loop);
    const items = await store.listTeamTodos("team-a");
    expect(items).toHaveLength(1);
  });

  test("a nothing-new run is not ingested", async () => {
    const loop = await seedLoop();
    const run = await seedRun("r2", { status: "nothing-new" });
    expect(await todo.ingestRunTodo(run, loop)).toBeNull();
    expect(await store.listTeamTodos("team-a")).toHaveLength(0);
  });

  test("a re-ingest refreshes the run-derived title but PRESERVES the user's edits", async () => {
    const loop = await seedLoop();
    const run = await seedRun("r3", { message: "first" });
    const item = await todo.ingestRunTodo(run, loop);
    // The user marks it in-progress, high priority, and archives it.
    await store.updateTodoItem(item!.id, { status: "in_progress", priority: "high", archived: true });

    // A reconcile re-ingests the run with a corrected message.
    const corrected = (await store.updateRun("r3", { message: "corrected" }))!;
    await todo.ingestRunTodo(corrected, loop);

    const after = await store.getTodoByRun("r3");
    expect(after!.title).toBe("corrected"); // run-derived: refreshed
    expect(after!.status).toBe("in_progress"); // user-owned: preserved
    expect(after!.priority).toBe("high");
    expect(after!.archived).toBe(true);
  });
});

describe("backfillTodos + seedTodosIfEmpty", () => {
  test("seeds recent qualifying runs and is idempotent", async () => {
    await seedLoop();
    await seedRun("b1", { status: "new" }); // qualifies
    await seedRun("b2", { status: "nothing-new" }); // skipped
    await seedRun("b3", { phase: "error", outcome: "error", error: "x", message: null }); // failure qualifies
    await seedRun("b4", { role: "edit", outcome: "exec" }); // edit: never

    const first = await todo.backfillTodos();
    expect(first).toBe(2);
    const items = await store.listTeamTodos("team-a");
    expect(items.map((i) => i.runId).sort()).toEqual(["b1", "b3"]);

    // A user edit survives a second backfill; no duplicates appear.
    const item = items.find((i) => i.runId === "b1")!;
    await store.updateTodoItem(item.id, { status: "done" });
    await todo.backfillTodos();
    expect(await store.listTeamTodos("team-a")).toHaveLength(2);
    expect((await store.getTodoByRun("b1"))!.status).toBe("done");
  });

  test("seedTodosIfEmpty only seeds when the list is empty", async () => {
    await seedLoop();
    await seedRun("s1", { status: "new" });
    expect(await todo.seedTodosIfEmpty()).toBe(1);
    // Now non-empty → a second call is a no-op even with a fresh qualifying run.
    await seedRun("s2", { status: "new" });
    expect(await todo.seedTodosIfEmpty()).toBe(0);
    expect(await store.listTeamTodos("team-a")).toHaveLength(1);
  });

  test("backfill excludes runs outside the window", async () => {
    await seedLoop();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await seedRun("old1", { status: "new", ts: old });
    await seedRun("new1", { status: "new" });
    expect(await todo.backfillTodos()).toBe(1);
    expect((await store.listTeamTodos("team-a")).map((i) => i.runId)).toEqual(["new1"]);
  });
});
