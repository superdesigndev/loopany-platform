/**
 * `adscaile skill status` — honest, per-agent install reporting. The install now
 * targets every agent in `SKILL_TARGET_AGENTS` (Claude Code + Codex today), so
 * status must report each one's location for BOTH scopes (user + project), derived
 * from the same target list as the installer so the two surfaces cannot drift.
 * Nothing here spawns npx or hits the network — status is pure filesystem reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runSkill } from "./skill-cli.js";
import { SKILL_TARGET_AGENTS } from "./skill-install.js";

/** Capture stdout for the duration of one runSkill call. */
async function captureStatus(): Promise<string> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await runSkill(["status"]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("adscaile skill status — multi-agent", () => {
  test("reports every targeted agent (Claude Code + Codex) by label", async () => {
    const out = await captureStatus();
    for (const t of SKILL_TARGET_AGENTS) {
      expect(out).toContain(t.label);
    }
    // The two CodingAgent values are exactly what we target today.
    expect(SKILL_TARGET_AGENTS.map((t) => t.id)).toEqual(["claude-code", "codex"]);
  });

  test("reports each agent × scope (user + project) with a real installed/not-installed verdict", async () => {
    const out = await captureStatus();
    for (const t of SKILL_TARGET_AGENTS) {
      const userDir = path.join(os.homedir(), ...t.skillsRoot, "adscaile");
      const projectDir = path.join(process.cwd(), ...t.skillsRoot, "adscaile");
      const userInstalled = fs.existsSync(path.join(userDir, "SKILL.md"));
      const projectInstalled = fs.existsSync(path.join(projectDir, "SKILL.md"));
      // user scope line
      expect(out).toContain(`${t.label} user (${userDir}): ${userInstalled ? "installed" : "not installed"}`);
      // project scope line
      expect(out).toContain(
        `${t.label} project (${projectDir}): ${projectInstalled ? "installed (would shadow user scope)" : "not installed"}`,
      );
    }
    expect(out).toMatch(/bundled source: (available|missing)/);
  });

  test("distinct skill-root per agent — Claude Code under .claude, Codex under .agents", async () => {
    const out = await captureStatus();
    expect(out).toContain(path.join(".claude", "skills", "adscaile"));
    expect(out).toContain(path.join(".agents", "skills", "adscaile"));
  });
});
