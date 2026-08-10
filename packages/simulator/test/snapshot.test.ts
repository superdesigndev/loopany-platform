/**
 * SNAPSHOT unit - captureDay copies `.loopany/` + `mirrors/` into a
 * deterministic out/<runId>/day-<N>/ tree, and tolerates an absent `mirrors/`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDay, snapshotDirFor } from "../src/index.js";

describe("captureDay", () => {
  let ws: string;
  const runId = "snap-unit-test";

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sim-snap-"));
    // A minimal workspace: .loopany/objects + a mirror.
    mkdirSync(join(ws, ".loopany", "objects"), { recursive: true });
    writeFileSync(join(ws, ".loopany", "objects", "t1.md"), "id: t1\n");
    mkdirSync(join(ws, "mirrors"), { recursive: true });
    writeFileSync(join(ws, "mirrors", "gsc.md"), "data\n");
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    // Clean the whole out/<runId> tree (day dirs live under it).
    rmSync(join(snapshotDirFor(runId, 1), ".."), { recursive: true, force: true });
  });

  it("copies .loopany + mirrors into a deterministic per-day dir", () => {
    const dest = captureDay(ws, runId, 1);
    expect(dest).toBe(snapshotDirFor(runId, 1));
    expect(readFileSync(join(dest, ".loopany", "objects", "t1.md"), "utf8")).toBe("id: t1\n");
    expect(readFileSync(join(dest, "mirrors", "gsc.md"), "utf8")).toBe("data\n");
  });

  it("the day index drives the dir name (day-1, day-2, ...)", () => {
    captureDay(ws, runId, 1);
    captureDay(ws, runId, 2);
    expect(existsSync(snapshotDirFor(runId, 1))).toBe(true);
    expect(existsSync(snapshotDirFor(runId, 2))).toBe(true);
  });

  it("an absent mirrors/ dir is skipped, not an error", () => {
    rmSync(join(ws, "mirrors"), { recursive: true, force: true });
    const dest = captureDay(ws, runId, 1);
    expect(existsSync(join(dest, ".loopany"))).toBe(true);
    expect(existsSync(join(dest, "mirrors"))).toBe(false);
  });
});
