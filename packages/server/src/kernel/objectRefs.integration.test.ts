import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * BY-ID OR BY-KEY, and the rule that keeps them from fighting.
 *
 * The gap this closes: a doc's id is organic randomness, so the run that filed a
 * product could not address it on a later pass — `doc show <key>` answered
 * NOT_FOUND for a key that plainly existed, and the only read-back left was
 * re-POSTing the whole file to see what the idempotent create resolved to.
 */
let temp: string;
let database: typeof import("../db/index.js");
let schema: typeof import("../db/kernel-schema.js");
let kernel: typeof import("./applyTransition.js");
let refs: typeof import("./objectRefs.js");

const TEAM = "team-refs";
const OTHER = "team-elsewhere";
const T0 = "2026-08-05T00:00:00.000Z";
const actor = { entrance: "human", actorId: "u-owner" } as const;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-object-refs-"));
  process.env.LOOPANY_DATA_DIR = temp;
  process.env.LOOPANY_LOG_LEVEL = "silent";
  database = await import("../db/index.js");
  await database.runMigrations();
  schema = await import("../db/kernel-schema.js");
  kernel = await import("./applyTransition.js");
  refs = await import("./objectRefs.js");
});
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(async () => {
  await database.db.delete(schema.events);
  await database.db.delete(schema.objects);
});

async function doc(teamId: string, key: string | undefined, extra: Record<string, unknown> = {}) {
  const made = await kernel.createObject({ teamId, kind: "doc", actor, now: T0, title: `doc ${key ?? "unkeyed"}`, body: "b", key, ...extra } as never);
  if (!made.ok) throw new Error(made.message);
  return made.object;
}

describe("resolveObjectRef", () => {
  it("returns an id verbatim, taking no second read", async () => {
    const row = await doc(TEAM, "weekly-summary");
    expect(await refs.resolveObjectRef(row.id, TEAM)).toBe(row.id);
  });

  it("resolves a creation key to its object id — the handle that survives across runs", async () => {
    const row = await doc(TEAM, "housekeeper-deferred-candidates");
    expect(await refs.resolveObjectRef("housekeeper-deferred-candidates", TEAM)).toBe(row.id);
  });

  it("lets the ID win when a key is spelled like one, so a key can never shadow a real row", async () => {
    const real = await doc(TEAM, undefined);
    // A second object whose user-chosen KEY is the first object's id.
    const impostor = await doc(TEAM, real.id);
    expect(impostor.id).not.toBe(real.id);
    expect(await refs.resolveObjectRef(real.id, TEAM)).toBe(real.id);
  });

  it("is team-scoped: another team's key does not resolve", async () => {
    await doc(OTHER, "their-private-report");
    expect(await refs.resolveObjectRef("their-private-report", TEAM)).toBe("their-private-report");
  });

  it("returns an unresolvable ref VERBATIM, so the caller's refusal names what was typed", async () => {
    expect(await refs.resolveObjectRef("no-such-handle", TEAM)).toBe("no-such-handle");
    expect(await refs.resolveObjectRef("", TEAM)).toBe("");
  });
});

/**
 * THE WIRING GUARD. The rule is only real if every `$taskId`/`$docId` route
 * actually runs its path segment through the resolver — a new ref route that
 * forgets it would be a surface where the key silently stops working, which is
 * exactly the shape of the bug this fixes.
 */
describe("every task/doc reference route resolves through the ONE resolver", () => {
  const REF_ROUTES = [
    "api.docs.$docId.ts",
    "api.tasks.$taskId.ts",
    "api.tasks.$taskId.close.ts",
    "api.tasks.$taskId.directive.ts",
    "api.tasks.$taskId.verdict.ts",
  ];

  it.each(REF_ROUTES)("%s calls resolveObjectRef and never passes params through raw", (file) => {
    // The path must live in a VARIABLE: vite rewrites a literal `new URL(…,
    // import.meta.url)` into an asset URL that fileURLToPath then rejects.
    const rel = `../routes/${file}`;
    const source = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(source).toContain("resolveObjectRef");
    const param = file.includes("docs") ? "params.docId" : "params.taskId";
    // The one legal mention is inside the resolver call itself.
    const mentions = source.split(param).length - 1;
    const resolved = source.split(`resolveObjectRef(${param},`).length - 1;
    expect(mentions, `${file} passes ${param} somewhere other than the resolver`).toBe(resolved);
  });
});
