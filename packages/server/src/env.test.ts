import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

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
