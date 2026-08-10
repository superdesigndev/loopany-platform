/**
 * DATE-KEYED replay resolution (replay-agent.mjs): a script key is looked up
 * `<taskId>@<YYYY-MM-DD>` FIRST (date parsed from LOOPANY_NOW), then the bare
 * `<taskId>`. This lets one weekly loop replay a DIFFERENT sequence each fire.
 *
 * The shim re-invokes LOOPANY_KERNEL_BIN per replayed argv; here that bin is a
 * tiny stub that appends its argv to a log file, so the test reads back exactly
 * which sequence the shim chose - no real kernel needed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const shim = join(dirname(fileURLToPath(import.meta.url)), "..", "shims", "replay-agent.mjs");

describe("replay-agent date-keyed lookup", () => {
  let root: string;
  let binLog: string;
  let binStub: string;
  let scriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sim-replay-key-"));
    binLog = join(root, "bin.log");
    // A stub "kernel bin": append its argv (one line) to binLog, exit 0.
    binStub = join(root, "kernel-stub.mjs");
    writeFileSync(
      binStub,
      "import { appendFileSync } from 'node:fs';\n" +
        `appendFileSync(${JSON.stringify(binLog)}, process.argv.slice(2).join(' ') + '\\n');\n`,
    );
    scriptPath = join(root, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        "weekly@2026-09-07": [["note", "weekly", "week-2 win+scale"]],
        weekly: [["note", "weekly", "default open-bets"]],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runShim(now: string): string[] {
    const child = spawnSync(process.execPath, [shim], {
      env: {
        PATH: process.env.PATH ?? "",
        LOOPANY_TASK_ID: "weekly",
        LOOPANY_KERNEL_BIN: binStub,
        LOOPANY_REPLAY_SCRIPT: scriptPath,
        LOOPANY_NOW: now,
      },
      input: "core prompt",
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    return existsSync(binLog)
      ? readFileSync(binLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
  }

  it("prefers the date-keyed entry when LOOPANY_NOW matches", () => {
    const lines = runShim("2026-09-07T07:00:00.000Z");
    expect(lines).toEqual(["note weekly week-2 win+scale"]);
  });

  it("falls back to the bare task key on a non-matching date", () => {
    const lines = runShim("2026-08-31T07:00:00.000Z");
    expect(lines).toEqual(["note weekly default open-bets"]);
  });

  it("falls back to the bare key when LOOPANY_NOW is absent/malformed", () => {
    const child = spawnSync(process.execPath, [shim], {
      env: {
        PATH: process.env.PATH ?? "",
        LOOPANY_TASK_ID: "weekly",
        LOOPANY_KERNEL_BIN: binStub,
        LOOPANY_REPLAY_SCRIPT: scriptPath,
        // no LOOPANY_NOW
      },
      input: "core prompt",
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    const lines = readFileSync(binLog, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toEqual(["note weekly default open-bets"]);
  });
});
