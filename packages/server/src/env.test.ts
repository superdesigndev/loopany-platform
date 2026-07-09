import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { dataDir } from "./env.js";

// Harness-isolation guard: test/setup.ts must point ADSCAILE_DATA_DIR at a
// per-worker temp dir, so that NO test - however it reaches db/index.ts, even
// through a static import chain that runs before the file's own beforeAll -
// can open a PGlite on the developer's real ~/.adscaile/pgdata (the same live
// data dir a running `pnpm dev` uses).
test("tests never resolve the real ~/.adscaile data dir", () => {
  expect(dataDir()).not.toBe(path.join(os.homedir(), ".adscaile"));
  expect(process.env.ADSCAILE_DATA_DIR).toBeTruthy();
});
