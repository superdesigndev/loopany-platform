import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { toTodoItemView } from "./adapters.js";
import type { TodoItemWithContext } from "../db/store.js";

/**
 * The To-Do API's data layer: the store queries `listTodos`/`patchTodo`/
 * `getTodoOutput` compose (join context, user-field update, HTML-artifact
 * selection) + the `toTodoItemView` adapter. The `createServerFn` wrappers are
 * thin (session resolve + these calls), so following the repo convention we
 * exercise the logic directly over a real pglite store.
 */

let tmp: string;
let db: typeof import("../db/index.js");
let store: typeof import("../db/store.js");
let todo: typeof import("./todo.js");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-todoapi-"));
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
    "DELETE FROM todo_items; DELETE FROM artifact_files; DELETE FROM blobs; DELETE FROM runs; DELETE FROM loops; DELETE FROM machines;",
  );
});

async function seed() {
  await store.createMachine({ id: "m1", userId: "u1", teamId: "team-a", name: "Laptop", tokenHash: "h", token: "dk_x" } as any);
  await store.createLoop({ id: "loop1", userId: "u1", teamId: "team-a", machineId: "m1", name: "Digest Loop", cron: "0 9 * * *" } as any);
  const run = await store.addRun({
    id: "run1",
    loopId: "loop1",
    userId: "u1",
    machineId: "m1",
    phase: "done",
    role: "exec",
    outcome: "exec",
    status: "new",
    message: "# Report\n\nBody here",
    ts: new Date().toISOString(),
  } as any);
  const item = await todo.ingestRunTodo(run, await store.getLoop("loop1"));
  return { run, item: item! };
}

test("listTeamTodos joins loop + machine context and toTodoItemView resolves labels", async () => {
  await seed();
  const rows = await store.listTeamTodos("team-a");
  expect(rows).toHaveLength(1);
  const view = toTodoItemView(rows[0]!);
  expect(view.loopName).toBe("Digest Loop");
  expect(view.machineName).toBe("Laptop");
  expect(view.title).toBe("Report");
  expect(view.assigneeLabel).toBeNull();
});

test("updateTodoItem writes ONLY the user-owned fields", async () => {
  const { item } = await seed();
  await store.updateTodoItem(item.id, { status: "in_progress", priority: "high", archived: true });
  const after = await store.getTodoItem(item.id);
  expect(after!.status).toBe("in_progress");
  expect(after!.priority).toBe("high");
  expect(after!.archived).toBe(true);
  // Run-derived fields untouched.
  expect(after!.title).toBe("Report");
  expect(after!.runId).toBe("run1");
});

test("open-mode listing (no team filter) returns every item", async () => {
  await seed();
  expect(await store.listTeamTodos(undefined)).toHaveLength(1);
});

test("htmlArtifactForRun returns the run's HTML artifact (getTodoOutput's artifact branch)", async () => {
  await seed();
  const ts = new Date().toISOString();
  // A live, byte-backed .html file whose lastRunId is this run.
  await (db.client as any).exec(
    `INSERT INTO artifact_files (id, loop_id, path, hash, size, "binary", oversize, deleted, updated_at, last_run_id)
     VALUES ('af1', 'loop1', 'report.html', 'hash1', 100, false, false, false, '${ts}', 'run1')`,
  );
  // A markdown file from the same run must NOT be picked as the HTML report.
  await (db.client as any).exec(
    `INSERT INTO artifact_files (id, loop_id, path, hash, size, "binary", oversize, deleted, updated_at, last_run_id)
     VALUES ('af2', 'loop1', 'notes.md', 'hash2', 50, false, false, false, '${ts}', 'run1')`,
  );
  const html = await store.htmlArtifactForRun("loop1", "run1");
  expect(html?.path).toBe("report.html");
});

test("htmlArtifactForRun ignores a deleted or hash-less HTML file (falls back to markdown)", async () => {
  await seed();
  const ts = new Date().toISOString();
  await (db.client as any).exec(
    `INSERT INTO artifact_files (id, loop_id, path, hash, size, "binary", oversize, deleted, updated_at, last_run_id)
     VALUES ('af1', 'loop1', 'gone.html', 'hash1', 100, false, false, true, '${ts}', 'run1')`,
  );
  await (db.client as any).exec(
    `INSERT INTO artifact_files (id, loop_id, path, hash, size, "binary", oversize, deleted, updated_at, last_run_id)
     VALUES ('af2', 'loop1', 'pending.html', NULL, NULL, false, false, false, '${ts}', 'run1')`,
  );
  expect(await store.htmlArtifactForRun("loop1", "run1")).toBeUndefined();
});

test("a deleted loop still lists its items with a graceful label fallback", async () => {
  const { item } = await seed();
  await (db.client as any).exec("DELETE FROM loops WHERE id = 'loop1'");
  const rows = await store.listTeamTodos("team-a");
  const view = toTodoItemView(rows.find((r) => r.id === item.id) as TodoItemWithContext);
  expect(view.loopName).toBe("loop1"); // falls back to the id
});
