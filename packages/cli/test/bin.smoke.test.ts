/**
 * The DECLARED bin must actually execute under bare `node` — the run()-only
 * E2E cannot catch a broken `bin` entry (a `.js`→`.ts` import that node cannot
 * resolve, a missing build). This drives the real `bin/loopany-kernel.mjs`
 * launcher as a spawned process against a temp workspace: init → create → list.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Keep the path in a VARIABLE — the literal `new URL('./x', import.meta.url)`
// form is statically rewritten by vite into an http asset URL that
// fileURLToPath then rejects (repo-wide guard idiom).
const rel = "../bin/loopany-kernel.mjs";
const binPath = join(dirname(fileURLToPath(import.meta.url)), rel);
const runtimeFixtureRel = "fixtures/kanban-runtime-smoke.ts";
const runtimeFixture = join(dirname(fileURLToPath(import.meta.url)), runtimeFixtureRel);
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

describe("declared bin executes under bare node (process spawn)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-binsmoke-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...argv: string[]) =>
    spawnSync(process.execPath, [binPath, ...argv], {
      cwd: dir,
      encoding: "utf8",
      // Relocate the state dir into the temp workspace so `init`'s auto-register
      // writes an ISOLATED kernel.json, never the real ~/.loopany (test hazard).
      env: { ...process.env, LOOPANY_HOME: join(dir, "state") },
    });

  it("runs init → create → list end to end via the bin launcher", () => {
    const init = run("init");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("initialized");

    const create = run("create", "Smoke test");
    expect(create.status).toBe(0);
    expect(create.stdout).toContain("ok smoke-test");

    const list = run("list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("smoke-test");
  });

  it("propagates a non-zero exit for a usage error", () => {
    const out = run("no-such-verb");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("unknown verb");
  });

  it("refuses kanban when the executable is piped", () => {
    const out = run("kanban");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("requires an interactive TTY");
    expect(out.stderr).not.toContain("NO_WORKSPACE");
  });

  it("prints kanban help without requiring a TTY", () => {
    const out = run("kanban", "--help");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("usage: lk kanban");
    expect(out.stderr).toBe("");
  });

  it("loads and starts the Kanban TSX entry through the real tsx runtime", () => {
    const out = spawnSync(process.execPath, [tsxCli, runtimeFixture], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("kanban runtime loaded");
    expect(out.stderr).not.toContain("React is not defined");
  });
});
