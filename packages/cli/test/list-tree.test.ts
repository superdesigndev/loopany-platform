/**
 * S2 (spec §10): the unfiltered `list` tree renders at most TWO levels (深度 2)
 * and shows a truncation notice for anything deeper — never silently drops a
 * grandchild.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";

describe("list tree depth cutoff (§10, S2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-tree-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // registryHome/probe isolate `init`'s registry write + PATH seed (test hazard).
  const deps = (): CliDeps => ({ cwd: dir, now: "2026-08-09T12:00:00.000Z", env: {}, registryHome: dir, probe: () => false });
  const call = (argv: string[]) => run(argv, deps());

  it("renders roots + children, truncates grandchildren with a notice", () => {
    call(["init"]);
    // A 3-level tree: root -> child -> grandchild -> great-grandchild.
    call(["create", "Root", "--id", "root"]);
    call(["create", "Child", "--id", "child", "--parent", "root"]);
    call(["create", "Grandchild", "--id", "grandchild", "--parent", "child"]);
    call(["create", "GreatGrand", "--id", "great", "--parent", "grandchild"]);

    const out = call(["list"]);
    expect(out.exitCode).toBe(0);
    // depth 0 + depth 1 are shown
    expect(out.stdout).toContain("root");
    expect(out.stdout).toContain("child");
    // depth 2+ (grandchild, great-grandchild) are NOT rendered as rows
    const rows = out.stdout.split("\n");
    expect(rows.some((r) => r.includes("grandchild") && !r.includes("more"))).toBe(false);
    expect(out.stdout).not.toContain("great");
    // a truncation notice names the count of hidden descendants (2: grandchild + great)
    expect(out.stdout).toContain("2 more");
    expect(out.stdout).toContain("show child");
  });

  it("a shallow tree (<= 2 levels) shows no truncation notice", () => {
    call(["init"]);
    call(["create", "Root", "--id", "root"]);
    call(["create", "Child", "--id", "child", "--parent", "root"]);
    const out = call(["list"]);
    expect(out.stdout).toContain("root");
    expect(out.stdout).toContain("child");
    expect(out.stdout).not.toContain("more");
  });

  // The AI-friendly row (tree-v2 taskLine lineage; sim seo-scale rounds 1-2):
  // every dispatch-relevant fact rides the row - explicit @— for unassigned
  // (claimability must never render as absence), the cron SPEC, the follow-up
  // DATE, an active-run marker, and the aggregate tail line.
  it("rows carry assignee/cron/follow-up/run state; the tree ends with counts", () => {
    call(["init"]);
    call(["create", "Loop", "--id", "loop", "--cron", "0 7 * * 1", "--status", "in-progress", "--assignee", "claude"]);
    call(["create", "Claimable", "--id", "claim-me"]); // todo, unassigned
    call(["create", "Sleeper", "--id", "sleeper", "--follow-up", "2026-09-01T07:00:00.000Z"]);
    call(["create", "Handoff", "--id", "handoff", "--assignee", "claude"]); // mints a pending run

    const out = call(["list"]).stdout;
    expect(out).toContain("loop  [in-progress] @claude  Loop  ·  ⟳ 0 7 * * 1");
    expect(out).toContain("claim-me  [todo] @—  Claimable");
    expect(out).toContain("sleeper  [follow-up] @—  Sleeper  ·  ⏰ 2026-09-01T07:00:00.000Z");
    expect(out).toContain("handoff  [todo] @claude  Handoff  ·  ▶ pending");
    expect(out).toContain("— 4 tasks: 2 todo · 1 in-progress · 1 follow-up");
  });

  it("a matured follow-up row marks the date (due)", () => {
    call(["init"]);
    call(["create", "Ripe", "--id", "ripe", "--follow-up", "2026-08-01T07:00:00.000Z"]); // past vs now
    const out = call(["list"]).stdout;
    expect(out).toContain("⏰ 2026-08-01T07:00:00.000Z (due)");
  });

  it("the filtered flat list keeps assignee + follow-up state", () => {
    call(["init"]);
    call(["create", "Claimable", "--id", "claim-me"]);
    const out = call(["list", "--status", "todo"]).stdout;
    expect(out).toContain("claim-me  [todo] @—  Claimable");
  });
});
