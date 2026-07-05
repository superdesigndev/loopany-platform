/**
 * Dispatch behavior of the CLI entry, run as a real subprocess (the faithful
 * "what does a user typing `loopany …` get" check). Proves the new help/unknown
 * handling does NOT fall through to launching a daemon: each invocation EXITS
 * (the daemon would hang on its poll loop) with the expected code + output.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { daemonVersion } from "./version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, "../node_modules/.bin/tsx");
const entry = path.resolve(here, "cli.ts");

type Run = { code: number; stdout: string; stderr: string };

/** Run the CLI with a clean env (no run token; isolated LOOPANY_HOME). */
function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env = { ...process.env, LOOPANY_HOME: path.join(os.tmpdir(), "loopany-cli-test-home") };
    delete env.LOOPANY_RUN_TOKEN;
    execFile(tsx, [entry, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("loopany CLI dispatch", () => {
  test("--help prints usage and exits 0 (no daemon)", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: loopany");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("down");
    expect(r.stdout).toContain("update");
  });

  test("-h prints usage and exits 0", async () => {
    const r = await runCli(["-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: loopany");
  });

  test("--help leads with the daemon version (reused, not hardcoded)", async () => {
    const version = daemonVersion();
    expect(version).toBeTruthy(); // resolvable from this package's package.json
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`loopany v${version}`);
  });

  test("--version prints just the version and exits 0 (no daemon)", async () => {
    const version = daemonVersion();
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`loopany v${version}`);
    expect(r.stdout).not.toContain("Usage: loopany"); // version only, not the full screen
  });

  test("-v prints the version and exits 0", async () => {
    const version = daemonVersion();
    const r = await runCli(["-v"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`loopany v${version}`);
  });

  test("help (bare verb) prints usage and exits 0", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: loopany");
  });

  test("unknown flag → exits non-zero with hint, does not launch daemon", async () => {
    const r = await runCli(["--frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("--help");
  });

  test("unknown verb → exits non-zero with hint", async () => {
    const r = await runCli(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });

  test("update with no connection → exits (never launches daemon)", async () => {
    // Isolated LOOPANY_HOME has no stored server/token, so update returns 2 with a
    // clear message instead of hanging on a poll loop.
    const r = await runCli(["update"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not connected");
  });
});
