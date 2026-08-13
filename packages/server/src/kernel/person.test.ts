import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { user } from "../db/auth-schema.js";

let tmp: string; let db: typeof import("../db/index.js"); let store: typeof import("../db/store.js"); let person: typeof import("./person.js");
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-person-")); process.env.LOOPANY_DATA_DIR = tmp;
  db = await import("../db/index.js"); await db.runMigrations(); store = await import("../db/store.js"); person = await import("./person.js");
  await db.db.insert(user).values([
    { id: "u-a", name: "Alice", email: "Alice@x.co", emailVerified: true },
    { id: "u-b", name: "Bob", email: "bob@x.co", emailVerified: true },
  ]);
  await store.ensureTeam("team-a", "A", "u-a"); await store.addTeamMember("team-a", "u-b", "member");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("normalizes assignee and owner through current-team membership", async () => {
  const normalized = await person.normalizePersonFields("team-a", { op: "create", title: "x", assignee: "alice@X.CO", owner: "Bob" });
  expect(normalized).toMatchObject({ assignee: "person:u-a", owner: "person:u-b" });
  expect(await person.resolvePerson("team-other", "alice@x.co")).toBeNull();
});
