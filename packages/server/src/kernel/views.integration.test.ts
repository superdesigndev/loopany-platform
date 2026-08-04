import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The view endpoints against a real database and a real fixture.
 *
 * Two things are being pinned here and they are different in kind:
 *
 *  1. **Shapes** — a view is a screen's contract, so the keys the screen reads
 *     are asserted explicitly. A missing `execution`, `cursorSeq` or
 *     `watcherLoop` is a broken screen, not a cosmetic diff.
 *  2. **Inbox union correctness** — the §6 safety floor. The fixture below
 *     deliberately contains one task for every branch AND one task for every
 *     NEAR MISS (watched-and-due, fresh-and-unwatched), because the floor's
 *     value is entirely in what it does and does not surface.
 */

let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let legacySchema: typeof import("../db/schema.js");
let kernel: typeof import("./applyTransition.js");
let views: typeof import("./views.js");
let objectApi: typeof import("./objectApi.js");

const TEAM = "team-views";
const OTHER_TEAM = "team-elsewhere";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const ahead = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const human = { teamId: TEAM, actor: { entrance: "human", actorId: "u-owner" }, mode: "human" } as const;
const agentContext = { teamId: TEAM, actor: { entrance: "agent", actorId: "run-x" }, mode: "agent", run: { id: "run-x", loopId: "loop-x" } } as never;

let housekeeper: string;
let steward: string;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-views-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/kernel-schema.js");
  legacySchema = await import("../db/schema.js");
  kernel = await import("./applyTransition.js");
  views = await import("./views.js");
  objectApi = await import("./objectApi.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
  await database.db.delete(legacySchema.runs);
  await seed();
});

async function make(input: Record<string, unknown>) {
  const result = await kernel.createObject({ actor: human.actor, teamId: TEAM, now: ago(200), ...input } as never);
  if (!result.ok) throw new Error(result.message);
  return result.object;
}

async function insertRun(over: Record<string, unknown>) {
  await database.db.insert(legacySchema.runs).values({
    id: "run-seed", loopId: housekeeper, userId: "u-owner", machineId: "m-1", phase: "done", role: "exec",
    ts: ago(5), queueState: "success", scope: "routine", reason: "clock", startedAt: ago(5), finishedAt: ago(4),
    costUsd: 0.4, attempts: 1, ...over,
  } as never);
}

/**
 * The fixture: two loops, tasks in each of the three archetypal lives plus the
 * near misses, two docs (one of each format), and a run history that gives the
 * loop page something to be healthy about.
 */
async function seed() {
  housekeeper = (await make({ kind: "loop", title: "Housekeeper", cron: "0 7 * * *", body: "You are the Housekeeper.\n" })).id;
  steward = (await make({ kind: "loop", title: "FollowUp", cron: "30 8 * * *", body: "You sweep the pool.\n" })).id;

  // Life 1 — fully automatic: watched, due later, never asks. Not in the inbox.
  await make({ kind: "task", title: "Observe the impact of PR #201", createdByLoop: housekeeper, watcher: steward, followUpAt: ahead(24) });
  // Life 2 — born gated: created WITH a question, watcher = its creator.
  await make({ kind: "task", title: "Reddit reply to r/selfhosted", createdByLoop: housekeeper, watcher: housekeeper, pendingQuestion: "post as drafted, or soften the pitch?", payload: { draft: "We built this because…", subreddit: "selfhosted" } });
  // Life 3 — acquires a question: automatic until an anomaly. Applied below.
  const anomaly = await make({ kind: "task", title: "Watch the error rate", createdByLoop: housekeeper, watcher: housekeeper, followUpAt: ago(1) });
  await kernel.applyUpdate({ objectId: anomaly.id, actor: { entrance: "agent", actorId: "run-triage" }, now: ago(2), fields: { pendingQuestion: "error rate doubled — (a) revert (b) one more day" } } as never);

  // The floor's other two branches.
  await make({ kind: "task", title: "Draft the pricing FAQ", createdByLoop: housekeeper, followUpAt: ago(3) }); // due + unwatched
  await make({ kind: "task", title: "Nobody asked for this", createdByLoop: housekeeper, now: ago(72) }); // orphan

  // NEAR MISSES — each must stay OUT of the inbox.
  await make({ kind: "task", title: "Watched and due", createdByLoop: housekeeper, watcher: steward, followUpAt: ago(3) });
  await make({ kind: "task", title: "Fresh and unwatched", createdByLoop: housekeeper, now: ago(1) });
  const closed = await make({ kind: "task", title: "Already closed", createdByLoop: housekeeper, now: ago(96) });
  await kernel.applyTransition({ objectId: closed.id, transition: "close", actor: human.actor, now: ago(90), note: "done" } as never);

  // Adoption: created unwatched, watcher set later — the pool → watcher edge.
  const adopted = await make({ kind: "task", title: "Adopted from the pool", createdByLoop: housekeeper, now: ago(30) });
  await kernel.applyUpdate({ objectId: adopted.id, actor: { entrance: "agent", actorId: "run-sweep" }, now: ago(20), fields: { watcher: steward } } as never);

  // Another team's task must never appear in this team's screens.
  const foreign = await kernel.createObject({ teamId: OTHER_TEAM, kind: "task", actor: { entrance: "human", actorId: "u-other" }, now: ago(96), title: "Not yours", pendingQuestion: "?" } as never);
  if (!foreign.ok) throw new Error(foreign.message);

  await make({ kind: "doc", title: "Housekeeper 2026-08-08", format: "markdown", body: "# Report\n\nAdopted 2, closed 3.\n", createdByLoop: housekeeper });
  await make({ kind: "doc", title: "Weekly board", format: "html", body: "<h1>Board</h1><script>parent.postMessage('x','*')</script>", createdByLoop: steward });

  await insertRun({});
  await insertRun({ id: "run-old", ts: ago(29), startedAt: ago(29), finishedAt: ago(28), queueState: "failure", costUsd: 0.1 });
  await insertRun({ id: "run-steward", loopId: steward, ts: ago(3), startedAt: ago(3), finishedAt: ago(3), queueState: "success", costUsd: 0.2 });
}

const ok = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.value;
};

// --------------------------------------------------------------------- inbox

describe("GET /api/views/inbox — the §6 union, exactly", () => {
  it("surfaces every branch and nothing else", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string }; reasons: string[] }[]; counts: Record<string, number> };
    expect(value.items.map((i) => i.task.title).sort()).toEqual([
      "Draft the pricing FAQ", "Nobody asked for this", "Reddit reply to r/selfhosted", "Watch the error rate",
    ]);
    expect(value.counts).toEqual({ question: 2, dueUnwatched: 1, orphan: 1, total: 4 });
  });

  it("keeps the near misses out — a watched due task and a fresh orphan-to-be", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string } }[] };
    const titles = value.items.map((i) => i.task.title);
    expect(titles).not.toContain("Watched and due");
    expect(titles).not.toContain("Fresh and unwatched");
    expect(titles).not.toContain("Already closed");
    expect(titles).not.toContain("Observe the impact of PR #201");
  });

  it("is team-scoped: another team's question is invisible", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string } }[] };
    expect(value.items.map((i) => i.task.title)).not.toContain("Not yours");
  });

  it("orders decisions before the floor branches", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { reasons: string[] }[] };
    expect(value.items[0]!.reasons).toContain("question");
    expect(value.items.at(-1)!.reasons).not.toContain("question");
  });

  it("crosses the 48h orphan floor only after 48h", async () => {
    const early = ok(await views.inboxView(human, new Date(Date.parse(ago(72)) + 47 * 3_600_000))) as { items: { task: { title: string } }[] };
    expect(early.items.map((i) => i.task.title)).not.toContain("Nobody asked for this");
  });

  it("echoes the payload verbatim under `execution`, next to the answer box", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string; payload: unknown }; execution: unknown }[] };
    const reddit = value.items.find((i) => i.task.title === "Reddit reply to r/selfhosted")!;
    expect(reddit.execution).toEqual({ draft: "We built this because…", subreddit: "selfhosted" });
    expect(reddit.execution).toEqual(reddit.task.payload);
  });

  it("carries the screen's other contracted keys", async () => {
    const value = ok(await views.inboxView(human, NOW)) as Record<string, unknown> & { items: Record<string, unknown>[] };
    expect(Object.keys(value).sort()).toEqual(["counts", "cursorSeq", "items", "now"]);
    expect(typeof value.cursorSeq).toBe("number");
    const item = value.items.find((i) => (i.task as { title: string }).title === "Watch the error rate")!;
    expect(Object.keys(item).sort()).toEqual(["askedAt", "askedByRun", "creator", "execution", "reasons", "recentEvents", "task", "watcherLoop"]);
    expect(item.creator).toEqual({ id: housekeeper, title: "Housekeeper" });
    expect(item.watcherLoop).toEqual({ id: housekeeper, title: "Housekeeper" });
    // The question was attached by a run, so the screen can name the run.
    expect(item.askedByRun).toBe("run-triage");
    expect((item.recentEvents as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("agrees with the raw human-CLI endpoint on WHICH tasks are waiting", async () => {
    const view = ok(await views.inboxView(human, NOW)) as { items: { task: { id: string } }[] };
    const raw = ok(await objectApi.inbox(human, NOW)) as { items: { task: { id: string } }[] };
    expect(view.items.map((i) => i.task.id)).toEqual(raw.items.map((i) => i.task.id));
  });

  it("refuses a run: the inbox composes a human screen", async () => {
    const result = await views.inboxView(agentContext, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_HUMAN");
  });
});

// --------------------------------------------------------------------- loops

describe("GET /api/views/loop/:id", () => {
  it("composes the charter, health, the three task sections and the run strip", async () => {
    const value = ok(await views.loopView(housekeeper, human, NOW)) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["charterHistory", "cursorSeq", "events", "health", "loop", "openTasks", "recentRuns"]);
    const loop = value.loop as Record<string, unknown>;
    expect(loop.cronText).toBe("daily 07:00");
    expect(loop.body).toBe("You are the Housekeeper.\n");
    expect(value.health).toMatchObject({ lastOutcome: "success", consecutiveFailures: 0, runs7d: { success: 1, failure: 1 } });
    const open = value.openTasks as { watching: { title: string }[]; created: { title: string }[]; questions: { title: string }[] };
    expect(open.watching.map((t) => t.title)).toEqual(["Watch the error rate", "Reddit reply to r/selfhosted"]);
    expect(open.created.length).toBeGreaterThan(4);
    expect(open.questions.map((t) => t.title).sort()).toEqual(["Reddit reply to r/selfhosted", "Watch the error rate"]);
    expect((value.recentRuns as { id: string }[]).map((r) => r.id)).toEqual(["run-seed", "run-old"]);
  });

  it("shows evolve diffs in the charter history, and only body-touching ones", async () => {
    await kernel.applyUpdate({ objectId: housekeeper, actor: { entrance: "agent", actorId: "run-evolve" }, now: ago(1), fields: { body: "You are the Housekeeper.\n\n## Lessons\n" }, eventKind: "charter-evolved" } as never);
    await kernel.applyUpdate({ objectId: housekeeper, actor: human.actor, now: ago(1), fields: { title: "Housekeeper v2" }, eventKind: "loop-updated" } as never);
    const value = ok(await views.loopView(housekeeper, human, NOW)) as { charterHistory: { diff: Record<string, unknown> }[] };
    expect(value.charterHistory).toHaveLength(1);
    expect(value.charterHistory[0]!.diff.body).toMatchObject({ old: "You are the Housekeeper.\n" });
  });

  it("refuses a task id with WRONG_KIND rather than a confusing empty page", async () => {
    const board = (await views.tasksView(human, new URLSearchParams(), NOW)) as { ok: true; value: { columns: { tasks: { id: string }[] }[] } };
    const result = await views.loopView(board.value.columns.flatMap((c) => c.tasks)[0]!.id, human, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WRONG_KIND");
  });

  it("is team-scoped and enumeration-safe", async () => {
    const result = await views.loopView(housekeeper, { ...human, teamId: OTHER_TEAM }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("the loop LIST carries cadence, health and current load", async () => {
    const value = ok(await views.loopsView(human, NOW)) as { loops: Record<string, unknown>[] };
    const row = value.loops.find((l) => l.id === housekeeper)!;
    expect(row).toMatchObject({ title: "Housekeeper", status: "active", cronText: "daily 07:00", questionsWaiting: 2 });
    expect(row.openTasks).toBe(2);
  });
});

// --------------------------------------------------------------------- tasks

type BoardValue = {
  columns: { key: string; label: string; rule: string; tasks: Record<string, unknown>[] }[];
  loops: { id: string; title: string | null }[];
  counts: Record<string, number>;
  truncated: boolean;
};
const titlesByColumn = (value: BoardValue) =>
  Object.fromEntries(value.columns.map((c) => [c.key, (c.tasks as { title: string }[]).map((t) => t.title).sort()]));

describe("GET /api/views/tasks — the board, and /task/:id", () => {
  it("puts every task in exactly one column, derived from the kernel's own facts", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    expect(titlesByColumn(value)).toEqual({
      // A question blocks every other move, so it outranks watcher and date.
      waiting: ["Reddit reply to r/selfhosted", "Watch the error rate"],
      // Due-and-unwatched stays in the pool: nobody owns it, so nobody is late.
      unclaimed: ["Draft the pricing FAQ", "Fresh and unwatched", "Nobody asked for this"],
      due: ["Watched and due"],
      watched: ["Adopted from the pool", "Observe the impact of PR #201"],
      closed: ["Already closed"],
    });
    const all = value.columns.flatMap((c) => c.tasks.map((t) => t.id));
    expect(all.length).toBe(9);
    expect(new Set(all).size).toBe(9);
  });

  it("carries the one-sentence rule per column, so the screen never restates the lifecycle", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    expect(value.columns.map((c) => c.key)).toEqual(["waiting", "unclaimed", "due", "watched", "closed"]);
    for (const column of value.columns) expect(column.rule.length).toBeGreaterThan(20);
  });

  it("keeps the §6 safety floor visible from the board, single-sourced with the inbox", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const inbox = ok(await views.inboxView(human, NOW)) as { counts: Record<string, number> };
    expect(value.counts).toEqual(inbox.counts);
  });

  it("offers the loops a card can be claimed for — claim names a loop, never free text", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    expect(value.loops.map((l) => l.id).sort()).toEqual([housekeeper, steward].sort());
  });

  it("narrows on state predicates only, and refuses a filter the board owns as a column", async () => {
    const pool = ok(await views.tasksView(human, new URLSearchParams({ watcher: "none" }), NOW)) as BoardValue;
    expect(titlesByColumn(pool).unclaimed).toEqual(["Draft the pricing FAQ", "Fresh and unwatched", "Nobody asked for this"]);
    expect(titlesByColumn(pool).watched).toEqual([]);

    for (const filter of [["since", "14d"], ["status", "open"], ["question", "true"]] as [string, string][]) {
      const refused = await views.tasksView(human, new URLSearchParams([filter]), NOW);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("UNKNOWN_FILTER");
    }
  });

  it("resolves creator and watcher titles so a card never shows a bare id", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const row = value.columns.flatMap((c) => c.tasks).find((t) => t.title === "Observe the impact of PR #201")!;
    expect(row.creator).toEqual({ id: housekeeper, title: "Housekeeper" });
    expect(row.watcherLoop).toEqual({ id: steward, title: "FollowUp" });
    expect(row.due).toBe(false);
    expect(row.column).toBe("watched");
  });

  it("the detail carries the artifact, the execution payload and the seq-ordered timeline", async () => {
    const board = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const id = (board.columns.find((c) => c.key === "waiting")!.tasks as { id: string; title: string }[]).find((t) => t.title === "Watch the error rate")!.id;
    const value = ok(await views.taskView(id, human, NOW)) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["creator", "cursorSeq", "due", "execution", "runs", "task", "timeline", "watcherLoop"]);
    expect(value.due).toBe(true);
    const timeline = value.timeline as { seq: number; kind: string }[];
    expect(timeline.map((e) => e.kind)).toEqual(["object-created", "object-updated"]);
    expect(timeline[0]!.seq).toBeLessThan(timeline[1]!.seq);
  });
});

// ---------------------------------------------------------------------- docs

describe("GET /api/views/docs and /doc/:id", () => {
  it("lists without inlining bodies, and names the format that picks the render path", async () => {
    const value = ok(await views.docsView(human)) as { docs: Record<string, unknown>[] };
    expect(value.docs.map((d) => d.format).sort()).toEqual(["html", "markdown"]);
    expect(value.docs.every((d) => !("body" in d))).toBe(true);
    expect(value.docs.every((d) => typeof d.bytes === "number")).toBe(true);
  });

  it("serves the html doc's markup untouched — the sandbox is the client's boundary", async () => {
    const list = ok(await views.docsView(human)) as { docs: { id: string; format: string }[] };
    const id = list.docs.find((d) => d.format === "html")!.id;
    const value = ok(await views.docView(id, human)) as { doc: { body: string; format: string } };
    expect(value.doc.format).toBe("html");
    // Deliberately NOT sanitized server-side: it renders in an opaque-origin
    // iframe, and stripping it here would be a second, drifting boundary.
    expect(value.doc.body).toContain("<script>");
  });

  it("refuses a task id on the doc endpoint", async () => {
    const result = await views.docView(housekeeper, human);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WRONG_KIND");
  });
});

// -------------------------------------------------------------- system graph

describe("GET /api/views/system-graph — a projection, never configuration", () => {
  it("always carries the synthetic pool and you nodes, plus one per live loop", async () => {
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { nodes: { id: string; type: string; badges: Record<string, unknown> }[] };
    expect(value.nodes.map((n) => n.type).sort()).toEqual(["loop", "loop", "pool", "you"]);
    const you = value.nodes.find((n) => n.type === "you")!;
    expect(you.badges.questionsWaiting).toBe(2);
    const pool = value.nodes.find((n) => n.type === "pool")!;
    expect(pool.badges.openTasks).toBe(3);
    expect(typeof pool.badges.oldestAgeHours).toBe("number");
    const loop = value.nodes.find((n) => n.id === housekeeper)!;
    expect(loop.badges).toMatchObject({ cadence: "daily 07:00", lastOutcome: "success", openTasks: 2, questionsWaiting: 2 });
  });

  it("derives the flow edges from live rows, including the adoption pair", async () => {
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { edges: { from: string; to: string; kind: string; count: number }[] };
    const kinds = value.edges.map((e) => `${e.from === housekeeper ? "hk" : e.from === steward ? "st" : e.from}→${e.to === steward ? "st" : e.to === housekeeper ? "hk" : e.to}:${e.kind}`);
    expect(kinds).toContain("hk→you:asks");
    expect(kinds).toContain("you→hk:answers");
    expect(kinds).toContain("hk→st:hands-off");
    expect(kinds).toContain("hk→pool:produces");
    expect(kinds).toContain("pool→st:adopts");
  });

  it("windows the counts, and refuses a window outside 1–90 days", async () => {
    const narrow = ok(await views.systemGraphView(human, new URLSearchParams({ days: "1" }), NOW)) as { window: { days: number }; edges: unknown[] };
    const wide = ok(await views.systemGraphView(human, new URLSearchParams({ days: "90" }), NOW)) as { edges: unknown[] };
    expect(narrow.window.days).toBe(1);
    expect(narrow.edges.length).toBeLessThan(wide.edges.length);
    const refused = await views.systemGraphView(human, new URLSearchParams({ days: "0" }), NOW);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("UNKNOWN_FILTER");
  });

  it("drops a retired loop's node — and its shape stays stable at zero work", async () => {
    await kernel.applyTransition({ objectId: steward, transition: "retire", actor: human.actor, now: ago(1) } as never);
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { nodes: { id: string }[]; edges: { to: string }[] };
    expect(value.nodes.map((n) => n.id)).not.toContain(steward);
    expect(value.edges.every((e) => e.to !== steward)).toBe(true);
    expect(value.nodes.filter((n) => ["pool", "you"].includes(n.id))).toHaveLength(2);
  });
});

describe("every view payload carries cursorSeq", () => {
  it("so a stream message already reflected costs no refetch", async () => {
    const payloads = await Promise.all([
      views.inboxView(human, NOW), views.loopsView(human, NOW), views.loopView(housekeeper, human, NOW),
      views.tasksView(human, new URLSearchParams(), NOW), views.docsView(human), views.systemGraphView(human, new URLSearchParams(), NOW),
    ]);
    for (const payload of payloads) {
      expect(payload.ok).toBe(true);
      if (payload.ok) expect(typeof payload.value.cursorSeq).toBe("number");
    }
  });
});
