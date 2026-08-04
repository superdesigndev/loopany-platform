import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * THE MIRROR LIFECYCLE, end to end against real pglite.
 *
 * A mirror is a pure POINTER to something outside this system. The two claims
 * that carry the design are proven here rather than described:
 *
 *  1. **One external thing is ONE mirror**, shared by everything that depends on
 *     it — because its id and key both derive from `(team, kind, coords)`.
 *  2. **There is no status write path at ANY altitude.** The verb surface has
 *     none, the kernel's field firewall refuses one, and — the floor — the DDL
 *     CHECK makes the column that would hold one non-existent. The last of those
 *     is asserted by driving raw SQL past every application guard.
 */

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let api: typeof import("./objectApi.js");
let mirrors: typeof import("./mirrorApi.js");
let ids: typeof import("./ids.js");

const TEAM = "team-mirror";
const OTHER_TEAM = "team-elsewhere";
const T0 = "2026-08-04T00:00:00.000Z";
const NOW = new Date("2026-08-04T01:00:00.000Z");
const human = { teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" }, mode: "human" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-mirror-"));
  process.env.LOOPANY_DATA_DIR = temp; process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js"); await database.runMigrations();
  schema = await import("../db/kernel-schema.js"); legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js"); api = await import("./objectApi.js");
  mirrors = await import("./mirrorApi.js"); ids = await import("./ids.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => { await database.db.delete(schema.events); await database.db.delete(schema.objects); await database.db.delete(legacySchema.runs); });

const WATCHER = "loop-fixture";
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "OK" : r.error!.code);

async function makeTask(title = "Watch PR #57") {
  const result = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title, watcher: WATCHER });
  if (!result.ok) throw new Error(result.message);
  return result.object;
}

const attach = (objectId: string, over: Record<string, unknown> = {}) =>
  mirrors.attachMirror({ objectId, kind: "github-pr", coords: "superdesigndev/loopany-platform#57", ...over }, human, NOW);

// ---------------------------------------------------------------- attach

describe("the one-liner attach — the common case, mid-run", () => {
  it("creates the mirror and attaches it in one call, with the coords resolved to a link", async () => {
    const task = await makeTask();
    const result = ok(await attach(task.id, { note: "seed article PR" }));
    expect(result.created).toBe(true);
    expect(result.mirror).toMatchObject({
      externalKind: "github-pr",
      coords: "superdesigndev/loopany-platform#57",
      note: "seed article PR",
      href: "https://github.com/superdesigndev/loopany-platform/pull/57",
      attachedTo: [task.id],
    });
    // The id is DERIVED from (team, kind, coords), which is what makes the
    // sharing below work with no second code path.
    expect(result.mirror).toMatchObject({ id: ids.mirrorObjectId(TEAM, "github-pr", "superdesigndev/loopany-platform#57") });
  });

  it("normalizes the kind mechanically, so three spellings are one row", async () => {
    const a = await makeTask("A");
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title: "B", watcher: WATCHER });
    if (!b.ok) throw new Error(b.message);
    const first = ok(await attach(a.id, { kind: "GitHub PR" }));
    const second = ok(await attach(b.object.id, { kind: "  github_pr " }));
    expect((first.mirror as { externalKind: string }).externalKind).toBe("github-pr");
    expect((second.mirror as { id: string }).id).toBe((first.mirror as { id: string }).id);
    expect((second.mirror as { attachedTo: string[] }).attachedTo).toEqual([a.id, b.object.id]);
  });

  /** ONE EXTERNAL THING IS ONE MIRROR. Two tasks depending on the same PR share
   *  the row rather than minting a twin that would then have to be kept in step. */
  it("shares an existing mirror with a second dependant instead of duplicating it", async () => {
    const a = await makeTask("A");
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title: "B", watcher: WATCHER });
    if (!b.ok) throw new Error(b.message);
    ok(await attach(a.id));
    const second = ok(await attach(b.object.id));
    expect(second.created).toBe(false);
    expect(second.changed).toBe(true);
    expect((second.mirror as { attachedTo: string[] }).attachedTo).toEqual([a.id, b.object.id]);
    const rows = await database.db.select().from(schema.objects).where(eq(schema.objects.kind, "mirror"));
    expect(rows).toHaveLength(1);
  });

  it("is idempotent: re-attaching the same object writes no second event", async () => {
    const task = await makeTask();
    ok(await attach(task.id));
    const again = ok(await attach(task.id));
    expect(again).toMatchObject({ changed: false, event: null });
    const events = await database.db.select().from(schema.events).where(eq(schema.events.kind, "mirror-attached"));
    expect(events).toHaveLength(0); // the create carried the first attachment
  });

  it("keeps the note already on record and SAYS so, rather than discarding it silently", async () => {
    const a = await makeTask("A");
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title: "B", watcher: WATCHER });
    if (!b.ok) throw new Error(b.message);
    ok(await attach(a.id, { note: "seed article PR" }));
    const second = ok(await attach(b.object.id, { note: "the fix PR" }));
    expect((second.mirror as { note: string }).note).toBe("seed article PR");
    expect(second.notice).toMatchObject({ code: "MIRROR_NOTE_KEPT" });
  });

  it("refuses a malformed coords for a KNOWN kind, and accepts any single-line coords for an unknown one", async () => {
    const task = await makeTask();
    expect(code(await attach(task.id, { coords: "https://github.com/o/r/pull/57" }))).toBe("SCHEMA_VIOLATION");
    expect(ok(await attach(task.id, { kind: "jira-ticket", coords: "PLAT-4471" })).created).toBe(true);
  });

  it("refuses attaching to a mirror — a pointer to a pointer is an alias, not a dependency", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    expect(code(await mirrors.attachMirror({ objectId: mirror.id, kind: "url", coords: "https://example.com" }, human, NOW))).toBe("WRONG_KIND");
  });

  it("refuses an object outside the caller's team, with the enumeration-safe not-found", async () => {
    const foreign = await kernel.createObject({ teamId: OTHER_TEAM, kind: "task", actor: human.actor, now: T0, title: "theirs", watcher: WATCHER });
    if (!foreign.ok) throw new Error(foreign.message);
    expect(code(await attach(foreign.object.id))).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------- detach

describe("detach — this object no longer depends on that thing", () => {
  it("removes one attachment and leaves the others, writing the diff on the mirror", async () => {
    const a = await makeTask("A");
    const b = await kernel.createObject({ teamId: TEAM, kind: "task", actor: human.actor, now: T0, title: "B", watcher: WATCHER });
    if (!b.ok) throw new Error(b.message);
    const mirror = ok(await attach(a.id)).mirror as { id: string };
    ok(await attach(b.object.id));
    const result = ok(await mirrors.detachMirror(mirror.id, a.id, human, NOW));
    expect(result.changed).toBe(true);
    expect((result.mirror as { attachedTo: string[] }).attachedTo).toEqual([b.object.id]);
    expect(result.orphaned).toBe(false);
    const events = await database.db.select().from(schema.events).where(eq(schema.events.kind, "mirror-detached"));
    expect(events).toHaveLength(1);
    expect(events[0]!.objectId).toBe(mirror.id);
    expect(events[0]!.diff).toMatchObject({ attachedTo: { old: [a.id, b.object.id], new: [b.object.id] } });
  });

  /** Detaching the last attachment is legal: nothing in this kernel is deleted,
   *  and an empty set is a fact ("nothing depends on this any more"), not a
   *  state anyone has to enforce. */
  it("allows the last attachment to go, keeping the row readable", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    const result = ok(await mirrors.detachMirror(mirror.id, task.id, human, NOW));
    expect(result.orphaned).toBe(true);
    expect(ok(await mirrors.showMirror(mirror.id, human)).mirror).toMatchObject({ attachedTo: [] });
  });

  it("is a free retry: detaching what was never attached succeeds and changes nothing", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    ok(await mirrors.detachMirror(mirror.id, task.id, human, NOW));
    const again = ok(await mirrors.detachMirror(mirror.id, task.id, human, NOW));
    expect(again).toMatchObject({ changed: false, event: null });
    expect((again.notice as { code: string }).code).toBe("NOT_ATTACHED");
  });

  it("requires --from: guessing which dependency to release would remove somebody else's", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    expect(code(await mirrors.detachMirror(mirror.id, undefined, human, NOW))).toBe("INVALID_BODY");
  });
});

// ---------------------------------------------------- the reverse lookup

describe("task/doc/loop show compose mirrors[] by reverse lookup", () => {
  it("finds every mirror attached to the object, on all three kinds", async () => {
    const task = await makeTask();
    const doc = await kernel.createObject({ teamId: TEAM, kind: "doc", actor: human.actor, now: T0, title: "report" });
    const loop = await kernel.createObject({ teamId: TEAM, kind: "loop", actor: human.actor, now: T0, title: "watcher", body: "charter" });
    if (!doc.ok || !loop.ok) throw new Error("fixture");
    ok(await attach(task.id, { note: "the PR" }));
    ok(await attach(doc.object.id, { kind: "url", coords: "https://example.com/report" }));
    ok(await attach(loop.object.id, { kind: "gsc-property", coords: "sc-domain:example.com" }));

    expect(ok(await api.showObject("task", task.id, human)).mirrors).toMatchObject([{ externalKind: "github-pr" }]);
    expect(ok(await api.showObject("doc", doc.object.id, human)).mirrors).toMatchObject([{ externalKind: "url" }]);
    expect(ok(await api.showObject("loop", loop.object.id, human)).mirrors).toMatchObject([{ externalKind: "gsc-property" }]);
  });

  it("is empty, never absent, for an object with none", async () => {
    const task = await makeTask();
    expect(ok(await api.showObject("task", task.id, human)).mirrors).toEqual([]);
  });

  it("never leaks another team's pointer at the same coords", async () => {
    const task = await makeTask();
    ok(await attach(task.id));
    const theirs = { ...human, teamId: OTHER_TEAM } as unknown as typeof human;
    const foreignTask = await kernel.createObject({ teamId: OTHER_TEAM, kind: "task", actor: human.actor, now: T0, title: "theirs", watcher: WATCHER });
    if (!foreignTask.ok) throw new Error("fixture");
    ok(await mirrors.attachMirror({ objectId: foreignTask.object.id, kind: "github-pr", coords: "superdesigndev/loopany-platform#57" }, theirs, NOW));
    // Two teams, one external thing, two rows: the id seed carries the team, so
    // sharing stops at the team boundary.
    const rows = await database.db.select().from(schema.objects).where(eq(schema.objects.kind, "mirror"));
    expect(rows).toHaveLength(2);
    expect(await mirrors.mirrorsFor(undefined, TEAM, foreignTask.object.id)).toEqual([]);
  });
});

// ------------------------------------------------------ inline front matter

describe("the inline `mirrors:` block — when the reference predates the task", () => {
  const file = (block: string) => `---\ntitle: Watch the seed PR\nkey: seed-pr-watch\nwatcher: ${WATCHER}\n${block}---\n\nCheck it daily.\n`;
  const BLOCK = "mirrors:\n  - kind: github-pr\n    coords: superdesigndev/loopany-platform#57\n    note: seed article PR\n  - kind: url\n    coords: https://example.com/brief\n";

  it("creates the task and both mirrors in ONE transaction", async () => {
    const result = ok(await api.createFromArtifact("task", file(BLOCK), human, NOW));
    expect(result.created).toBe(true);
    expect(result.mirrors).toHaveLength(2);
    const taskId = (result.task as { id: string }).id;
    const attached = await mirrors.mirrorsFor(undefined, TEAM, taskId);
    expect(attached.map((m) => m.externalKind).sort()).toEqual(["github-pr", "url"]);
    expect(attached.find((m) => m.externalKind === "github-pr")!.note).toBe("seed article PR");
  });

  /** The block is part of the file, so a bad entry FAILS THE CREATE — a
   *  half-applied file is the ambiguity one transaction exists to prevent. */
  it("fails the whole create on a malformed entry, writing no task at all", async () => {
    const bad = "mirrors:\n  - kind: github-pr\n    coords: not-a-ref\n";
    expect(code(await api.createFromArtifact("task", file(bad), human, NOW))).toBe("SCHEMA_VIOLATION");
    expect(await database.db.select().from(schema.objects)).toHaveLength(0);
  });

  it("refuses the same external thing listed twice in one file", async () => {
    const twice = "mirrors:\n  - kind: github-pr\n    coords: o/r#1\n  - kind: github-pr\n    coords: o/r#1\n";
    expect(code(await api.createFromArtifact("task", file(twice), human, NOW))).toBe("SCHEMA_VIOLATION");
  });

  /**
   * CREATE-ONLY, and refused by name on update. A whole-file update cannot be
   * the authority on a set that lives on the mirror side — a file that merely
   * omitted one would silently detach it.
   */
  it("refuses a mirrors: block on the whole-file update path, pointing at attach", async () => {
    const created = ok(await api.createFromArtifact("task", file(""), human, NOW));
    const id = (created.task as { id: string }).id;
    const refused = await api.replaceFromArtifact("task", id, file(BLOCK), human, NOW);
    expect(code(refused)).toBe("UNKNOWN_KEY");
    expect(refused.ok === false && refused.error.hint).toContain("mirror attach");
  });

  /** `show --file` must round-trip, so it never emits the block: the mirrors are
   *  a separate object, not part of this object's state. */
  it("is never emitted by the canonical artifact, so show --file → create replays clean", async () => {
    const created = ok(await api.createFromArtifact("task", file(BLOCK), human, NOW));
    const id = (created.task as { id: string }).id;
    const row = (await (await import("../db/kernelStore.js")).getObject(undefined, id))!;
    const artifact = api.objectArtifact(row);
    expect(artifact).not.toContain("mirrors:");
    const replay = ok(await api.createFromArtifact("task", artifact, human, NOW));
    expect(replay).toMatchObject({ created: false, contentDiffers: false });
  });
});

// -------------------------------------------------- coords are immutable

describe("coords are the external thing's identity, so they are never rewritten", () => {
  it("refuses a coords or kind change with the detach-and-attach teaching", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    for (const key of ["coords", "kind", "mirrorCoords", "externalKind"]) {
      const refused = await mirrors.patchMirror(mirror.id, { [key]: "o/r#99" }, human, NOW);
      expect(code(refused)).toBe("IMMUTABLE_COORDS");
      expect(refused.ok === false && refused.error.hint).toContain("detach this mirror and attach a new one");
    }
  });

  /** Two altitudes, like every rule in this kernel: the HTTP verb above, and the
   *  kernel's own field surface here, which no caller can go around. */
  it("refuses them at the kernel's field surface too, whichever route reaches it", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    const refused = await kernel.applyUpdate({ objectId: mirror.id, actor: human.actor, now: T0, fields: { mirrorCoords: "o/r#99" } });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe("IMMUTABLE_COORDS");
  });

  it("lets the NOTE be fixed — a human label with a typo in it is worth repairing", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id, { note: "sed article PR" })).mirror as { id: string };
    const patched = ok(await mirrors.patchMirror(mirror.id, { note: "seed article PR" }, human, NOW));
    expect(patched.changed).toBe(true);
    expect((patched.mirror as { note: string }).note).toBe("seed article PR");
  });
});

// ------------------------------------------- STATELESSNESS, all the way down

describe("statelessness is enforced by the SCHEMA, not by convention", () => {
  /**
   * THE FLOOR. This bypasses every verb, every kernel guard and Drizzle's own
   * typing to write the column a "just cache it this once" commit would reach
   * for — and Postgres refuses. That is what makes the property structural
   * rather than a rule somebody has to remember.
   */
  it("makes a payload on a mirror physically unwritable, even from raw SQL", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    await expect(
      database.db.execute(sql`update objects set payload = '{"state":"merged"}'::jsonb where id = ${mirror.id}`),
    ).rejects.toMatchObject({ cause: { constraint: "objects_mirror_stateless" } });
    await expect(
      database.db.execute(sql`update objects set body = 'merged at 09:00' where id = ${mirror.id}`),
    ).rejects.toMatchObject({ cause: { constraint: "objects_mirror_stateless" } });
  });

  it("keeps the mirror facets off every other kind, welded the same way", async () => {
    const task = await makeTask();
    await expect(
      database.db.execute(sql`update objects set mirror_coords = 'o/r#1' where id = ${task.id}`),
    ).rejects.toMatchObject({ cause: { constraint: "objects_mirror_facets_only" } });
  });

  it("refuses a mirror with no kind, no coords or nothing attached", async () => {
    await expect(
      database.db.execute(sql`insert into objects (id, team_id, kind, status, created_at, updated_at) values ('mirror-bad', ${TEAM}, 'mirror', 'current', ${T0}, ${T0})`),
    ).rejects.toMatchObject({ cause: { constraint: "objects_mirror_pointer" } });
  });

  /** The teaching altitude, which is what an author actually meets. */
  it("refuses a payload at the kernel seam with a sentence, before the floor is reached", async () => {
    const task = await makeTask();
    const refused = await kernel.createObject({
      teamId: TEAM, kind: "mirror", actor: human.actor, now: T0, id: "mirror-x",
      mirrorKind: "github-pr", mirrorCoords: "o/r#1", attachedTo: [task.id],
      payload: { state: "merged" },
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe("MIRROR_STATELESS");
    expect(refused.ok === false && refused.message).toContain("payload");
  });

  /**
   * THE VERB SURFACE, asserted as an ABSENCE. Every state-shaped key an author
   * might reach for is refused BY NAME — "unknown key" would read as a spelling
   * problem, and this is a modelling one.
   */
  it("has no verb that accepts a state, under any of the names one would try", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    for (const key of ["state", "status", "merged", "closed", "payload", "body"]) {
      expect(code(await mirrors.patchMirror(mirror.id, { [key]: "merged" }, human, NOW)), key).toBe("MIRROR_STATELESS");
    }
  });

  it("echoes no payload or body on the wire either, so no client can believe in one", async () => {
    const task = await makeTask();
    const mirror = ok(await attach(task.id)).mirror as { id: string };
    const shape = ok(await mirrors.showMirror(mirror.id, human)).mirror as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(
      ["attachedTo", "coords", "createdAt", "createdByLoop", "createdByRun", "externalKind", "href", "id", "kind", "note", "updatedAt"],
    );
  });
});

// -------------------------------------------------------- list and kinds

describe("reads: the list filters, and the self-exposing vocabulary", () => {
  async function fixture() {
    const task = await makeTask();
    ok(await attach(task.id, { note: "seed article PR" }));
    ok(await attach(task.id, { kind: "github-issue", coords: "superdesigndev/loopany-platform#12" }));
    ok(await attach(task.id, { kind: "Jira Ticket", coords: "PLAT-4471" }));
    return task;
  }

  it("filters by attachment, by kind and by a coords substring", async () => {
    const task = await fixture();
    expect((ok(await mirrors.listMirrors(human, new URLSearchParams({ "attached-to": task.id }))).mirrors as unknown[])).toHaveLength(3);
    // The kind filter normalizes the way a WRITE does, so the vocabulary is
    // usable without knowing how it was spelled at attach time.
    expect((ok(await mirrors.listMirrors(human, new URLSearchParams({ kind: "GitHub PR" }))).mirrors as unknown[])).toHaveLength(1);
    expect((ok(await mirrors.listMirrors(human, new URLSearchParams({ "coords-like": "loopany-platform#" }))).mirrors as unknown[])).toHaveLength(2);
    expect((ok(await mirrors.listMirrors(human, new URLSearchParams({ "coords-like": "PLAT-" }))).mirrors as unknown[])).toHaveLength(1);
  });

  it("treats a LIKE metacharacter as a literal, not a glob", async () => {
    await fixture();
    expect((ok(await mirrors.listMirrors(human, new URLSearchParams({ "coords-like": "%" }))).mirrors as unknown[])).toHaveLength(0);
  });

  it("refuses an unknown filter rather than ignoring it", async () => {
    expect(code(await mirrors.listMirrors(human, new URLSearchParams({ state: "open" })))).toBe("UNKNOWN_FILTER");
  });

  it("reports the kinds actually IN USE with counts, flagging which are canonical", async () => {
    await fixture();
    const result = ok(await mirrors.mirrorKinds(human));
    expect(result.kinds).toEqual([
      { kind: "github-issue", count: 1, known: true },
      { kind: "github-pr", count: 1, known: true },
      { kind: "jira-ticket", count: 1, known: false },
    ]);
    expect((result.canonical as { kind: string }[]).map((k) => k.kind)).toEqual(["github-pr", "github-issue", "url", "gsc-property"]);
  });
});
