/**
 * `doc put --task` atomic attach + the in-run ambient default (LOOPANY_TASK_ID)
 * + `doc list`. Six sim rounds proved the separate second attach step never
 * happens - the attach must ride the put itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";

describe("doc put --task (atomic attach)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-docattach-"));
    writeFileSync(join(dir, "body.md"), "# portfolio\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (env: Record<string, string> = {}): CliDeps => ({
    cwd: dir,
    now: "2026-08-09T12:00:00.000Z",
    env,
    registryHome: dir,
    probe: () => false,
  });
  const call = (argv: string[], env?: Record<string, string>) => run(argv, deps(env));

  it("--task attaches with a loud echo; a repeat put is idempotent", () => {
    call(["init"]);
    call(["create", "Loop", "--id", "loop"]);
    const out = call(["doc", "put", "portfolio", "--file", "body.md", "--task", "loop"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("attached — loop refs += portfolio");
    expect(call(["show", "loop"]).stdout).toContain("refs: portfolio");

    const again = call(["doc", "put", "portfolio", "--file", "body.md", "--task", "loop"]);
    expect(again.stdout).toContain("already attached");
  });

  it("in-run ambient LOOPANY_TASK_ID fills the attach target; explicit --task wins", () => {
    call(["init"]);
    call(["create", "Loop", "--id", "loop"]);
    call(["create", "Other", "--id", "other"]);
    // Bare put inside a run: ambient attach.
    const ambient = call(["doc", "put", "notes", "--file", "body.md"], { LOOPANY_TASK_ID: "loop" });
    expect(ambient.stdout).toContain("attached — loop refs += notes");
    // Explicit --task overrides the ambient id.
    const explicit = call(
      ["doc", "put", "report", "--file", "body.md", "--task", "other"],
      { LOOPANY_TASK_ID: "loop" },
    );
    expect(explicit.stdout).toContain("attached — other refs += report");
  });

  it("an unknown attach target refuses without writing the doc", () => {
    call(["init"]);
    const out = call(["doc", "put", "p", "--file", "body.md", "--task", "ghost"]);
    expect(out.exitCode).toBe(1);
    expect(call(["show", "p"]).exitCode).not.toBe(0); // doc was not created
  });

  it("mirror add --task attaches; ambient LOOPANY_TASK_ID fills it in-run", () => {
    call(["init"]);
    call(["create", "Triage", "--id", "triage"]);
    const explicit = call(["mirror", "add", "url", "https://x.test/1", "--task", "triage"]);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout).toContain("attached — triage refs +=");
    const ambient = call(["mirror", "add", "url", "https://x.test/2"], { LOOPANY_TASK_ID: "triage" });
    expect(ambient.stdout).toContain("attached — triage refs +=");
    // Out-of-run bare add stays an unattached pointer (owner adds don't guess).
    const bare = call(["mirror", "add", "url", "https://x.test/3"]);
    expect(bare.stdout).not.toContain("refs +=");
    expect(bare.stdout).toContain("unattached — no task refs this mirror");
    expect(call(["show", "triage"]).stdout).toMatch(/refs: m-.*m-/);
  });

  it("mirror list enumerates mirrors; empty state is definitive; add stays idempotent", () => {
    call(["init"]);
    expect(call(["mirror", "list"]).stdout).toContain("(no mirrors)");
    call(["mirror", "add", "github-pr", "superdesigndev/loopany-platform#174"]);
    call(["mirror", "add", "url", "https://example.com/dash"]);
    call(["mirror", "add", "github-pr", "superdesigndev/loopany-platform#174"]); // dup — no-op
    const out = call(["mirror", "list"]).stdout;
    expect(out).toContain("[github-pr]  superdesigndev/loopany-platform#174");
    expect(out).toContain("[url]  https://example.com/dash");
    expect(out.trim().split("\n")).toHaveLength(2); // the duplicate add minted nothing
    const json = JSON.parse(call(["mirror", "list", "--json"]).stdout);
    expect(json).toHaveLength(2);
  });

  it("doc --help / mirror --help short-circuit; the default screen stays lean", () => {
    const doc = call(["doc", "--help"]);
    expect(doc.exitCode).toBe(0);
    expect(doc.stdout).toContain("doc put <key>");
    expect(doc.stdout).toContain("doc list");
    const mirror = call(["mirror", "-h"]);
    expect(mirror.exitCode).toBe(0);
    expect(mirror.stdout).toContain("mirror add <kind> <coords>");
    expect(mirror.stdout).toContain("mirror list");
    // `doc help` (bare word) works too, and never reaches the workspace.
    expect(call(["mirror", "help"]).exitCode).toBe(0);
    // The default screen points at the per-verb help instead of listing subs.
    const top = call(["--help"]).stdout;
    expect(top).toContain("doc --help for the full doc surface");
    expect(top).toContain("mirror --help for the full mirror surface");
    expect(top).not.toMatch(/^\s+doc list/m);
    expect(top).not.toMatch(/^\s+mirror list/m);
  });

  it("doc list enumerates docs; empty state is definitive", () => {
    call(["init"]);
    expect(call(["doc", "list"]).stdout).toContain("(no docs)");
    call(["doc", "put", "portfolio", "--file", "body.md"]);
    call(["doc", "put", "conventions", "--file", "body.md"]);
    const out = call(["doc", "list"]).stdout;
    expect(out).toContain("portfolio  (v1)");
    expect(out).toContain("conventions  (v1)");
  });
});
