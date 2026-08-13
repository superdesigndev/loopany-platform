import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";

describe("workflow CLI", () => {
  let dir: string;
  let deps: CliDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lk-workflow-"));
    deps = {
      cwd: dir,
      now: "2026-08-13T04:00:00.000Z",
      env: { LOOPANY_RUN_ID: "run-author" },
      registryHome: dir,
      probe: () => false,
    };
    expect(run(["init"], deps).exitCode).toBe(0);
    expect(run(["create", "Daily review", "--id", "daily-review"], deps).exitCode).toBe(0);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("validates, sets, shows, and clears loopany-js-v1 through normal Task CAS", () => {
    writeFileSync(join(dir, "workflow.js"), "const n = prev?.n ?? 0;\nreturn { state: { n: n + 1 } };\n");
    expect(run(["workflow", "validate", "--file", "workflow.js"], deps)).toMatchObject({ exitCode: 0 });

    const set = run(["workflow", "set", "daily-review", "--file", "workflow.js", "--if-version", "1"], deps);
    expect(set.exitCode).toBe(0);

    const shown = run(["workflow", "show", "daily-review", "--json"], deps);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      taskId: "daily-review",
      workflow: { format: "loopany-js-v1", source: expect.stringContaining("prev?.n") },
    });

    const clear = run(["workflow", "clear", "daily-review", "--if-version", "2"], deps);
    expect(clear.exitCode).toBe(0);
    expect(JSON.parse(run(["workflow", "show", "daily-review", "--json"], deps).stdout).workflow).toBeNull();
  });

  it("rejects module syntax and requires CAS for mutations", () => {
    writeFileSync(join(dir, "bad.js"), "export default async function run() {}\n");
    const bad = run(["workflow", "validate", "--file", "bad.js"], deps);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("not an ES module");

    const noCas = run(["workflow", "clear", "daily-review"], deps);
    expect(noCas.exitCode).toBe(2);
    expect(noCas.stderr).toContain("requires --if-version");
  });
});
