import os from "node:os";
import path from "node:path";
import { describe, expect, it, test } from "vitest";

import * as env from "./env.js";
import { dataDir } from "./env.js";

// Harness-isolation guard: test/setup.ts must point LOOPANY_DATA_DIR at a
// per-worker temp dir, so that NO test - however it reaches db/index.ts, even
// through a static import chain that runs before the file's own beforeAll -
// can open a PGlite on the developer's real ~/.loopany/pgdata (the same live
// data dir a running `pnpm dev` uses).
test("tests never resolve the real ~/.loopany data dir", () => {
  expect(dataDir()).not.toBe(path.join(os.homedir(), ".loopany"));
  expect(process.env.LOOPANY_DATA_DIR).toBeTruthy();
});

/**
 * `posIntEnv` floored AFTER its positivity test, so any fractional value below 1
 * passed `n > 0` and then became `0`. Every knob reads 0 as "disabled", and for the
 * watchdog's starved ceiling that silently turned the bounded-recovery guarantee
 * back off - `starvedTicks >= 0` is true on the very first starved tick. Found in
 * review; these pin the fallback for the whole family of knobs.
 */
describe("positive-integer env knobs reject sub-1 fractions", () => {
  const cases: Array<[string, () => number, number]> = [
    ["LOOPANY_DB_WATCHDOG_STARVED_MAX", env.dbWatchdogStarvedCeiling, 45],
    ["LOOPANY_DB_WATCHDOG_FAILURES", env.dbWatchdogFailureThreshold, 3],
    ["LOOPANY_DB_WATCHDOG_INTERVAL_MS", env.dbWatchdogIntervalMs, 20_000],
    ["LOOPANY_SNAPSHOT_RETENTION", env.snapshotRetention, 20],
  ]

  for (const [name, read, fallback] of cases) {
    it(`${name}=0.5 falls back to ${fallback} rather than 0`, () => {
      process.env[name] = "0.5"
      expect(read()).toBe(fallback)
      delete process.env[name]
    })
  }

  it("still floors a legitimate fractional value at or above 1", () => {
    process.env.LOOPANY_DB_WATCHDOG_STARVED_MAX = "7.9"
    expect(env.dbWatchdogStarvedCeiling()).toBe(7)
    delete process.env.LOOPANY_DB_WATCHDOG_STARVED_MAX
  })

  it("honors a normal integer override", () => {
    process.env.LOOPANY_DB_WATCHDOG_STARVED_MAX = "12"
    expect(env.dbWatchdogStarvedCeiling()).toBe(12)
    delete process.env.LOOPANY_DB_WATCHDOG_STARVED_MAX
  })
})
