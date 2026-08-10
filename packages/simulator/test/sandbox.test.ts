/**
 * SANDBOX unit - the env is an EXPLICIT allowlist (no ambient process.env leak),
 * and createSandbox produces a --no-register workspace whose config carries the
 * scenario's profiles.
 */

import { readProfiles } from "@loopany/cli";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEnv, createSandbox, kernelBinPath } from "../src/index.js";

describe("buildEnv (allowlist only)", () => {
  it("carries only PATH/HOME/LOOPANY_KERNEL_BIN - no ambient leakage", () => {
    // Poison the ambient env: it MUST NOT appear in the built env.
    const marker = "SIM_POISON_MARKER";
    process.env[marker] = "leaked";
    process.env.LOOPANY_STRAY = "should-not-appear";
    try {
      const env = buildEnv("/fake/home");
      expect(env.HOME).toBe("/fake/home");
      expect(env.PATH).toBe(process.env.PATH ?? "");
      expect(env.LOOPANY_KERNEL_BIN).toBe(kernelBinPath());
      expect(env[marker]).toBeUndefined();
      expect(env.LOOPANY_STRAY).toBeUndefined();
      // The allowlist is exactly these three keys (plus any extraEnv).
      expect(Object.keys(env).sort()).toEqual(["HOME", "LOOPANY_KERNEL_BIN", "PATH"]);
    } finally {
      delete process.env[marker];
      delete process.env.LOOPANY_STRAY;
    }
  });

  it("extraEnv layers on top of the allowlist", () => {
    const env = buildEnv("/fake/home", { CLAUDE_CONFIG_DIR: "/x", LOOPANY_REPLAY_SCRIPT: "/s.json" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/x");
    expect(env.LOOPANY_REPLAY_SCRIPT).toBe("/s.json");
    expect(env.HOME).toBe("/fake/home");
  });
});

describe("createSandbox", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-sandbox-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("inits a --no-register workspace and writes the scenario profiles", () => {
    const profiles = { replay: { cmd: "node", args: ["/shim.mjs"] } };
    const sandbox = createSandbox({ dir: root, profiles }, "2026-01-01T00:00:00.000Z");
    expect(sandbox.workspace).toBe(join(root, "workspace"));
    expect(sandbox.home).toBe(join(root, "home"));
    expect(existsSync(join(sandbox.workspace, ".loopany", "config.json"))).toBe(true);
    // The profiles round-trip through the workspace config.
    const read = readProfiles(join(sandbox.workspace, ".loopany"));
    expect(read.replay?.cmd).toBe("node");
    expect(read.replay?.args).toEqual(["/shim.mjs"]);
  });
});
