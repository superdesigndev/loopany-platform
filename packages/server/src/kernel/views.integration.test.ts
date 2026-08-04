import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The view endpoints against a real database and a real fixture.
 *
 * Two things are being pinned here and they are different in kind:
 *
 *  1. **Shapes** — a view is a screen's contract, so the keys the screen reads
 *     are asserted explicitly. A missing `execution`, `cursorSeq` or
 *     `watcherLoop` is a broken screen, not a cosmetic diff.
 *  2. **Inbox union correctness** — the §6 safety floor, which is now ONE branch
 *     (a question waiting for a human). The fixture deliberately contains the
 *     NEAR MISSES the retired arms used to catch — a task that is due, and an
 *     old one with no follow-up — because the floor's value is entirely in what
 *     it does and does not surface, and those two must now stay out.
 *
 * EVERY TASK HERE NAMES A WATCHER, because every task does (`types.ts`
 * WATCHER_HINT). Most of them get it by DEFAULT: `make` passes `createdByLoop`,
 * and a loop-created task falls back to its creator — so a fixture line with no
 * `watcher:` is exercising the default, not skipping the field.
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
  await database.db.delete(legacySchema.loops);
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
  // S3 keeps the kernel loop objects for history, but every workspace read is
  // authoritative on the production twin minted by converge-loops.
  await database.db.insert(legacySchema.loops).values([
    {
      id: housekeeper, userId: "u-owner", teamId: TEAM, machineId: "m-1", name: "Housekeeper",
      cron: "0 7 * * *", timezone: "UTC", enabled: true, notify: "auto",
      taskFile: "/w/housekeeper/loopany-task.md", taskFileContent: "# Housekeeper\n\n## Spec\n\nYou are the Housekeeper.\n",
      createdAt: ago(200), updatedAt: ago(10),
    },
    {
      id: steward, userId: "u-owner", teamId: TEAM, machineId: "m-1", name: "FollowUp",
      cron: "30 8 * * *", timezone: "UTC", enabled: true, notify: "auto",
      taskFile: "/w/follow-up/loopany-task.md", taskFileContent: "# FollowUp\n\n## Spec\n\nYou sweep the pool.\n",
      createdAt: ago(200), updatedAt: ago(10),
    },
  ] as never);

  // Life 1 — fully automatic: watched, due later, never asks. Not in the inbox.
  await make({ kind: "task", title: "Observe the impact of PR #201", createdByLoop: housekeeper, watcher: steward, followUpAt: ahead(24) });
  // Life 2 — born gated: created WITH a question, watcher = its creator.
  await make({ kind: "task", title: "Reddit reply to r/selfhosted", createdByLoop: housekeeper, watcher: housekeeper, pendingQuestion: "post as drafted, or soften the pitch?", payload: { draft: "We built this because…", subreddit: "selfhosted" } });
  // Life 3 — acquires a question: automatic until an anomaly. Applied below.
  const anomaly = await make({ kind: "task", title: "Watch the error rate", createdByLoop: housekeeper, watcher: housekeeper, followUpAt: ago(1) });
  await kernel.applyUpdate({ objectId: anomaly.id, actor: { entrance: "agent", actorId: "run-triage" }, now: ago(2), fields: { pendingQuestion: "error rate doubled — (a) revert (b) one more day" } } as never);

  // NEAR MISSES — what the two RETIRED inbox arms used to catch. Both are now
  // ordinary watched work: the due one wakes its loop, the old one waits for
  // that loop's cadence. Neither may reach a person.
  await make({ kind: "task", title: "Draft the pricing FAQ", createdByLoop: housekeeper, followUpAt: ago(3) }); // was due+unwatched
  await make({ kind: "task", title: "Filed and quiet", createdByLoop: housekeeper, now: ago(72) }); // was the orphan floor
  await make({ kind: "task", title: "Watched and due", createdByLoop: housekeeper, watcher: steward, followUpAt: ago(3) });
  await make({ kind: "task", title: "Freshly filed", createdByLoop: housekeeper, now: ago(1) });
  const closed = await make({ kind: "task", title: "Already closed", createdByLoop: housekeeper, now: ago(96) });
  await kernel.applyTransition({ objectId: closed.id, transition: "close", actor: human.actor, now: ago(90), note: "done" } as never);

  // A HAND-OFF: filed by the Housekeeper (so it defaulted onto its own desk),
  // transferred to the steward later. The one flow edge between two loops.
  const handed = await make({ kind: "task", title: "Handed to FollowUp", createdByLoop: housekeeper, now: ago(30) });
  await kernel.applyUpdate({ objectId: handed.id, actor: { entrance: "agent", actorId: "run-sweep" }, now: ago(20), fields: { watcher: steward } } as never);

  // Another team's task must never appear in this team's screens.
  const foreign = await kernel.createObject({ teamId: OTHER_TEAM, kind: "task", actor: { entrance: "human", actorId: "u-other" }, now: ago(96), title: "Not yours", pendingQuestion: "?", watcher: "loop-elsewhere" } as never);
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
  it("surfaces the questions and nothing else", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string }; reasons: string[] }[]; counts: Record<string, number> };
    expect(value.items.map((i) => i.task.title).sort()).toEqual([
      "Reddit reply to r/selfhosted", "Watch the error rate",
    ]);
    expect(value.counts).toEqual({ question: 2, total: 2 });
  });

  /**
   * The two RETIRED arms, pinned as near misses. A due task and an old
   * follow-up-less one both used to reach a person; now the first wakes its
   * watcher and the second waits for that loop's cadence. If either reappears
   * here, the watcher rule has been half-undone.
   */
  it("keeps out what the retired due-unwatched and orphan arms used to catch", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string } }[] };
    const titles = value.items.map((i) => i.task.title);
    for (const quiet of ["Draft the pricing FAQ", "Filed and quiet", "Watched and due", "Freshly filed", "Already closed", "Observe the impact of PR #201"]) {
      expect(titles).not.toContain(quiet);
    }
  });

  it("is team-scoped: another team's question is invisible", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { task: { title: string } }[] };
    expect(value.items.map((i) => i.task.title)).not.toContain("Not yours");
  });

  it("gives every row the one reason there is", async () => {
    const value = ok(await views.inboxView(human, NOW)) as { items: { reasons: string[] }[] };
    expect(value.items.length).toBeGreaterThan(0);
    for (const item of value.items) expect(item.reasons).toEqual(["question"]);
  });

  // Age used to be a route in (the 48h orphan floor). It is not one any more:
  // an old task is somebody's work, not an escalation waiting to happen.
  it("never surfaces a task on AGE alone, however old it gets", async () => {
    const later = ok(await views.inboxView(human, new Date(NOW.getTime() + 400 * 3_600_000))) as { items: { task: { title: string } }[] };
    expect(later.items.map((i) => i.task.title).sort()).toEqual(["Reddit reply to r/selfhosted", "Watch the error rate"]);
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
    expect(item.creator).toEqual({ id: housekeeper, title: "Housekeeper", source: "prod" });
    expect(item.watcherLoop).toEqual({ id: housekeeper, title: "Housekeeper", source: "prod" });
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
    expect(Object.keys(value).sort()).toEqual(["charterHistory", "cursorSeq", "events", "health", "loop", "mirrors", "openTasks", "recentRuns"]);
    const loop = value.loop as Record<string, unknown>;
    expect(loop.cronText).toBe("daily 07:00");
    expect(loop.body).toBe("# Housekeeper\n\n## Spec\n\nYou are the Housekeeper.\n");
    expect(value.health).toMatchObject({ lastOutcome: "success", consecutiveFailures: 0, runs7d: { success: 1, failure: 1 } });
    const open = value.openTasks as { watching: { title: string }[]; created: { title: string }[]; questions: { title: string }[] };
    // Everything it filed and did not hand on — the default put them here.
    expect(open.watching.map((t) => t.title).sort()).toEqual([
      "Draft the pricing FAQ", "Filed and quiet", "Freshly filed", "Reddit reply to r/selfhosted", "Watch the error rate",
    ]);
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
    expect(row.openTasks).toBe(5);
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
      // A question blocks every other move, so it outranks the date.
      waiting: ["Reddit reply to r/selfhosted", "Watch the error rate"],
      // What was the unclaimed pool is now split by the only fact left: the date.
      due: ["Draft the pricing FAQ", "Watched and due"],
      watched: ["Filed and quiet", "Freshly filed", "Handed to FollowUp", "Observe the impact of PR #201"],
      closed: ["Already closed"],
    });
    const all = value.columns.flatMap((c) => c.tasks.map((t) => t.id));
    expect(all.length).toBe(9);
    expect(new Set(all).size).toBe(9);
  });

  it("carries the one-sentence rule per column, so the screen never restates the lifecycle", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    expect(value.columns.map((c) => c.key)).toEqual(["waiting", "due", "watched", "closed"]);
    for (const column of value.columns) expect(column.rule.length).toBeGreaterThan(20);
  });

  it("keeps the §6 safety floor visible from the board, single-sourced with the inbox", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const inbox = ok(await views.inboxView(human, NOW)) as { counts: Record<string, number> };
    expect(value.counts).toEqual(inbox.counts);
  });

  it("offers the loops a task can be handed to — a hand-off names a loop, never free text", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    expect(value.loops.map((l) => l.id).sort()).toEqual([housekeeper, steward].sort());
  });

  it("narrows on state predicates only, and refuses a filter the board owns as a column", async () => {
    const stewards = ok(await views.tasksView(human, new URLSearchParams({ watcher: steward }), NOW)) as BoardValue;
    expect(titlesByColumn(stewards)).toEqual({
      waiting: [], due: ["Watched and due"], watched: ["Handed to FollowUp", "Observe the impact of PR #201"], closed: [],
    });

    for (const filter of [["since", "14d"], ["status", "open"], ["question", "true"]] as [string, string][]) {
      const refused = await views.tasksView(human, new URLSearchParams([filter]), NOW);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("UNKNOWN_FILTER");
    }
  });

  it("resolves creator and watcher titles so a card never shows a bare id", async () => {
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const row = value.columns.flatMap((c) => c.tasks).find((t) => t.title === "Observe the impact of PR #201")!;
    expect(row.creator).toEqual({ id: housekeeper, title: "Housekeeper", source: "prod" });
    expect(row.watcherLoop).toEqual({ id: steward, title: "FollowUp", source: "prod" });
    expect(row.due).toBe(false);
    expect(row.column).toBe("watched");
  });

  it("the detail carries the artifact, the execution payload and the seq-ordered timeline", async () => {
    const board = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const id = (board.columns.find((c) => c.key === "waiting")!.tasks as { id: string; title: string }[]).find((t) => t.title === "Watch the error rate")!.id;
    const value = ok(await views.taskView(id, human, NOW)) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["creator", "cursorSeq", "due", "execution", "mirrors", "runs", "task", "timeline", "watcherLoop"]);
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
  it("always carries the synthetic you node, plus one per live loop — and no pool", async () => {
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { nodes: { id: string; type: string; badges: Record<string, unknown> }[] };
    expect(value.nodes.map((n) => n.type).sort()).toEqual(["loop", "loop", "you"]);
    const you = value.nodes.find((n) => n.type === "you")!;
    expect(you.badges.questionsWaiting).toBe(2);
    // The pool node stood for the unclaimed state and retired with it.
    expect(value.nodes.some((n) => n.id === "pool")).toBe(false);
    const loop = value.nodes.find((n) => n.id === housekeeper)!;
    expect(loop.badges).toMatchObject({ cadence: "daily 07:00", lastOutcome: "success", openTasks: 5, questionsWaiting: 2 });
  });

  it("derives the flow edges from live rows — hand-offs and questions, nothing through a pool", async () => {
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { edges: { from: string; to: string; kind: string; count: number }[] };
    const kinds = value.edges.map((e) => `${e.from === housekeeper ? "hk" : e.from === steward ? "st" : e.from}→${e.to === steward ? "st" : e.to === housekeeper ? "hk" : e.to}:${e.kind}`);
    expect(kinds).toContain("hk→you:asks");
    expect(kinds).toContain("you→hk:answers");
    expect(kinds).toContain("hk→st:hands-off");
    // `produces` and `adopts` described flows THROUGH the pool; both are gone.
    expect(value.edges.every((e) => e.from !== "pool" && e.to !== "pool")).toBe(true);
    expect(value.edges.map((e) => e.kind)).not.toContain("produces");
    expect(value.edges.map((e) => e.kind)).not.toContain("adopts");
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

  it("drops a completed production loop's node — and its shape stays stable at zero work", async () => {
    await database.db.update(legacySchema.loops).set({ goal: "done", completedAt: ago(1), enabled: false }).where(eq(legacySchema.loops.id, steward));
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as { nodes: { id: string }[]; edges: { to: string }[] };
    expect(value.nodes.map((n) => n.id)).not.toContain(steward);
    expect(value.edges.every((e) => e.to !== steward)).toBe(true);
    expect(value.nodes.filter((n) => n.id === "you")).toHaveLength(1);
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

// ------------------------------------------- convergence S1: prod loop refs

/**
 * CONVERGENCE STAGE S1 — a task's `watcher` may name the SHIPPING product's
 * `loops` row, and every screen has to read it as a loop rather than as an
 * unresolvable string.
 *
 * The production id is used AS-IS (there is no alias table and no rewrite), so
 * these cases feed the real id shape a prod loop mints and assert the reference
 * resolves through the ONE resolver (`kernel/loopRefs.ts`) on each surface the
 * design report names: grouping/card labels, the hand-off picker, the system
 * graph's nodes and edges, and the loop page.
 *
 * The fourth case is the one the design deliberately keeps LEGAL rather than
 * refusing: a prod loop that was hard-deleted while a task still named it. There
 * is no foreign key, nothing cascades, and the read renders a TOMBSTONE — which
 * is a fact about the world, not a broken row.
 */
describe("convergence S1 — a watcher that names a production loop", () => {
  const PROD_LOOP = "loop-mqkxn6lq-4c81d1b2";

  async function insertProdLoop(over: Record<string, unknown> = {}) {
    await database.db.insert(legacySchema.loops).values({
      id: PROD_LOOP, userId: "u-owner", teamId: TEAM, machineId: "m-1", name: "React Doctor",
      cron: "0 6 * * *", timezone: "Asia/Shanghai", enabled: true, notify: "auto",
      taskFile: "/w/react-doctor/loopany-task.md", taskFileContent: "## Spec\n\nTriage react-doctor findings.\n",
      createdAt: ago(300), updatedAt: ago(10), ...over,
    } as never);
  }

  async function watchedByProd(fields: Record<string, unknown> = {}) {
    return make({ kind: "task", title: "Prod-watched work", createdByLoop: housekeeper, watcher: PROD_LOOP, now: ago(6), ...fields });
  }

  it("resolves the card's watcher to the production loop's NAME, tagged as prod", async () => {
    await insertProdLoop();
    await watchedByProd();
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const row = value.columns.flatMap((c) => c.tasks).find((t) => t.title === "Prod-watched work")!;
    expect(row.watcherLoop).toEqual({ id: PROD_LOOP, title: "React Doctor", source: "prod" });
    // The grouped list keys on `watcher` and labels from `watcherLoop`, so a
    // resolved reference is exactly what makes a group heading read as a desk.
    expect(row.watcher).toBe(PROD_LOOP);
  });

  it("offers it in the hand-off picker — enabled or not, since a paused loop still acts on resume", async () => {
    await insertProdLoop({ enabled: false });
    await watchedByProd();
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue & { loops: { id: string; title: string | null }[] };
    expect(value.loops).toContainEqual({ id: PROD_LOOP, title: "React Doctor" });
    // …but a COMPLETED loop has declared itself done; handing it work is how a
    // task goes quiet forever, so it is not a target.
    await database.db.delete(legacySchema.loops);
    await insertProdLoop({ goal: "ship it", completedAt: ago(2) });
    const after = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue & { loops: { id: string }[] };
    expect(after.loops.some((l) => l.id === PROD_LOOP)).toBe(false);
  });

  it("gives the system graph a node for it, so the hand-off edge is drawn", async () => {
    await insertProdLoop();
    await watchedByProd();
    const value = ok(await views.systemGraphView(human, new URLSearchParams(), NOW)) as {
      nodes: { id: string; label: string | null; badges: Record<string, unknown> }[];
      edges: { from: string; to: string; kind: string }[];
    };
    const node = value.nodes.find((n) => n.id === PROD_LOOP);
    expect(node?.label).toBe("React Doctor");
    expect(node?.badges).toMatchObject({ cadence: "daily 06:00", openTasks: 1 });
    expect(value.edges).toContainEqual(expect.objectContaining({ from: housekeeper, to: PROD_LOOP, kind: "hands-off" }));
  });

  it("serves its loop PAGE from the production row — task file as the body, its own tasks", async () => {
    await insertProdLoop();
    await watchedByProd();
    const value = ok(await views.loopView(PROD_LOOP, human, NOW)) as {
      loop: Record<string, unknown>; openTasks: { watching: { title: string }[] }; health: { lastOutcome: string | null };
    };
    expect(value.loop).toMatchObject({
      id: PROD_LOOP, title: "React Doctor", status: "active", cron: "0 6 * * *",
      timezone: "Asia/Shanghai", source: "prod",
    });
    // The standing brief lives in the task file's `## Spec`, mirrored on the
    // loop row — that is what a prod loop has where a kernel loop has a charter.
    expect(value.loop.body).toContain("Triage react-doctor findings.");
    expect(value.openTasks.watching.map((t) => t.title)).toEqual(["Prod-watched work"]);
    // Runs are ONE table already, so health needs no bridging.
    await database.db.insert(legacySchema.runs).values({
      id: "run-prod", loopId: PROD_LOOP, userId: "u-owner", machineId: "m-1", phase: "done", role: "exec",
      ts: ago(2), startedAt: ago(2), finishedAt: ago(2), costUsd: 0.3,
    } as never);
    const withRun = ok(await views.loopView(PROD_LOOP, human, NOW)) as { health: { lastOutcome: string | null } };
    expect(withRun.health.lastOutcome).toBe("success");
  });

  it("keeps the production twin authoritative, and never crosses a team", async () => {
    await database.db.update(legacySchema.loops).set({ name: "A prod twin of the kernel id" }).where(eq(legacySchema.loops.id, housekeeper));
    const value = ok(await views.loopView(housekeeper, human, NOW)) as { loop: { title: string; source: string } };
    expect(value.loop).toMatchObject({ title: "A prod twin of the kernel id", source: "prod" });
    await database.db.delete(legacySchema.loops);
    await insertProdLoop({ teamId: OTHER_TEAM });
    const foreign = await views.loopView(PROD_LOOP, human, NOW);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("NOT_FOUND");
  });

  it("renders a TOMBSTONE when the watched loop was deleted, never a null watcher", async () => {
    await insertProdLoop();
    await watchedByProd();
    await database.db.delete(legacySchema.loops);
    const value = ok(await views.tasksView(human, new URLSearchParams(), NOW)) as BoardValue;
    const row = value.columns.flatMap((c) => c.tasks).find((t) => t.title === "Prod-watched work")!;
    // `null` would read as "no watcher", a state the watcher rule abolished.
    expect(row.watcherLoop).toEqual({ id: PROD_LOOP, title: null, source: "missing" });
    expect(row.watcher).toBe(PROD_LOOP);
    // Nothing cascaded: the task is untouched and still open.
    expect(row.status).toBe("open");
  });
});
