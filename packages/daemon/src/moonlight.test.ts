/**
 * Moonlight - the daemon's local kernel-tick side job. Drives the pure/injectable
 * surface (`tickRegisteredWorkspaces`, `readRegistryFile`, `surfaceLines`) with
 * NO real process, registry, or clock: every external touch is a seam.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  readRegistryFile,
  surfaceLines,
  tickRegisteredWorkspaces,
  type RegistryEntry,
  type TickChildResult,
  type TickSpawnFn,
} from "./moonlight.js";

describe("readRegistryFile (tolerant)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moonlight-reg-"));
    file = join(dir, "kernel.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing file is an empty list", () => {
    expect(readRegistryFile(file)).toEqual([]);
  });

  test("corrupt / non-array / bad-entry all read as empty or drop bad entries", () => {
    for (const junk of ["nope", "{}", '"s"', "[42]", '[{"dir":1,"bin":"b"}]']) {
      writeFileSync(file, junk);
      expect(readRegistryFile(file)).toEqual([]);
    }
    // A well-formed entry beside a broken one keeps the good one.
    writeFileSync(file, JSON.stringify([{ dir: "/a", bin: "/b" }, { bin: "/only" }]));
    expect(readRegistryFile(file)).toEqual([{ dir: "/a", bin: "/b" }]);
  });

  test("valid entries round-trip", () => {
    writeFileSync(file, JSON.stringify([{ dir: "/repo/one", bin: "/bin.mjs" }]));
    expect(readRegistryFile(file)).toEqual([{ dir: "/repo/one", bin: "/bin.mjs" }]);
  });
});

describe("surfaceLines (log-worthy child stdout)", () => {
  test("keeps tick:/spawn:/» lines, drops the no-op pair and everything else", () => {
    const stdout = [
      "tick: 1 fire(s) applied",
      "» once fired for rec",
      "spawn: 1 run(s) executed",
      "some unrelated chatter",
      "tick: nothing due",
      "spawn: nothing to run",
    ].join("\n");
    expect(surfaceLines(stdout)).toEqual([
      "tick: 1 fire(s) applied",
      "» once fired for rec",
      "spawn: 1 run(s) executed",
    ]);
  });

  test("a fully no-op tick surfaces nothing", () => {
    expect(surfaceLines("tick: nothing due\nspawn: nothing to run\n")).toEqual([]);
  });
});

describe("tickRegisteredWorkspaces (best-effort, isolated, dedup)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moonlight-ws-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const okResult = (lines: string[] = []): TickChildResult => ({ status: 0, lines });

  test("spawns `tick --spawn` for each existing registered workspace", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const entries: RegistryEntry[] = [
      { dir: a, bin: "/bin/loopany-kernel.mjs" },
      { dir: b, bin: "/bin/loopany-kernel.mjs" },
    ];
    const spawned: RegistryEntry[] = [];
    const spawnTick: TickSpawnFn = async (entry) => {
      spawned.push(entry);
      return okResult(["tick: 1 fire(s) applied"]);
    };
    const logs: string[] = [];
    await tickRegisteredWorkspaces(new Set(), {
      readRegistry: () => entries,
      spawnTick,
      exists: () => true,
      log: (l) => logs.push(l),
    });
    expect(spawned.map((e) => e.dir).sort()).toEqual([a, b].sort());
    expect(logs.some((l) => l.includes("tick: 1 fire(s) applied"))).toBe(true);
  });

  test("a vanished workspace dir is SKIPPED (never spawned, never auto-removed)", async () => {
    const entries: RegistryEntry[] = [{ dir: "/gone", bin: "/b.mjs" }];
    let spawnedCount = 0;
    await tickRegisteredWorkspaces(new Set(), {
      readRegistry: () => entries,
      spawnTick: async () => {
        spawnedCount++;
        return okResult();
      },
      exists: (p) => p !== "/gone",
      log: () => {},
    });
    expect(spawnedCount).toBe(0);
  });

  test("a workspace already in-flight is not double-spawned", async () => {
    const ws = join(dir, "busy");
    mkdirSync(ws);
    const inFlight = new Set<string>([ws]); // pretend a prior interval is still ticking it
    let spawnedCount = 0;
    await tickRegisteredWorkspaces(inFlight, {
      readRegistry: () => [{ dir: ws, bin: "/b.mjs" }],
      spawnTick: async () => {
        spawnedCount++;
        return okResult();
      },
      exists: () => true,
      log: () => {},
    });
    expect(spawnedCount).toBe(0);
    // The dir it did not touch stays exactly as the caller left it.
    expect(inFlight.has(ws)).toBe(true);
  });

  test("in-flight is released after a tick settles (a later pass can re-spawn)", async () => {
    const ws = join(dir, "again");
    mkdirSync(ws);
    const inFlight = new Set<string>();
    const spawnTick: TickSpawnFn = async () => okResult();
    const deps = { readRegistry: () => [{ dir: ws, bin: "/b.mjs" }], spawnTick, exists: () => true, log: () => {} };
    await tickRegisteredWorkspaces(inFlight, deps);
    expect(inFlight.has(ws)).toBe(false);
    // A second pass spawns again (nothing lingering).
    let secondSpawned = 0;
    await tickRegisteredWorkspaces(inFlight, { ...deps, spawnTick: async () => { secondSpawned++; return okResult(); } });
    expect(secondSpawned).toBe(1);
  });

  test("a failing workspace is logged and ISOLATED - others still tick", async () => {
    const good = join(dir, "good");
    const bad = join(dir, "bad");
    mkdirSync(good);
    mkdirSync(bad);
    const spawned: string[] = [];
    const spawnTick: TickSpawnFn = async (entry) => {
      spawned.push(entry.dir);
      if (entry.dir === bad) throw new Error("boom");
      return okResult();
    };
    const logs: string[] = [];
    await tickRegisteredWorkspaces(new Set(), {
      readRegistry: () => [
        { dir: bad, bin: "/b.mjs" },
        { dir: good, bin: "/b.mjs" },
      ],
      spawnTick,
      exists: () => true,
      log: (l) => logs.push(l),
    });
    // Both were attempted; the good one is not skipped because the bad one threw.
    expect(spawned.sort()).toEqual([bad, good].sort());
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  test("a nonzero exit and a launch error each log one concise line", async () => {
    const ws1 = join(dir, "exit3");
    const ws2 = join(dir, "enoent");
    mkdirSync(ws1);
    mkdirSync(ws2);
    const spawnTick: TickSpawnFn = async (entry) =>
      entry.dir === ws1 ? { status: 3, lines: [] } : { status: 127, lines: [], error: "spawn ENOENT" };
    const logs: string[] = [];
    await tickRegisteredWorkspaces(new Set(), {
      readRegistry: () => [
        { dir: ws1, bin: "/b.mjs" },
        { dir: ws2, bin: "/missing" },
      ],
      spawnTick,
      exists: () => true,
      log: (l) => logs.push(l),
    });
    expect(logs.some((l) => l.includes("exited 3"))).toBe(true);
    expect(logs.some((l) => l.includes("spawn ENOENT"))).toBe(true);
  });

  test("a broken registry read never faults the pass", async () => {
    await expect(
      tickRegisteredWorkspaces(new Set(), {
        readRegistry: () => {
          throw new Error("registry blew up");
        },
        spawnTick: async () => okResult(),
        exists: () => true,
        log: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  test("a missing registered workspace warns once across passes", async () => {
    const missing = join(dir, "missing-on-two-passes");
    const logs: string[] = [];
    const deps = {
      readRegistry: () => [{ dir: missing, bin: "/b.mjs" }],
      spawnTick: async () => okResult(),
      exists: () => false,
      log: (line: string) => logs.push(line),
    };
    await tickRegisteredWorkspaces(new Set(), deps);
    await tickRegisteredWorkspaces(new Set(), deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("registered workspace missing - skipped");
  });
});
