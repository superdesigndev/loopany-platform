import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PROBE SUITE — THE SEVEN VERBS against a REAL pglite database and the SHIPPED
 * type specs.
 *
 * What each group is actually pinning:
 *
 *   IDEMPOTENCY     every verb run twice writes one row. This is the property the
 *                   work orders rely on when they tell a run "if in doubt, run it
 *                   again", and the one that fails silently if it breaks - twins
 *                   look like activity, not like a bug.
 *   GUIDANCE        a refusal carries the way out (captain decision 15b): the
 *                   legal transitions, the available presets, the open waits.
 *   WAITS           decisions 13 + 14: a wait names its watcher at creation, a
 *                   watcher answers it, "not yet" renews, and a recurrence
 *                   reopens it AND raises attention.
 *   DOMAIN NEUTRAL  decision 17: `mirror track` registers any external thing by
 *                   source and id, and a foreign domain rides the same review
 *                   with prose in a field and no platform code.
 *   ONE SURFACE     decision 16: the same verb called with a HUMAN actor writes
 *                   the same shape with different provenance.
 */

let tmp: string;
let graph: typeof import("../../db/graphStore.js");
let verbs: typeof import("./verbs.js");
let cli: typeof import("./cli.js");
let attention: typeof import("../outbox/attention.js");
let exec: typeof import("../outbox/executor.js");
let specs: typeof import("../workspace/specs.js");
let at: typeof import("../applyTransition.js");

const NOW = "2026-07-31T09:00:00.000Z";
const LATER = "2026-07-31T15:00:00.000Z";
const RUN = "run-probe-1";

/** One isolated world per probe: its own team, the builtins plus every shipped
 *  type, armed the way the seed arms them. */
async function world(name: string): Promise<string> {
  const teamId = `team-verbs-${name}`;
  await graph.seedBuiltinTypes(undefined, teamId, NOW);
  for (const t of specs.DEMO_TYPES) {
    await graph.proposeTypeVersion(undefined, {
      teamId,
      name: t.name,
      archetype: t.archetype,
      version: 1,
      spec: t.spec,
      rationale: t.rationale,
      now: NOW,
    });
    await graph.armTypeVersion(undefined, { teamId, name: t.name, version: 1, now: NOW });
  }
  return teamId;
}

const asRun = (teamId: string, subjectId?: string, actorId = RUN): import("./verbs.js").VerbContext => ({
  teamId,
  actor: { entrance: "agent-run", actorId },
  ...(subjectId ? { subjectId } : {}),
  now: NOW,
});

const asHuman = (teamId: string): import("./verbs.js").VerbContext => ({
  teamId,
  actor: { entrance: "human", actorId: "u-probe" },
  now: NOW,
});

/** A live loop to hang work off - and, for the wait probes, to NAME AS A WATCHER. */
async function loop(teamId: string, title = "Probe loop") {
  const object = await graph.createObject(undefined, {
    teamId,
    archetype: "task",
    type: "loop",
    status: "planned",
    title,
    payload: { role: "discovery", workflow: "Look, write it up, ask." },
    now: NOW,
  });
  const activated = await at.applyTransition({
    objectId: object.id,
    transition: "activate",
    actor: { entrance: "human", actorId: "u-probe" },
    now: NOW,
  });
  if (!activated.ok) throw new Error(`probe could not activate: ${activated.code}`);
  return (await graph.getObject(undefined, object.id))!;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-verbs-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  delete process.env.DATABASE_URL;

  const dbmod = await import("../../db/index.js");
  await dbmod.runMigrations();
  graph = await import("../../db/graphStore.js");
  verbs = await import("./verbs.js");
  cli = await import("./cli.js");
  attention = await import("../outbox/attention.js");
  exec = await import("../outbox/executor.js");
  specs = await import("../workspace/specs.js");
  at = await import("../applyTransition.js");
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 1 — a retry is never a twin
// ─────────────────────────────────────────────────────────────────────────────

describe("probe: every verb is idempotent", () => {
  it("task create twice from one run is ONE task", async () => {
    const team = await world("idem-task");
    const ctx = asRun(team);
    const first = await verbs.taskCreate(ctx, { type: "task", title: "Fix the empty export" });
    const second = await verbs.taskCreate(ctx, { type: "task", title: "Fix the empty export" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.objectId).toBe(first.data.objectId);
    expect(second.replay).toBe(true);
    expect((await graph.listObjects(undefined, team, { type: "task" })).length).toBe(1);
  }, 120_000);

  it("artifact push keys on the CONTENT, so the same bytes are one product", async () => {
    const team = await world("idem-artifact");
    const owner = await loop(team);
    const ctx = asRun(team, owner.id);
    const body = "# Report\n\nthree empty exports\n";
    const a = await verbs.artifactPush(ctx, { body, title: "Export watch" });
    const b = await verbs.artifactPush(ctx, { body, title: "Export watch" });
    expect(a.ok && b.ok && b.data.objectId === a.data.objectId).toBe(true);
    // DIFFERENT bytes are a different product - a revised report is a new one,
    // which is what `--replaces` is for.
    const c = await verbs.artifactPush(ctx, { body: `${body}and a fourth\n`, title: "Export watch" });
    expect(c.ok && c.data.objectId !== (a.ok ? a.data.objectId : "")).toBe(true);
  }, 120_000);

  it("task move twice is one event, and `--replaces` supersedes rather than deletes", async () => {
    const team = await world("idem-move");
    const ctx = asRun(team);
    const created = await verbs.taskCreate(ctx, { type: "task", title: "Move me" });
    if (!created.ok) throw new Error("setup");
    const id = String(created.data.objectId);

    const first = await verbs.taskMove(ctx, { objectId: id, transition: "start" });
    const again = await verbs.taskMove(ctx, { objectId: id, transition: "start" });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.replay).toBe(true);
    const events = (await graph.listObjectEvents(undefined, id)).filter((e) => e.transition === "start");
    expect(events).toHaveLength(1);

    const owner = await loop(team, "Replacer");
    const octx = asRun(team, owner.id);
    const v1 = await verbs.artifactPush(octx, { body: "v1\n", title: "Doc" });
    if (!v1.ok) throw new Error("setup");
    const v2 = await verbs.artifactPush(octx, { body: "v2\n", title: "Doc", replacesId: String(v1.data.objectId) });
    expect(v2.ok).toBe(true);
    const old = (await graph.getObject(undefined, String(v1.data.objectId)))!;
    // The superseded artifact SAYS SO on itself, so a reader looking at the old
    // one learns there is a newer one without walking the edge table.
    expect((old.payload as Record<string, unknown>).supersededBy).toBe(v2.ok ? v2.data.objectId : null);
  }, 120_000);

  it("mirror track converges on one row per external thing", async () => {
    const team = await world("idem-mirror");
    const ctx = asRun(team);
    const a = await verbs.mirrorTrack(ctx, { ref: "https://github.com/acme/widgets/pull/9" });
    const b = await verbs.mirrorTrack(ctx, { ref: "https://github.com/acme/widgets/pull/9" });
    expect(a.ok && b.ok && a.data.objectId === b.data.objectId).toBe(true);
    expect(b.ok && b.data.created).toBe(false);
    expect((await graph.listMirrors(undefined, team, { externalSource: "github" })).length).toBe(1);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 2 — a refusal hands back the way out
// ─────────────────────────────────────────────────────────────────────────────

describe("probe: a refusal is actionable", () => {
  it("an illegal move returns the transitions that ARE legal, plus the open gates", async () => {
    const team = await world("refusal-move");
    const ctx = asRun(team);
    const created = await verbs.taskCreate(ctx, { type: "task", title: "Guard me" });
    if (!created.ok) throw new Error("setup");
    const id = String(created.data.objectId);

    // `complete` is legal only from `in-progress`; this task is `open`.
    const refused = await verbs.taskMove(ctx, { objectId: id, transition: "complete" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("ILLEGAL_FROM_STATE");
    // THE WAY OUT (decision 15b).
    expect(refused.allowed).toContain("start");
    expect(refused.allowed).toContain("block");
    expect(refused.allowed).not.toContain("complete");
    expect(refused.data?.status).toBe("open");
  }, 120_000);

  it("an unknown type lists the types that exist, and an unknown preset the presets", async () => {
    const team = await world("refusal-type");
    const ctx = asRun(team);
    const badType = await verbs.taskCreate(ctx, { type: "issue", title: "nope" });
    expect(badType.ok).toBe(false);
    if (!badType.ok) {
      expect(badType.code).toBe("UNKNOWN_TYPE");
      expect(badType.allowed).toContain("task");
      expect(badType.allowed).toContain("review");
    }

    const badPreset = await verbs.reviewRequest(ctx, { question: "well?", preset: "merge-request" });
    expect(badPreset.ok).toBe(false);
    if (!badPreset.ok) {
      expect(badPreset.code).toBe("UNKNOWN_PRESET");
      expect(badPreset.allowed).toEqual(expect.arrayContaining(["merge", "publish", "decision", "dispatch"]));
    }
  }, 120_000);

  it("a doc type is refused as a task, with the honest reason", async () => {
    const team = await world("refusal-doc");
    const refused = await verbs.taskCreate(asRun(team), { type: "report", title: "not work" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("NOT_A_TASK");
      expect(refused.message).toContain("artifact push");
    }
  }, 120_000);

  it("renders the refusal with the allowed list in the TEXT a run reads", async () => {
    const team = await world("refusal-text");
    const ctx = { ...asRun(team), role: "fix", unfenced: false };
    const created = await verbs.taskCreate(asRun(team), { type: "task", title: "Render me" });
    if (!created.ok) throw new Error("setup");
    const out = await cli.graphCli(ctx, ["task", "move", String(created.data.objectId), "complete"]);
    expect(out.exitCode).toBe(1);
    expect(out.text).toContain("code: ILLEGAL_FROM_STATE");
    expect(out.text).toContain("allowed[");
    expect(out.text).toContain("start");
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 3 — waits: named watcher, agent answer, recurrence
// ─────────────────────────────────────────────────────────────────────────────

describe("probe: a wait names its watcher and an agent answers it", () => {
  it("refuses a wait whose watcher can never look again", async () => {
    const team = await world("wait-watcher");
    const owner = await loop(team);
    const ctx = asRun(team, owner.id);
    const target = await verbs.taskCreate(ctx, { type: "task", title: "Watched thing" });
    if (!target.ok) throw new Error("setup");

    const missing = await verbs.waitOpen(ctx, {
      objectId: String(target.data.objectId),
      key: "verify",
      question: "is it still quiet?",
      watcherId: "obj-nobody",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("NOT_FOUND");

    // A TERMINAL watcher is the interesting refusal: the row would look watched
    // and never be answered - exactly the "unwatched debt" decision 13 names.
    const dead = await verbs.taskCreate(ctx, { type: "task", title: "Finished watcher", key: "dead" });
    if (!dead.ok) throw new Error("setup");
    await verbs.taskMove(ctx, { objectId: String(dead.data.objectId), transition: "cancel" });
    const refused = await verbs.waitOpen(ctx, {
      objectId: String(target.data.objectId),
      key: "verify",
      question: "is it still quiet?",
      watcherId: String(dead.data.objectId),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("WATCHER_UNAVAILABLE");
  }, 120_000);

  it("records the watcher and the question on the row, and answers close it", async () => {
    const team = await world("wait-answer");
    const owner = await loop(team);
    const ctx = asRun(team, owner.id);
    const target = await verbs.taskCreate(ctx, { type: "task", title: "Regression" });
    if (!target.ok) throw new Error("setup");
    const id = String(target.data.objectId);

    const opened = await verbs.waitOpen(ctx, {
      objectId: id,
      key: "verify-fix",
      question: "does signature X still appear? report a count",
      watcherId: owner.id,
    });
    expect(opened.ok).toBe(true);
    const row = (await graph.getObligation(undefined, id, "verify-fix"))!;
    expect(row.class).toBe("external-wait");
    expect(row.watcherObjectId).toBe(owner.id);
    expect(row.question).toContain("signature X");

    // NOT YET is an ordinary answer: the wait renews, the kernel counts nothing
    // (decision 14 - the windowed judgment lives in the watcher's head).
    const notYet = await verbs.waitAnswer(ctx, {
      objectId: id,
      key: "verify-fix",
      met: false,
      evidence: "2 occurrences in the last 24h",
    });
    expect(notYet.ok && notYet.data.state).toBe("still open");
    expect((await graph.getObligation(undefined, id, "verify-fix"))!.closedByEvent).toBeNull();

    const met = await verbs.waitAnswer({ ...ctx, now: LATER }, {
      objectId: id,
      key: "verify-fix",
      met: true,
      evidence: "0 occurrences across three sweeps",
    });
    expect(met.ok && met.data.state).toBe("closed");
    const closed = (await graph.getObligation(undefined, id, "verify-fix"))!;
    expect(closed.closedByEvent).toBeTruthy();
    // THE ANSWER IS THE EVIDENCE (decision 13), on the closing event.
    const event = (await graph.getEvent(undefined, closed.closedByEvent!))!;
    expect((event.payload as Record<string, unknown>).evidence).toContain("0 occurrences");
    expect(event.entrance).toBe("agent-run");
    expect(event.actorId).toBe(RUN);
  }, 120_000);

  it("a RECURRENCE reopens the wait and raises an attention item", async () => {
    const team = await world("wait-recurrence");
    const owner = await loop(team);
    const ctx = asRun(team, owner.id);
    const target = await verbs.taskCreate(ctx, { type: "task", title: "Recurring thing" });
    if (!target.ok) throw new Error("setup");
    const id = String(target.data.objectId);

    await verbs.waitOpen(ctx, { objectId: id, key: "verify-fix", question: "still gone?", watcherId: owner.id });
    await verbs.waitAnswer(ctx, { objectId: id, key: "verify-fix", met: true, evidence: "zero for three days" });

    const back = await verbs.waitAnswer({ ...ctx, now: LATER }, {
      objectId: id,
      key: "verify-fix",
      met: false,
      evidence: "it is back: 4 occurrences this morning",
    });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.data.recurrence).toBe(true);
    expect(back.data.state).toBe("REOPENED");
    // The watcher KEEPS WATCHING…
    expect((await graph.getObligation(undefined, id, "verify-fix"))!.closedByEvent).toBeNull();
    // …and a person is told, which re-watching alone could never do.
    const view = await attention.attentionView(team);
    const item = view.items.find((i) => i.kind === "wait-recurrence");
    expect(item).toBeDefined();
    expect(item!.reason).toBe("WAIT_RECURRENCE");
    expect(item!.detail).toContain("come back");
    expect(view.counts["wait-recurrence"]).toBe(1);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 4 — domain neutrality (captain decision 17)
// ─────────────────────────────────────────────────────────────────────────────

describe("probe: the verbs know nothing about GitHub", () => {
  it("registers any external thing by source and id", async () => {
    const team = await world("neutral-mirror");
    const ctx = asRun(team);

    const pr = await verbs.mirrorTrack(ctx, { ref: "https://github.com/acme/widgets/pull/12" });
    expect(pr.ok && pr.data.source).toBe("github");
    // The EARNED accelerator gets the type its sensing sweep understands…
    expect(pr.ok && (await graph.getObject(undefined, String(pr.data.objectId)))!.type).toBe("pull-request");

    // …and everything else rides the domain-neutral path with no platform code.
    const reddit = await verbs.mirrorTrack(ctx, { ref: "reddit:r/programming/comments/abc123" });
    expect(reddit.ok && reddit.data.source).toBe("reddit");
    expect(reddit.ok && (await graph.getObject(undefined, String(reddit.data.objectId)))!.type).toBe("mirror");

    const page = await verbs.mirrorTrack(ctx, { ref: "https://loopany.ai/templates/seo-try-keywords" });
    expect(page.ok && page.data.source).toBe("loopany.ai");

    const explicit = await verbs.mirrorTrack(ctx, { source: "search-console", externalId: "query/agent-loops" });
    expect(explicit.ok && explicit.data.externalId).toBe("search-console/query/agent-loops");

    const nonsense = await verbs.mirrorTrack(ctx, { ref: "just some words" });
    expect(nonsense.ok).toBe(false);
  }, 120_000);

  it("carries a FOREIGN domain end to end: a drafted post, a review, an approved agent effect", async () => {
    // THE NON-GITHUB CHAIN. Nothing below is a special case: the same review type,
    // the same verbs, and the domain lives entirely in prose the instance carries.
    const team = await world("neutral-chain");
    const owner = await loop(team, "Reddit Brief");
    const ctx = asRun(team, owner.id);

    // 1. the run drafts a post and pushes it as an ordinary product
    const draft = await verbs.artifactPush(ctx, {
      body: "---\ntype: post\ntitle: What we learned running 40 agent loops\n---\n\nDraft body.\n",
      filename: "reddit-draft.md",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect((await graph.getObject(undefined, String(draft.data.objectId)))!.type).toBe("post");

    // 2. it asks a person, and says what an approval should CAUSE - in prose.
    const asked = await verbs.reviewRequest(ctx, {
      aboutId: String(draft.data.objectId),
      preset: "dispatch",
      question: "Post this to r/programming?",
      fields: {
        consequence:
          "Post the approved draft to r/programming as a DRY RUN: write exactly what you would post to " +
          "reddit-post.txt in the workdir and report it. Do not call Reddit.",
        workdir: "reddit-brief",
      },
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    const reviewId = String(asked.data.objectId);
    // ONE type, whatever the domain (decision 16).
    expect((await graph.getObject(undefined, reviewId))!.type).toBe(specs.REVIEW_TYPE);
    expect(asked.data.verdictTransition).toBe("dispatch");

    // 3. a person says go. The consequence is a GENERIC agent work order.
    const approved = await at.applyTransition({
      objectId: reviewId,
      transition: "dispatch",
      actor: { entrance: "human", actorId: "u-probe" },
      now: LATER,
    });
    expect(approved.ok && approved.object.status).toBe("dispatched");
    await exec.drainOutbox({ now: LATER, teamId: team, maxPasses: 8 });

    const directives = (await graph.listDirectives(undefined, team, 50)).filter((d) => d.objectId === reviewId);
    expect(directives).toHaveLength(1);
    const order = directives[0]!;
    expect(order.kind).toBe("run-task");
    // The work order carries the DOMAIN as instance data, and the platform never
    // learned what Reddit is.
    const payload = order.payload as Record<string, unknown>;
    const context = payload.context as Record<string, unknown>;
    expect(JSON.stringify(context.object)).toContain("r/programming");
    expect(String(payload.intent)).toContain("context.object");
    // …and there is no Reddit anywhere in the platform's own declaration.
    expect(String(payload.intent).toLowerCase()).not.toContain("reddit");
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBE 5 — one surface, two actors (captain decision 16)
// ─────────────────────────────────────────────────────────────────────────────

describe("probe: a person and a run use the same verbs", () => {
  it("writes the same shape with different provenance", async () => {
    const team = await world("one-surface");
    const byRun = await verbs.taskCreate(asRun(team), { type: "task", title: "Same shape" });
    const byHuman = await verbs.taskCreate(asHuman(team), { type: "task", title: "Same shape" });
    expect(byRun.ok && byHuman.ok).toBe(true);
    if (!byRun.ok || !byHuman.ok) return;
    // DIFFERENT objects - the actor is part of the identity, so two people asking
    // for the same thing get two tasks, while one asking twice gets one.
    expect(byHuman.data.objectId).not.toBe(byRun.data.objectId);

    const runObject = (await graph.getObject(undefined, String(byRun.data.objectId)))!;
    const humanObject = (await graph.getObject(undefined, String(byHuman.data.objectId)))!;
    expect(humanObject.type).toBe(runObject.type);
    expect(humanObject.status).toBe(runObject.status);

    const runEvent = (await graph.listObjectEvents(undefined, runObject.id))[0]!;
    const humanEvent = (await graph.listObjectEvents(undefined, humanObject.id))[0]!;
    expect(runEvent.entrance).toBe("agent-run");
    expect(humanEvent.entrance).toBe("human");
    // Same kind of row, told apart by ONE column - which is the whole claim.
    expect(humanEvent.kind).toBe(runEvent.kind);
  }, 120_000);

  it("does not fence a person, and fences a run", async () => {
    const team = await world("one-surface-fence");
    const person = await cli.graphCli({ ...asHuman(team), unfenced: true }, ["wait", "answer", "--help"]);
    expect(person.exitCode).toBe(0);
    const run = await cli.graphCli({ ...asRun(team), role: "discovery" }, ["wait", "answer", "x", "y", "--met", "--evidence", "z"]);
    expect(run.exitCode).toBe(1);
    expect(run.text).toContain("FORBIDDEN");
  }, 120_000);
});
