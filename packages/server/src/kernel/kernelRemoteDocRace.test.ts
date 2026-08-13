/**
 * REMOTE backend `doc put` no-wipe guard is race-safe AT THE AUTHORITY (M6 fix).
 *
 * The local file driver evaluates the "don't wipe an existing doc" guard INSIDE
 * the workspace write lock, so a `doc put <key>` that saw no doc cannot be raced
 * into wiping a body created in the window. The remote backend has NO client-held
 * lock — its guard runs against a PRE-POST snapshot, which is racy: client A's
 * bare `doc put <key>` sees no doc, client B creates it, A's POSTed doc-put would
 * then wipe B's body, because the server re-decides against its own snapshot with
 * no precondition.
 *
 * The fix (cli.ts verbDoc): the create-only `doc put` path carries `ifVersion: 0`,
 * which the kernel's `decideDocPut` enforces at the AUTHORITY — an absent doc
 * passes (0 vs no existing version), an existing doc CONFLICTs (its version can
 * never be 0). This test drives the REAL production path — the `@loopany/cli`
 * `run(argv, deps)` verb layer over the RemoteBackend, with an injected transport
 * that forwards to `kernelCli` (the exact function POST /api/kernel/cli delegates
 * to) over a REAL pglite store — and reproduces the race precisely: the guard's
 * pre-POST read is served a STALE empty snapshot (as if the doc did not yet
 * exist), while the doc DOES exist at the server when A's command lands. The
 * server must refuse with CONFLICT and B's body must be untouched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run, WORKSPACE_DIR, type CliDeps } from "@loopany/cli";

const TOKEN = "session_remote_doc_race";
const OWNER_USER = "u_remote_doc_race";
const SERVER_URL = "https://kernel.example.test";
const NOW = "2026-08-10T09:00:00.000Z";

let tmp: string;
let cwd: string;
let store: typeof import("../db/store.js");
let tokens: typeof import("../gateway/tokens.js");
let gateway: typeof import("./gateway.js");
let kstore: typeof import("./store.js");
let TEAM: string;

async function seedMachine(token: string, userId: string): Promise<string> {
  const machineId = tokens.machineIdFromToken(token);
  const teamId = store.teamIdForUser(userId);
  await store.createMachine({
    id: machineId,
    userId,
    teamId,
    name: `m-${userId}`,
    tokenHash: tokens.sha256(token),
  });
  return teamId;
}

/** The CLI verb layer's transport seam is SYNCHRONOUS, but `kernelCli` is async.
 *  We bridge by running the two async server calls (B's create, A's raced put) in
 *  `beforeAll` and REPLAYING the recorded responses through a synchronous
 *  transport: a `{read:true}` (the guard's pre-POST existence check) returns the
 *  injected STALE snapshot, a `{command}` returns the recorded server response. */
type Recorded = { status: number; body: unknown };

/** Build a synchronous transport backed by a queue of precomputed responses keyed
 *  by request shape. A `{read:true}` returns the injected snapshot; a `{command}`
 *  returns the recorded server response. This keeps the sync verb layer intact
 *  while the async server work happens in `beforeAll`. */
function makeTransport(
  staleReadBody: unknown,
  commandResponse: Recorded,
): NonNullable<CliDeps["transport"]> {
  return (_url, _token, body) => {
    const b = body as { read?: boolean; command?: unknown };
    if (b.read === true) {
      // The guard's pre-POST existence read: serve the STALE snapshot in which
      // the doc does not yet exist, so the client-side guard does NOT fire.
      return { status: 200, response: staleReadBody as never };
    }
    // The actual write POST: the server (where the doc already exists) decided
    // this in beforeAll; replay its recorded response.
    return { status: commandResponse.status, response: commandResponse.body as never };
  };
}

let raceResponse: Awaited<ReturnType<typeof import("./gateway.js").kernelCli>>;
let staleRead: unknown;
let bodyBefore: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-remote-docrace-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";

  const db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  tokens = await import("../gateway/tokens.js");
  gateway = await import("./gateway.js");
  kstore = await import("./store.js");

  TEAM = await seedMachine(TOKEN, OWNER_USER);

  // Client B wins the key: it creates `brief` with a real body FIRST.
  const bCreate = await gateway.kernelCli(TOKEN, {
    command: { op: "doc-put", key: "brief", body: "B's real content\n", ifVersion: 0 },
    now: NOW,
  }, { userId: OWNER_USER, teamId: TEAM });
  expect(bCreate.status).toBe(200);
  const afterB = await kstore.readSnapshot(TEAM);
  const doc = afterB.objects["brief"];
  expect(doc?.archetype).toBe("doc");
  bodyBefore = doc?.archetype === "doc" ? doc.body : "";
  expect(bodyBefore).toBe("B's real content\n");

  // The STALE snapshot the guard's pre-POST read is served: as if `brief` did not
  // exist yet (the race window — A read before B's create landed).
  staleRead = { ok: true, notices: [], snapshot: { objects: {}, triggers: [], runs: [] }, events: {} };

  // Client A's bare `doc put brief` (no --file) carries ifVersion:0 on the
  // create-only path. At the server the doc DOES exist (B created it), so the
  // authority must refuse with CONFLICT — never wipe B's body.
  raceResponse = await gateway.kernelCli(TOKEN, {
    command: { op: "doc-put", key: "brief", body: "", ifVersion: 0 },
    now: NOW,
  }, { userId: OWNER_USER, teamId: TEAM });

  // A workspace whose backend is the remote URL, so `run(...)` selects the
  // RemoteBackend and the injected transport carries the POST.
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-remote-docrace-ws-"));
  fs.mkdirSync(path.join(cwd, WORKSPACE_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, WORKSPACE_DIR, "config.json"),
    JSON.stringify({ backend: SERVER_URL, createdAt: NOW, token: TOKEN }, null, 2) + "\n",
  );
});

afterAll(() => {
  for (const dir of [tmp, cwd]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("remote `doc put` no-wipe guard is enforced at the AUTHORITY (ifVersion:0)", () => {
  it("the server refuses A's create-raced-by-create bare doc put with CONFLICT", () => {
    // The server, deciding against its OWN snapshot (where B's doc exists),
    // refused A's ifVersion:0 create-only put. decideDocPut catches the version
    // mismatch at DECIDE time (an ifVersion:0 that finds version 1), so it is a
    // typed Refusal (422, code "CONFLICT"), not an apply-time ApplyConflict (409)
    // — either way a hard refusal, never a silent wipe.
    expect(raceResponse.status).toBe(422);
    expect(raceResponse.body.refusal?.code).toBe("CONFLICT");
    expect(raceResponse.body.conflict).toBeUndefined();
  });

  it("B's body is untouched after the refused wipe", async () => {
    const after = await kstore.readSnapshot(TEAM);
    const doc = after.objects["brief"];
    expect(doc?.archetype === "doc" && doc.body).toBe("B's real content\n");
    expect(doc?.version).toBe(1);
  });

  it("the CLI verb layer surfaces the server CONFLICT (guard did not mask it)", () => {
    // Drive the REAL production path: `run(["doc","put","brief"])` over the
    // RemoteBackend. The client-side guard is served the STALE (empty) snapshot,
    // so it does NOT fire — the ONLY thing standing between A and a wipe is the
    // ifVersion:0 precondition the server enforces. The verb layer must render the
    // server's CONFLICT as an error at exit 1, not swallow it or wipe the body.
    const transport = makeTransport(staleRead, raceResponse as Recorded);
    const deps: CliDeps = { cwd, now: NOW, env: {}, transport };
    const out = run(["doc", "put", "brief"], deps);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/CONFLICT/);
  });
});
