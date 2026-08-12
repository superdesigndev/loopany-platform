import { describe, expect, it } from "vitest";
import {
  type Command,
  type Decision,
  type Provenance,
  type Snapshot,
  decide,
  emptyWorld,
  onceTriggerId,
  type World,
} from "../src/index.js";
import { foldToWorld } from "../src/apply.js"; // internal fold — not a public export (A1)

const HUMAN: Provenance = { entrance: "human", actorId: "u-tim" };
const AGENT: Provenance = { entrance: "agent-run", actorId: "run-1", sessionId: "5f3a" };
const T0 = "2026-08-09T07:00:00.000Z";
const T1 = "2026-08-09T08:00:00.000Z";

function run(world: World, cmd: Command, actor = HUMAN, now = T0): { world: World; d: Decision } {
  const d = decide(cmd, world.snapshot, actor, now);
  return { world: d.ok ? foldToWorld(world, d.changeset) : world, d };
}

function seed(...cmds: Command[]): World {
  let world = emptyWorld();
  for (const cmd of cmds) {
    const d = decide(cmd, world.snapshot, HUMAN, T0);
    if (!d.ok) throw new Error(`seed refused: ${d.refusal.message}`);
    world = foldToWorld(world, d.changeset);
  }
  return world;
}

function task(s: Snapshot, id: string) {
  const o = s.objects[id];
  if (o?.archetype !== "task") throw new Error(`not a task: ${id}`);
  return o;
}

describe("create", () => {
  it("slugs the id from the title, defaults status=todo, emits created", () => {
    const { world, d } = run(emptyWorld(), { op: "create", title: "Fix Login Flow" });
    expect(d.ok && d.result?.id).toBe("fix-login-flow");
    expect(task(world.snapshot, "fix-login-flow").status).toBe("todo");
    expect(world.events).toHaveLength(1);
    expect(world.events[0]).toMatchObject({ kind: "created", provenance: HUMAN });
  });

  it("refuses a duplicate id", () => {
    const w = seed({ op: "create", title: "a" });
    const { d } = run(w, { op: "create", title: "a" });
    expect(!d.ok && d.refusal.code).toBe("CONFLICT");
  });

  it("--follow-up implies status=follow-up and arms the once slot", () => {
    const { world, d } = run(emptyWorld(), { op: "create", title: "bet", followUpAt: T1 });
    expect(d.ok).toBe(true);
    const t = task(world.snapshot, "bet");
    expect(t.status).toBe("follow-up");
    expect(t.followUpAt).toBe(T1);
    expect(world.snapshot.triggers).toMatchObject([{ kind: "once", spec: T1, enabled: true }]);
  });

  it("refuses follow-up without a date (invariant #1)", () => {
    const { d } = run(emptyWorld(), { op: "create", title: "x", status: "follow-up" });
    expect(!d.ok && d.refusal.code).toBe("FOLLOWUP_NEEDS_DATE");
  });

  it("refuses followUpAt on a non-waiting status (invariant #1 reverse)", () => {
    const { d } = run(emptyWorld(), { op: "create", title: "x", status: "todo", followUpAt: T1 });
    expect(!d.ok && d.refusal.code).toBe("FOLLOWUP_NEEDS_DATE");
  });

  it("--cron arms a trigger and notices the loop birth", () => {
    const { world, d } = run(emptyWorld(), { op: "create", title: "react doctor", cron: "0 7 * * *", status: "in-progress" });
    expect(d.ok && d.notices.join()).toContain("loop");
    const trg = world.snapshot.triggers[0];
    expect(trg).toMatchObject({ kind: "cron", spec: "0 7 * * *", enabled: true });
    expect(trg.nextFireAt && Date.parse(trg.nextFireAt)).toBeGreaterThan(Date.parse(T0));
  });

  it("refuses an invalid cron", () => {
    const { d } = run(emptyWorld(), { op: "create", title: "x", cron: "not a cron" });
    expect(!d.ok && d.refusal.code).toBe("INVALID_CRON");
  });

  it("todo + agent assignee dispatches an assignment run at birth", () => {
    const { world } = run(emptyWorld(), { op: "create", title: "x", assignee: "mbp/claude" });
    expect(world.snapshot.runs).toMatchObject([
      { cause: "assignment", state: "pending", assignee: "mbp/claude" },
    ]);
  });

  it("a person assignee never dispatches", () => {
    const { world } = run(emptyWorld(), { op: "create", title: "x", assignee: "tim@x.com" });
    expect(world.snapshot.runs).toHaveLength(0);
  });

  it("validates parent and tracks targets", () => {
    const w = seed({ op: "create", title: "root" }, { op: "doc-put", key: "spec", body: "b" });
    expect(run(w, { op: "create", title: "c", parent: "ghost" }).d.ok).toBe(false);
    expect(run(w, { op: "create", title: "c", parent: "spec" }).d.ok).toBe(false); // doc as parent
    expect(run(w, { op: "create", title: "c", tracks: "root" }).d.ok).toBe(false); // task as tracks
    expect(run(w, { op: "create", title: "c", parent: "root", tracks: "spec" }).d.ok).toBe(true);
  });

  it("unknown type/priority warn (soft) but store verbatim", () => {
    const { world, d } = run(emptyWorld(), { op: "create", title: "x", type: "epic", priority: "P7" });
    // Two soft-vocabulary warnings + the dispatch-consequence echo.
    expect(d.ok && d.notices.filter((n) => !n.includes("CLAIMED"))).toHaveLength(2);
    expect(task(world.snapshot, "x")).toMatchObject({ type: "epic", priority: "P7" });
  });

  // The dispatch-consequence echo (sim seo-scale round 2: a handoff task minted
  // with a sloppy status stranded the pull-mode consumer for three silent weeks
  // - the producer must SEE what its create armed). One notice per create, no
  // cron duplication (cron keeps its own "armed cron" notice).
  it("create echoes the dispatch consequence", () => {
    const notice = (cmd: Command): string[] => {
      const { d } = run(emptyWorld(), cmd);
      if (!d.ok) throw new Error("refused");
      return d.notices;
    };
    // todo + dispatchable assignee -> a run was minted.
    expect(notice({ op: "create", title: "a", assignee: "claude" }).join()).toContain(
      "dispatching — @claude runs this at the next tick",
    );
    // todo + unassigned -> waits to be claimed (the pull-mode contract).
    expect(notice({ op: "create", title: "b" }).join()).toContain("waits to be CLAIMED");
    // follow-up -> sleeps until the date.
    expect(notice({ op: "create", title: "c", followUpAt: T1 }).join()).toContain(
      `sleeps until ${T1}`,
    );
    // person assignee (email) -> inbox, never dispatched.
    expect(notice({ op: "create", title: "d", assignee: "tim@x.co" }).join()).toContain(
      "a person — dispatch never targets an inbox",
    );
    // non-todo without cron -> inert, stated loudly (the round-2 trap).
    expect(notice({ op: "create", title: "e", status: "in-progress" }).join()).toContain(
      'inert — no trigger armed; a "in-progress" task is never dispatched',
    );
    // cron -> ONLY the armed-cron notice (no duplicate dispatch echo).
    const cronNotices = notice({ op: "create", title: "f", cron: "0 7 * * 1", status: "in-progress", assignee: "claude" });
    expect(cronNotices.join()).toContain("armed cron");
    expect(cronNotices.join()).not.toContain("inert");
  });
});

describe("update", () => {
  it("free transition any->any, one status-changed event with diff", () => {
    const w = seed({ op: "create", title: "x", status: "idea" });
    const { world, d } = run(w, { op: "update", id: "x", patch: { status: "done" }, note: "shipped" }, AGENT);
    expect(d.ok).toBe(true);
    expect(task(world.snapshot, "x").status).toBe("done");
    const evt = world.events.at(-1);
    expect(evt).toMatchObject({
      kind: "status-changed",
      note: "shipped",
      diff: { status: { old: "idea", new: "done" } },
      provenance: { entrance: "agent-run", actorId: "run-1", sessionId: "5f3a" },
    });
  });

  it("refuses unknown fields listing the editable set", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { milestone: "y" } });
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_FIELD");
    expect(!d.ok && d.refusal.issues?.[0]).toContain("status");
  });

  it("CAS: ifVersion mismatch refuses CONFLICT", () => {
    const w = seed({ op: "create", title: "x" });
    const { d } = run(w, { op: "update", id: "x", patch: { title: "y" }, ifVersion: 9 });
    expect(!d.ok && d.refusal.code).toBe("CONFLICT");
  });

  it("terminal entry pauses the cron (disabledBy=invariant) and supersedes the pending run", () => {
    const w = seed({ op: "create", title: "loop", cron: "0 7 * * *", assignee: "claude" });
    expect(w.snapshot.runs).toHaveLength(1); // assignment dispatch at birth
    const { world, d } = run(w, { op: "update", id: "loop", patch: { status: "done" } });
    expect(d.ok && d.notices.join()).toContain("paused cron");
    expect(world.snapshot.triggers[0]).toMatchObject({ enabled: false, disabledBy: "invariant" });
    expect(world.snapshot.runs[0].state).toBe("superseded");
  });

  it("assignee handoff supersedes the stale pending run and re-dispatches (haiku-4)", () => {
    // Born todo@tim: an assignment run toward tim is minted (the kernel cannot
    // know tim is a person - the run is his inbox marker, never spawned).
    const w = seed({ op: "create", title: "risk", assignee: "tim" });
    expect(w.snapshot.runs).toMatchObject([{ state: "pending", assignee: "tim" }]);
    // tim hands it back LATER (T1 - a same-instant handoff would collide with
    // the birth run's hash id, the documented dispatch-dedup): the stale run is
    // superseded, a fresh one targets claude.
    const { world, d } = run(w, { op: "update", id: "risk", patch: { assignee: "claude" } }, HUMAN, T1);
    expect(d.ok && d.notices.join()).toContain("re-dispatched");
    expect(world.snapshot.runs.map((r) => `${r.assignee}:${r.state}`).sort()).toEqual([
      "claude:pending",
      "tim:superseded",
    ]);
  });

  it("an unrelated update never re-mints or supersedes the pending run", () => {
    const w = seed({ op: "create", title: "risk", assignee: "tim" });
    const { world, d } = run(w, { op: "update", id: "risk", patch: { title: "risk v2" } });
    expect(d.ok).toBe(true);
    expect(world.snapshot.runs).toMatchObject([{ state: "pending", assignee: "tim" }]);
  });

  it("reassignment with NO open run still dispatches to the new assignee", () => {
    const w = seed({ op: "create", title: "risk" }); // unassigned - no run at birth
    expect(w.snapshot.runs).toHaveLength(0);
    const { world, d } = run(w, { op: "update", id: "risk", patch: { assignee: "claude" } });
    expect(d.ok).toBe(true);
    expect(world.snapshot.runs).toMatchObject([{ state: "pending", assignee: "claude", cause: "assignment" }]);
  });

  it("leaving terminal re-arms invariant-paused triggers loudly (#2', no zombie loops)", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *" });
    w = run(w, { op: "update", id: "loop", patch: { status: "done" } }).world;
    const { world, d } = run(w, { op: "update", id: "loop", patch: { status: "todo" } }, HUMAN, T1);
    expect(d.ok && d.notices.join()).toContain('re-armed cron "0 7 * * *"');
    expect(world.snapshot.triggers[0]).toMatchObject({ enabled: true, disabledBy: null });
    expect(Date.parse(world.snapshot.triggers[0].nextFireAt as string)).toBeGreaterThan(Date.parse(T1));
  });

  it("an owner-disarmed cron is NOT auto-revived", () => {
    let w = seed({ op: "create", title: "loop", cron: "0 7 * * *" });
    w = run(w, { op: "update", id: "loop", patch: { cron: null } }).world;
    expect(w.snapshot.triggers).toHaveLength(0);
    w = run(w, { op: "update", id: "loop", patch: { status: "done" } }).world;
    const { world } = run(w, { op: "update", id: "loop", patch: { status: "todo" } });
    expect(world.snapshot.triggers).toHaveLength(0);
  });

  it("followUpAt is a single replace-on-write slot (#3: the value IS the generation)", () => {
    let w = seed({ op: "create", title: "bet", followUpAt: T1 });
    const later = "2026-08-12T07:00:00.000Z";
    w = run(w, { op: "update", id: "bet", patch: { followUpAt: later } }).world;
    expect(w.snapshot.triggers).toMatchObject([{ id: onceTriggerId("bet"), spec: later }]);
  });

  it("leaving follow-up clears the slot and deletes the once trigger", () => {
    const w = seed({ op: "create", title: "bet", followUpAt: T1 });
    const { world } = run(w, { op: "update", id: "bet", patch: { status: "todo" } });
    expect(task(world.snapshot, "bet").followUpAt).toBeNull();
    expect(world.snapshot.triggers).toHaveLength(0);
  });

  it("parent cycle (incl. self) is refused", () => {
    let w = seed({ op: "create", title: "a" }, { op: "create", title: "b", parent: "a" });
    expect(run(w, { op: "update", id: "a", patch: { parent: "a" } }).d).toMatchObject({
      ok: false,
      refusal: { code: "PARENT_CYCLE" },
    });
    expect(run(w, { op: "update", id: "a", patch: { parent: "b" } }).d).toMatchObject({
      ok: false,
      refusal: { code: "PARENT_CYCLE" },
    });
  });

  it("becoming todo+agent dispatches once; already-eligible edits do not re-dispatch", () => {
    let w = seed({ op: "create", title: "x", status: "idea" });
    w = run(w, { op: "update", id: "x", patch: { assignee: "claude", status: "todo" } }).world;
    expect(w.snapshot.runs).toHaveLength(1);
    const { world } = run(w, { op: "update", id: "x", patch: { title: "renamed" } });
    expect(world.snapshot.runs).toHaveLength(1); // no second dispatch
  });

  it("reassigning person->agent on a todo task dispatches (the answered/handoff path)", () => {
    let w = seed({ op: "create", title: "q", assignee: "tim@x.com" });
    const { world } = run(w, { op: "update", id: "q", patch: { assignee: "claude" }, note: "改一下命名" });
    expect(world.snapshot.runs).toMatchObject([{ cause: "assignment", assignee: "claude" }]);
    expect(world.events.at(-1)).toMatchObject({ kind: "assignee-changed", note: "改一下命名" });
  });
});

describe("note / doc / mirror / run / delete", () => {
  it("note appends one event and bumps the version", () => {
    const w = seed({ op: "create", title: "x" });
    const { world } = run(w, { op: "note", id: "x", note: "day1: imp 3" }, AGENT);
    expect(world.events.at(-1)).toMatchObject({ kind: "note", note: "day1: imp 3" });
    expect(task(world.snapshot, "x").version).toBe(2);
  });

  it("a structured observation rides the note", () => {
    const w = seed({ op: "create", title: "x" });
    const obs = { observedAt: T0, sourceRevision: "abc123", facts: { imp: 41 } };
    const { world } = run(w, { op: "note", id: "x", note: "day6", observation: obs }, AGENT);
    expect(world.events.at(-1)).toMatchObject({ kind: "observation", observation: obs });
  });

  it("doc put is an upsert with CAS", () => {
    let w = seed({ op: "doc-put", key: "seo-bet-ledger", body: "v1" });
    const { world, d } = run(w, { op: "doc-put", key: "seo-bet-ledger", body: "v2" });
    expect(d.ok && d.result).toMatchObject({ existing: true });
    const doc = world.snapshot.objects["seo-bet-ledger"];
    expect(doc).toMatchObject({ archetype: "doc", body: "v2", version: 2 });
    const stale = run(world, { op: "doc-put", key: "seo-bet-ledger", body: "v3", ifVersion: 1 });
    expect(!stale.d.ok && stale.d.refusal.code).toBe("CONFLICT");
  });

  it("doc put with ifVersion:0 is a must-not-exist create — passes when absent, CONFLICTs when present", () => {
    // The remote driver's create-only `doc put` carries ifVersion:0 so the SERVER
    // enforces must-not-exist over the TOCTOU wipe window (no client lock at the
    // authority). Pin both branches: an ABSENT doc passes (0 vs no existing
    // version), and an existing doc CONFLICTs (its version can never be 0).
    const first = run(emptyWorld(), { op: "doc-put", key: "brief", body: "b1", ifVersion: 0 });
    expect(first.d.ok).toBe(true);
    expect(first.d.ok && first.d.result).toMatchObject({ id: "brief", existing: false });
    expect(first.world.snapshot.objects["brief"]).toMatchObject({ body: "b1", version: 1 });
    // A concurrent creator "won" the key: a second ifVersion:0 put must refuse
    // rather than wipe the body written under it.
    const raced = run(first.world, { op: "doc-put", key: "brief", body: "", ifVersion: 0 });
    expect(!raced.d.ok && raced.d.refusal.code).toBe("CONFLICT");
    // The first body is untouched.
    expect(raced.world.snapshot.objects["brief"]).toMatchObject({ body: "b1", version: 1 });
  });

  it("doc append is atomic, requires exact CAS, and separates entries", () => {
    const first = run(emptyWorld(), { op: "doc-put", key: "diary", body: "# Diary\n\nDay one.\n" });
    const appended = run(first.world, {
      op: "doc-append",
      key: "diary",
      body: "Day two.\n",
      ifVersion: 1,
    });
    expect(appended.d.ok).toBe(true);
    expect(appended.world.snapshot.objects.diary).toMatchObject({
      body: "# Diary\n\nDay one.\n\nDay two.\n",
      version: 2,
    });

    // A transport retry carries the old token and cannot duplicate Day two.
    const retry = run(appended.world, {
      op: "doc-append",
      key: "diary",
      body: "Day two.\n",
      ifVersion: 1,
    });
    expect(!retry.d.ok && retry.d.refusal.code).toBe("CONFLICT");
    expect(retry.world.snapshot.objects.diary).toMatchObject({
      body: "# Diary\n\nDay one.\n\nDay two.\n",
      version: 2,
    });
  });

  it("warns when an assignee matches a Task id instead of an executor address", () => {
    const parent = seed({ op: "create", title: "SEO loop", id: "seo-loop", status: "in-progress" });
    const created = run(parent, {
      op: "create",
      title: "Child",
      id: "child",
      assignee: "seo-loop",
      status: "todo",
    });
    expect(created.d.ok && created.d.notices.join("\n")).toContain('assignee "seo-loop" matches an existing Task id');
    expect(created.d.ok && created.d.notices.join("\n")).toContain("parent=seo-loop");

    const other = run(created.world, { op: "create", title: "Other", id: "other" });
    const updated = run(other.world, {
      op: "update",
      id: "other",
      patch: { assignee: "seo-loop", status: "todo" },
    });
    expect(updated.d.ok && updated.d.notices.join("\n")).toContain('assignee "seo-loop" matches an existing Task id');
  });

  it("mirror add is get-or-create on (kind, coords); unknown kind is a hard refusal", () => {
    const { world, d } = run(emptyWorld(), { op: "mirror-add", kind: "github-pr", coords: "app#482" });
    expect(d.ok && d.result?.existing).toBe(false);
    const again = run(world, { op: "mirror-add", kind: "github-pr", coords: "app#482" });
    expect(again.d.ok && again.d.result?.existing).toBe(true);
    expect(again.world.events).toHaveLength(1); // no second event
    const bad = run(world, { op: "mirror-add", kind: "jira", coords: "X-1" });
    expect(!bad.d.ok && bad.d.refusal.code).toBe("BAD_MIRROR_KIND");
  });

  it("mirror add attachTask appends to refs atomically; a dedup hit still attaches", () => {
    let w = seed({ op: "create", title: "Triage", id: "triage" });
    // Create + attach in one decision.
    const first = run(w, { op: "mirror-add", kind: "url", coords: "https://x.test/9912", attachTask: "triage" });
    expect(first.d.ok).toBe(true);
    const mid = first.d.ok ? (first.d.result as { id: string }).id : "";
    expect((first.world.snapshot.objects["triage"] as unknown as { refs: string[] }).refs).toContain(mid);
    expect(first.d.ok && first.d.notices.join()).toContain(`attached — triage refs += ${mid}`);
    // Repeat: mirror dedups AND the attach is idempotent (no version churn).
    const again = run(first.world, { op: "mirror-add", kind: "url", coords: "https://x.test/9912", attachTask: "triage" });
    expect(again.d.ok && again.d.notices.join()).toContain("already attached");
    expect((again.world.snapshot.objects["triage"] as unknown as { version: number }).version).toBe(
      (first.world.snapshot.objects["triage"] as unknown as { version: number }).version,
    );
    // Dedup hit on an EXISTING mirror still creates the missing edge.
    w = run(w, { op: "mirror-add", kind: "url", coords: "https://x.test/9912" }).world; // island first
    const late = run(w, { op: "mirror-add", kind: "url", coords: "https://x.test/9912", attachTask: "triage" });
    expect(late.d.ok && late.d.result?.existing).toBe(true);
    expect((late.world.snapshot.objects["triage"] as unknown as { refs: string[] }).refs).toContain(mid);
    // An unknown attach target refuses without minting the mirror.
    const bad = run(emptyWorld(), { op: "mirror-add", kind: "url", coords: "https://y.test/1", attachTask: "ghost" });
    expect(!bad.d.ok && bad.d.refusal.code).toBe("UNKNOWN_OBJECT");
  });

  it("an unattached doc/mirror warns loudly; a linked one stays quiet", () => {
    const w = seed({ op: "create", title: "Triage", id: "triage" });
    // Island doc: no attachTask, nothing refs it -> the warning notice.
    const island = run(w, { op: "doc-put", key: "orphan", body: "b" });
    expect(island.d.ok && island.d.notices.join()).toContain("unattached — no task refs this doc");
    // Island mirror: same.
    const mIsland = run(w, { op: "mirror-add", kind: "url", coords: "https://x.test/7" });
    expect(mIsland.d.ok && mIsland.d.notices.join()).toContain("unattached — no task refs this mirror");
    // Attached at write time -> no warning.
    const linked = run(w, { op: "doc-put", key: "window", body: "b", attachTask: "triage" });
    expect(linked.d.ok && linked.d.notices.join()).not.toContain("unattached");
    // A REPLACE of a doc some task already refs stays quiet (not an island).
    const replaced = run(linked.world, { op: "doc-put", key: "window", body: "b2" });
    expect(replaced.d.ok && replaced.d.notices.join()).not.toContain("unattached");
  });

  it("manual run needs an agent assignee and no active run", () => {
    let w = seed({ op: "create", title: "x", assignee: "tim@x.com" });
    expect(run(w, { op: "run", id: "x" }).d.ok).toBe(false);
    w = run(w, { op: "update", id: "x", patch: { assignee: "claude" } }).world;
    expect(w.snapshot.runs).toHaveLength(1); // assignment dispatch already
    const { d } = run(w, { op: "run", id: "x" });
    expect(!d.ok && d.refusal.code).toBe("RUN_ACTIVE");
  });

  it("delete teaches archived (#invariant 3)", () => {
    const { d } = run(seed({ op: "create", title: "x" }), { op: "delete", id: "x" });
    expect(!d.ok && d.refusal.code).toBe("DELETE_TAUGHT");
    expect(!d.ok && d.refusal.hint).toContain("archived");
  });
});

describe("doc put --task (atomic attach)", () => {
  it("derives title at the authority from the first H1 and clears it with the H1", () => {
    const first = run(emptyWorld(), {
      op: "doc-put",
      key: "report",
      body: "```md\n# Example only\n```\n\n# Real report #\n",
      title: "stale client title",
    });
    expect(first.world.snapshot.objects.report).toMatchObject({ title: "Real report" });
    const second = run(first.world, { op: "doc-put", key: "report", body: "No heading.\n" });
    expect(second.world.snapshot.objects.report).toMatchObject({ title: null });
  });

  it("appends the doc id to the task's refs with a fields-changed event, idempotently", () => {
    const w = seed({ op: "create", title: "loop", id: "loop" } as Command);
    const r1 = run(w, { op: "doc-put", key: "portfolio", body: "v1", attachTask: "loop" });
    expect(r1.d.ok).toBe(true);
    expect(r1.d.ok && r1.d.notices.join()).toContain("attached — loop refs += portfolio");
    expect(task(r1.world.snapshot, "loop").refs).toEqual(["portfolio"]);
    // The attach leaves an event on the TASK's log (visibility on both sides).
    const taskEvents = r1.world.events.filter((e) => e.objectId === "loop");
    expect(taskEvents.some((e) => e.kind === "fields-changed" && e.note === 'doc "portfolio" attached')).toBe(true);

    // Second put: doc updates, attach is a no-op (no duplicate ref, no event).
    const r2 = run(r1.world, { op: "doc-put", key: "portfolio", body: "v2", attachTask: "loop" });
    expect(r2.d.ok && r2.d.notices.join()).toContain("already attached");
    expect(task(r2.world.snapshot, "loop").refs).toEqual(["portfolio"]);
  });

  it("refuses an unknown attach target BEFORE writing the doc", () => {
    const { world, d } = run(emptyWorld(), { op: "doc-put", key: "p", body: "x", attachTask: "ghost" });
    expect(!d.ok && d.refusal.code).toBe("UNKNOWN_OBJECT");
    expect(world.snapshot.objects["p"]).toBeUndefined(); // fail whole, not half
  });
});

describe("owner + workdir (the executable-task quartet)", () => {
  it("create stores owner (email) and an ABSOLUTE workdir; both are editable + evented", () => {
    const { world, d } = run(emptyWorld(), {
      op: "create", title: "seo loop", id: "seo",
      owner: "tim@superdesign.dev", workdir: "/Users/tim/work/superdesign",
    });
    expect(d.ok).toBe(true);
    expect(task(world.snapshot, "seo")).toMatchObject({
      owner: "tim@superdesign.dev",
      workdir: "/Users/tim/work/superdesign",
    });
    const { world: w2 } = run(world, { op: "update", id: "seo", patch: { workdir: "/srv/checkout" } });
    expect(task(w2.snapshot, "seo").workdir).toBe("/srv/checkout");
    const evt = w2.events.at(-1);
    expect(evt).toMatchObject({ kind: "fields-changed" });
    expect(evt?.diff?.workdir).toEqual({ old: "/Users/tim/work/superdesign", new: "/srv/checkout" });
  });

  it("refuses a relative or traversing workdir on create AND update", () => {
    expect(run(emptyWorld(), { op: "create", title: "x", workdir: "seo/" }).d.ok).toBe(false);
    expect(run(emptyWorld(), { op: "create", title: "x", workdir: "/a/../b" }).d.ok).toBe(false);
    const w = seed({ op: "create", title: "y" });
    const { d } = run(w, { op: "update", id: "y", patch: { workdir: "relative/path" } });
    expect(!d.ok && d.refusal.code).toBe("INVALID_REFERENCE");
  });
});
