/**
 * S2 (spec §10) + the 2026-08-12 list rework: the unfiltered `list` tree is a
 * DECISION SURFACE — fully-done subtrees collapse into counted summary lines
 * (`--all` expands; the aggregate tail always counts everything), children
 * render behind `├─`/`└─` guides, rows carry the clipped TITLE plus plain-text
 * tags only ([loop] + humanized cadence, follow-up date, run state, waiting
 * age) — no icons. Depth stays capped at two levels; a child's deeper
 * descendants surface as an inline `+N deeper (show <id>)` suffix, never
 * silently dropped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";
import { formatLocalTime } from "../src/time.js";

describe("list tree (§10 depth cap + done collapse + row grammar)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-tree-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // registryHome/probe isolate `init`'s registry write + PATH seed (test hazard).
  const deps = (): CliDeps => ({ cwd: dir, now: "2026-08-09T12:00:00.000Z", env: {}, registryHome: dir, probe: () => false });
  const call = (argv: string[]) => run(argv, deps());

  it("renders roots + children; deeper descendants surface as an inline suffix", () => {
    call(["init"]);
    // A 3-level tree: root -> child -> grandchild -> great-grandchild.
    call(["create", "Root", "--id", "root"]);
    call(["create", "Child", "--id", "child", "--parent", "root"]);
    call(["create", "Grandchild", "--id", "grandchild", "--parent", "child"]);
    call(["create", "GreatGrand", "--id", "great", "--parent", "grandchild"]);

    const out = call(["list"]);
    expect(out.exitCode).toBe(0);
    // depth 0 + depth 1 are shown; the child connects with a tree guide
    expect(out.stdout).toContain("root");
    expect(out.stdout).toContain("└─ child");
    // depth 2+ (grandchild, great-grandchild) never render as rows — they ride
    // the child's inline suffix with the drill-in command
    expect(out.stdout.split("\n").some((r) => r.trimStart().startsWith("grandchild"))).toBe(false);
    expect(out.stdout.split("\n").some((r) => r.trimStart().startsWith("great"))).toBe(false);
    expect(out.stdout).toContain("+2 deeper (show child)");
    // hidden nodes still count in the aggregate tail (axi: no silent truncation)
    expect(out.stdout).toContain("— 4 tasks: 4 todo");
  });

  it("a shallow tree (<= 2 levels) shows no depth suffix", () => {
    call(["init"]);
    call(["create", "Root", "--id", "root"]);
    call(["create", "Child", "--id", "child", "--parent", "root"]);
    const out = call(["list"]);
    expect(out.stdout).toContain("root");
    expect(out.stdout).toContain("└─ child");
    expect(out.stdout).not.toContain("deeper");
  });

  it("connects children with ├─/└─ guides (last visible child gets └─)", () => {
    call(["init"]);
    call(["create", "Root", "--id", "root"]);
    call(["create", "First", "--id", "first", "--parent", "root"]);
    call(["create", "Second", "--id", "second", "--parent", "root"]);
    const out = call(["list"]).stdout;
    expect(out).toContain("├─ first");
    expect(out).toContain("└─ second");
  });

  // The AI-friendly row (tree-v2 taskLine lineage; sim seo-scale rounds 1-2),
  // reworked 2026-08-12 to plain-text tags: every dispatch-relevant fact rides
  // the row - explicit @— for unassigned (claimability must never render as
  // absence), the [loop] tag + HUMANIZED cadence (kernel cronText), the
  // follow-up DATE, a `run <state>` marker, the TITLE when it says more than
  // the id, and the aggregate tail line.
  it("rows carry title/assignee/[loop]/follow-up/run state; the tree ends with counts", () => {
    call(["init"]);
    call(["create", "Loop", "--id", "loop", "--cron", "0 7 * * 1", "--status", "in-progress", "--assignee", "claude"]);
    call(["create", "Claimable", "--id", "claim-me"]); // todo, unassigned
    call(["create", "Sleeper", "--id", "sleeper", "--follow-up", "2026-09-01T07:00:00.000Z"]);
    call(["create", "Handoff", "--id", "handoff", "--assignee", "claude"]); // mints a pending run

    const out = call(["list"]).stdout;
    // [loop] tag + humanized cadence, never a raw-cron-only row or an icon
    expect(out).toContain("loop  [in-progress] [loop] @claude  ·  Mon 07:00");
    // title shown when it adds information over the id …
    expect(out).toContain("claim-me  [todo] @—  Claimable");
    // … and skipped when the id IS the slugified title (no verbatim repeat)
    expect(out).not.toContain("handoff  [todo] @claude  Handoff");
    expect(out).toContain(`sleeper  [follow-up] @—  ·  follow-up ${formatLocalTime("2026-09-01T07:00:00.000Z")}`);
    expect(out).toContain("handoff  [todo] @claude  ·  run pending");
    expect(out).toContain("— 4 tasks: 2 todo · 1 in-progress · 1 follow-up");
    // the icon vocabulary is retired
    for (const icon of ["⟳", "⏰", "▶", "◇"]) expect(out).not.toContain(icon);
  });

  it("a matured follow-up row marks the date (due)", () => {
    call(["init"]);
    call(["create", "Ripe", "--id", "ripe", "--follow-up", "2026-08-01T07:00:00.000Z"]); // past vs now
    const out = call(["list"]).stdout;
    expect(out).toContain(`follow-up ${formatLocalTime("2026-08-01T07:00:00.000Z")} (due)`);
  });

  it("a stale todo shows its waiting age; a fresh one stays quiet", () => {
    call(["init"]);
    call(["create", "Stale", "--id", "stale-task"]);
    // Same store, later clock: the task is now 2 days untouched.
    const later = run(["list"], { ...deps(), now: "2026-08-11T12:00:00.000Z" });
    expect(later.stdout).toContain("stale-task  [todo] @—  Stale  ·  waiting 2d");
    // At creation time (age 0) the bit is suppressed — "waiting 0m" is noise.
    expect(call(["list"]).stdout).not.toContain("waiting");
  });

  describe("done collapse (the default list is a decision surface)", () => {
    const seed = (): void => {
      call(["init"]);
      call(["create", "Epic", "--id", "epic"]);
      call(["create", "Live one", "--id", "live-one", "--parent", "epic"]);
      call(["create", "Shipped A", "--id", "done-a", "--parent", "epic", "--status", "done"]);
      call(["create", "Shipped B", "--id", "done-b", "--parent", "epic", "--status", "done"]);
      call(["create", "Old epic", "--id", "old-epic", "--status", "done"]);
      call(["create", "Old child", "--id", "old-child", "--parent", "old-epic", "--status", "done"]);
    };

    it("collapses fully-done subtrees into counted summary lines; tail stays full", () => {
      seed();
      const out = call(["list"]).stdout;
      // done children of a live root: one summary line, not N rows
      expect(out.split("\n").some((r) => r.includes("done-a"))).toBe(false);
      expect(out.split("\n").some((r) => r.includes("done-b"))).toBe(false);
      expect(out).toContain("└─ … 2 terminal  (`list --all` shows them)");
      // a fully-done ROOT subtree vanishes into the root-level summary
      expect(out).not.toContain("old-epic");
      expect(out).toContain("… 2 terminal  (`list --all` shows them)");
      // live rows still render; the connector marks the last VISIBLE child ├─
      // because the collapse summary takes the └─ slot
      expect(out).toContain("├─ live-one");
      // the tail counts EVERY task, collapsed included (axi: no silent truncation)
      expect(out).toContain("— 6 tasks: 2 todo · 4 done");
    });

    it("--all expands every collapsed node", () => {
      seed();
      const out = call(["list", "--all"]).stdout;
      expect(out).toContain("done-a");
      expect(out).toContain("done-b");
      expect(out).toContain("old-epic");
      expect(out).toContain("└─ old-child");
      expect(out).not.toContain("shows them");
      expect(out).toContain("— 6 tasks: 2 todo · 4 done");
    });

    it("a done parent with a live descendant stays visible (live work never hides)", () => {
      call(["init"]);
      call(["create", "Done parent", "--id", "done-parent", "--status", "done"]);
      call(["create", "Still open", "--id", "still-open", "--parent", "done-parent"]);
      const out = call(["list"]).stdout;
      expect(out).toContain("done-parent  [done]");
      expect(out).toContain("└─ still-open");
    });
  });

  it("the filtered flat list shares the row grammar (title + assignee survive)", () => {
    call(["init"]);
    call(["create", "Claimable", "--id", "claim-me"]);
    const out = call(["list", "--status", "todo"]).stdout;
    expect(out).toContain("claim-me  [todo] @—  Claimable");
  });
});
