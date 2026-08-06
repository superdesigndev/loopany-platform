/**
 * TASK HIERARCHY — `objects.parent_id`, the write-time cycle guard, and the
 * WRITE SURFACES that reach them, against a real pglite database. Convergence S1
 * landed the column and the guard; S4 opened the artifact key (`parent:`), the
 * field patch (`parent`) and the read surface (`parent` + `children` on show).
 *
 * The guard is asserted at BOTH altitudes, for the same reason the kind
 * firewalls are: once through the kernel (the teaching refusal an agent reads)
 * and once by writing raw SQL past it (the `objects_parent_task_only` CHECK, the
 * floor that holds even if a verb guard were removed).
 *
 * The design's cautionary tale is `feat/task-tree-v2`, whose parent was a SLUG in
 * hand-edited front matter with files as the writers — so no write-time guard was
 * possible at all and slug collisions were a permanent ambiguity class. These
 * cases pin what referencing by ID through one chokepoint buys instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let tmp: string;
let db: typeof import("../db/index.js");
let kernel: typeof import("./applyTransition.js");
let schema: typeof import("../db/kernel-schema.js");
let api: typeof import("./objectApi.js");

const TEAM = "team-parent";
const OTHER = "team-elsewhere";
const AGENT = { entrance: "agent", actorId: "run-1" } as const;
const HUMAN = { entrance: "human", actorId: "u_alice" } as const;
const T0 = "2026-08-03T07:00:00.000Z";
const T1 = "2026-08-03T08:00:00.000Z";
const WATCHER = "loop-fixture";
const HUMAN_CTX = { teamId: TEAM, actor: HUMAN, mode: "owner" } as never;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-parent-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  db = await import("../db/index.js");
  await db.runMigrations();
  kernel = await import("./applyTransition.js");
  schema = await import("../db/kernel-schema.js");
  api = await import("./objectApi.js");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  await db.db.delete(schema.events);
  await db.db.delete(schema.objects);
});

async function task(over: Record<string, unknown> = {}) {
  const r = await kernel.createObject({ teamId: TEAM, kind: "task", actor: AGENT, now: T0, title: "t", watcher: WATCHER, ...over });
  if (!r.ok) throw new Error(`fixture create failed: ${r.code} ${r.message}`);
  return r.object;
}

const refusalOf = (r: { ok: boolean }) => {
  expect(r.ok, `expected a refusal, got ${JSON.stringify(r)}`).toBe(false);
  return r as unknown as { code: string; message: string; hint?: string; issues: { path: string }[] };
};

describe("parent_id — the column and its firewall", () => {
  it("stores a parent by id, and clears back to a root", async () => {
    const parent = await task({ title: "epic" });
    const child = await task({ title: "step 1", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    const cleared = await kernel.applyUpdate({ objectId: child.id, actor: AGENT, now: T1, fields: { parentId: null } });
    expect(cleared.ok && cleared.object.parentId).toBe(null);
    // Unlike `watcher: null` — the release gesture the watcher rule abolished —
    // a task genuinely can stop being a sub-task, so this is a legal move.
    expect(cleared.ok && cleared.changed).toBe(true);
  });

  it("refuses a parent on a doc, by name, and the DDL is the floor", async () => {
    const refused = refusalOf(await kernel.createObject({
      teamId: TEAM, kind: "doc", actor: HUMAN, now: T0, title: "notes", parentId: "task-abc123",
    }));
    expect(refused.code).toBe("WRONG_KIND");
    expect(refused.issues.map((i) => i.path)).toContain("parentId");

    // Past every application guard: the CHECK still holds.
    let caught: unknown;
    try {
      await db.db.insert(schema.objects).values({
        id: "doc-raw01", teamId: TEAM, kind: "doc", docKind: "product", status: "current", parentId: "task-abc123",
        createdAt: T0, updatedAt: T0,
      } as never);
    } catch (e) { caught = e; }
    const cause = (caught as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
    expect(cause?.code).toBe("23514");
    expect(cause?.constraint).toBe("objects_parent_task_only");
  });
});

describe("the write-time cycle guard", () => {
  it("refuses a task as its own parent", async () => {
    const solo = await task({ title: "solo" });
    const refused = refusalOf(await kernel.applyUpdate({ objectId: solo.id, actor: AGENT, now: T1, fields: { parentId: solo.id } }));
    expect(refused.code).toBe("PARENT_CYCLE");
    expect(refused.message).toContain("cannot be its own parent");
    expect(refused.hint).toContain("a task tree is a tree");
  });

  it("refuses a parent that is already a descendant — the real cycle", async () => {
    const a = await task({ title: "a" });
    const b = await task({ title: "b", parentId: a.id });
    const c = await task({ title: "c", parentId: b.id });
    const refused = refusalOf(await kernel.applyUpdate({ objectId: a.id, actor: AGENT, now: T1, fields: { parentId: c.id } }));
    expect(refused.code).toBe("PARENT_CYCLE");
    // NOTHING was written — the refusal is not a partial apply.
    const after = await kernel.applyUpdate({ objectId: a.id, actor: AGENT, now: T1, fields: { title: "a" } });
    expect(after.ok && after.object.parentId).toBe(null);
  });

  it("refuses a parent that does not exist, or that belongs to another team", async () => {
    const child = await task({ title: "child" });
    expect(refusalOf(await kernel.applyUpdate({ objectId: child.id, actor: AGENT, now: T1, fields: { parentId: "task-nope01" } })).code).toBe("NOT_FOUND");

    const foreign = await kernel.createObject({ teamId: OTHER, kind: "task", actor: AGENT, now: T0, title: "theirs", watcher: WATCHER });
    if (!foreign.ok) throw new Error("fixture");
    const refused = refusalOf(await kernel.applyUpdate({ objectId: child.id, actor: AGENT, now: T1, fields: { parentId: foreign.object.id } }));
    // Team-scoped, so a cross-team parent is indistinguishable from a missing
    // one — the same enumeration-safe answer every other kernel read gives.
    expect(refused.code).toBe("NOT_FOUND");
  });

  it("refuses a parent that is not a task — hierarchy is a TASK relation", async () => {
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: HUMAN, now: T0, title: "Report" });
    if (!doc.ok) throw new Error("fixture");
    const child = await task({ title: "child" });
    const refused = refusalOf(await kernel.applyUpdate({ objectId: child.id, actor: AGENT, now: T1, fields: { parentId: doc.object.id } }));
    expect(refused.code).toBe("WRONG_KIND");
    // The loop that acts next is the WATCHER; saying so is the whole point of a
    // teaching refusal over a bare "wrong kind".
    expect(refused.hint).toContain("watcher");
  });

  it("guards the CREATE path too, not just the update", async () => {
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: HUMAN, now: T0, title: "notes" });
    if (!doc.ok) throw new Error("fixture");
    const refused = refusalOf(await kernel.createObject({
      teamId: TEAM, kind: "task", actor: AGENT, now: T0, title: "child", watcher: WATCHER, parentId: doc.object.id,
    }));
    expect(refused.code).toBe("WRONG_KIND");
  });

  it("does NOT refuse a closed parent — there is no roll-up in either direction", async () => {
    const parent = await task({ title: "epic" });
    const closed = await kernel.applyTransition({ objectId: parent.id, transition: "close", actor: AGENT, now: T1, note: "done" });
    expect(closed.ok).toBe(true);
    const child = await task({ title: "leftover", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it("refuses a parent on the ARTIFACT create path, teaching rather than crashing", async () => {
    // A nonexistent parent through the file door: the same NOT_FOUND the field
    // patch gives, because there is no FK and the write seam is the only guard.
    const refused = await api.createFromArtifact("task", `---\ntitle: step 1\nwatcher: ${WATCHER}\nparent: task-nope01\n---\n\nbody\n`, HUMAN_CTX, new Date(T0));
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string; hint: string } }).error.code).toBe("NOT_FOUND");
    expect((refused as { error: { hint: string } }).error.hint).toContain("copy the id");
  });

  it("bounds the ancestor walk rather than following a chain forever", async () => {
    // Depth is bounded by construction, so a legal tree well inside the bound
    // still lands: what the bound protects is a transaction holding a row lock.
    let previous: string | null = null;
    for (let i = 0; i < 12; i++) {
      const row = await task({ title: `level-${i}`, ...(previous ? { parentId: previous } : {}) });
      previous = row.id;
    }
    expect(kernel.PARENT_MAX_HOPS).toBeGreaterThan(12);
    const deepest = await kernel.applyUpdate({ objectId: previous!, actor: AGENT, now: T1, fields: { title: "deepest" } });
    expect(deepest.ok).toBe(true);
  });
});

/**
 * THE S4 SURFACES — the artifact key, the field patch, and what a `show` says.
 *
 * The guard itself is covered above; these cases pin that each DOOR reaches it
 * and that a person or a run gets a teaching refusal rather than a stack trace.
 */
/**
 * THE S4 SURFACES — the artifact key, the field patch, and what a `show` says.
 *
 * The guard itself is covered above; these cases pin that each DOOR reaches it
 * and that a person or a run gets a teaching refusal rather than a stack trace.
 */
describe("the write surfaces that reach the guard", () => {
  const file = (over: string) => `---\ntitle: step\nwatcher: ${WATCHER}\n${over}\n---\n\nbody\n`;
  /** The wire shapes, read back without re-declaring the whole payload type. */
  const valueOf = (r: unknown) => (r as { value: Record<string, unknown> }).value;
  const taskOf = (r: unknown) => valueOf(r).task as Record<string, unknown>;
  const errorOf = (r: unknown) => (r as { error: { code: string; hint: string; issues: { path: string }[] } }).error;
  const parentOf = async (id: string) => (await kernel.applyUpdate({ objectId: id, actor: AGENT, now: T1, fields: {} })) as { ok: boolean; object?: { parentId: string | null; status: string } };

  it("files a sub-task through `parent:` in the front matter", async () => {
    const parent = await task({ title: "epic" });
    const created = await api.createFromArtifact("task", file(`parent: ${parent.id}`), HUMAN_CTX, new Date(T0));
    expect(created.ok).toBe(true);
    expect(taskOf(created).parentId).toBe(parent.id);
  });

  // The kind prefix IS the type, so a loop id in `parent:` is caught for SHAPE at
  // the seam and never reaches the transaction.
  it("refuses a `parent:` that is not a task id, at the artifact seam", async () => {
    const refused = await api.createFromArtifact("task", file("parent: loop-4c1d77"), HUMAN_CTX, new Date(T0));
    expect(errorOf(refused).code).toBe("SCHEMA_VIOLATION");
    expect(errorOf(refused).issues.map((i) => i.path)).toContain("parent");
  });

  it("MOVES a task through the field patch, and back to a root with null", async () => {
    const parent = await task({ title: "epic" });
    const child = await task({ title: "step" });
    expect(taskOf(await api.patchTask(child.id, { parent: parent.id }, HUMAN_CTX, new Date(T1))).parentId).toBe(parent.id);
    // The asymmetry with `watcher` is deliberate: a task may stop being a
    // sub-task, but it may never stop having a watcher.
    expect(taskOf(await api.patchTask(child.id, { parent: null }, HUMAN_CTX, new Date(T1))).parentId).toBe(null);
  });

  it("surfaces the CYCLE refusal through the patch, with the teaching intact", async () => {
    const a = await task({ title: "a" });
    const b = await task({ title: "b", parentId: a.id });
    const refused = await api.patchTask(a.id, { parent: b.id }, HUMAN_CTX, new Date(T1));
    expect(refused.ok).toBe(false);
    expect(errorOf(refused).code).toBe("PARENT_CYCLE");
    expect(errorOf(refused).hint).toContain("a task tree is a tree");
    // Nothing was written — a refusal is never a partial apply.
    expect((await parentOf(a.id)).object!.parentId).toBe(null);
  });

  it("refuses a `parent` that names anything but a task id or null", async () => {
    const child = await task({ title: "step" });
    const refused = await api.patchTask(child.id, { parent: "loop-4c1d77" }, HUMAN_CTX, new Date(T1));
    expect(errorOf(refused).code).toBe("SCHEMA_VIOLATION");
    expect(errorOf(refused).hint).toContain("watcher");
  });

  it("shows BOTH directions — the parent column and the children lookup", async () => {
    const parent = await task({ title: "epic" });
    const first = await task({ title: "step 1", parentId: parent.id });
    const second = await task({ title: "step 2", parentId: parent.id });

    const onParent = valueOf(await api.showObject("task", parent.id, HUMAN_CTX));
    expect((onParent.children as { id: string }[]).map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(onParent.parent).toBeUndefined();

    const onChild = valueOf(await api.showObject("task", first.id, HUMAN_CTX));
    expect(onChild.parent).toMatchObject({ id: parent.id, title: "epic" });
    expect(onChild.children).toEqual([]);
  });

  // A closed parent keeps its children: there is no roll-up in either direction,
  // so a `show` says what is true rather than what would be tidy.
  it("keeps a closed parent's children listed, and closes none of them", async () => {
    const parent = await task({ title: "epic" });
    const child = await task({ title: "leftover", parentId: parent.id });
    await kernel.applyTransition({ objectId: parent.id, transition: "close", actor: AGENT, now: T1, note: "done" });
    const value = valueOf(await api.showObject("task", parent.id, HUMAN_CTX));
    expect((value.children as { id: string }[]).map((c) => c.id)).toEqual([child.id]);
    expect((await parentOf(child.id)).object!.status).toBe("open");
  });

  /** `show --file` → `create` must round-trip, so the parent has to be IN the
   *  file the server itself emits — otherwise re-uploading it silently reroots
   *  the task. */
  it("round-trips `parent:` through the canonical artifact file", async () => {
    const parent = await task({ title: "epic" });
    const child = await task({ title: "step", parentId: parent.id });
    const text = api.objectArtifact(child);
    expect(text).toContain(`parent: ${parent.id}`);

    const replayed = await api.replaceFromArtifact("task", child.id, text, HUMAN_CTX, new Date(T1));
    expect(replayed.ok).toBe(true);
    expect((await parentOf(child.id)).object!.parentId).toBe(parent.id);
  });
});
