/**
 * The RUNNER's tier handling + the haiku identity preflight - all via INJECTED
 * fakes, so no real keychain read, no real claude spawn, no real API call. The
 * replay tier must skip identity entirely; the haiku tier must seed + smoke
 * BEFORE the scenario and fail loud on a bad smoke.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentProfileFor, parseRunnerArgv, runCli, HAIKU_MODEL, type RunnerDeps } from "../src/run.js";
import { snapshotDirFor } from "../src/index.js";

describe("agentProfileFor", () => {
  it("replay -> the replay shim on node", () => {
    const p = agentProfileFor("replay");
    expect(p.cmd).toBe(process.execPath);
    expect(p.args?.[0]).toMatch(/replay-agent\.mjs$/);
  });

  it("haiku -> claude -p with the haiku model + WebFetch/WebSearch disallowed", () => {
    const p = agentProfileFor("haiku");
    expect(p.args).toContain("-p");
    expect(p.args).toContain("{{prompt}}");
    expect(p.args?.[p.args.indexOf("--model") + 1]).toBe(HAIKU_MODEL);
    expect(p.args).toContain("--disallowedTools");
    expect(p.args).toContain("WebFetch");
    expect(p.args).toContain("WebSearch");
  });
});

describe("parseRunnerArgv", () => {
  it("parses scenario + tier + run-id + dir", () => {
    const o = parseRunnerArgv(["mini-w3", "--tier", "haiku", "--run-id", "r1", "--dir", "/tmp/x"]);
    expect(o).toEqual({ scenario: "mini-w3", tier: "haiku", runId: "r1", dir: "/tmp/x" });
  });

  it("defaults tier to replay and derives a run id", () => {
    const o = parseRunnerArgv(["mini-w3"]);
    expect(o.tier).toBe("replay");
    expect(o.runId).toBe("mini-w3-replay");
  });

  it("rejects a bad tier", () => {
    expect(() => parseRunnerArgv(["mini-w3", "--tier", "gpt"])).toThrow(/--tier must be/);
  });
});

describe("runCli haiku preflight (injected fakes)", () => {
  let dir: string;
  const runId = "test-run-preflight";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sim-run-"));
  });

  it("seeds + smokes BEFORE the scenario; a failed smoke throws the fix hint", () => {
    const calls: string[] = [];
    const deps: RunnerDeps = {
      seedIdentity: () => {
        calls.push("seed");
        return { copiedKeys: ["oauthAccount", "userID"] };
      },
      smoke: () => {
        calls.push("smoke");
        return { status: 1, stderr: "auth error" };
      },
      log: () => {},
    };
    expect(() => runCli({ scenario: "mini-w3", tier: "haiku", runId, dir }, deps)).toThrow(
      /identity preflight FAILED[\s\S]*log into Claude Code/,
    );
    // Seed + smoke ran, and the scenario never started (smoke gated it).
    expect(calls).toEqual(["seed", "smoke"]);
  });
});
