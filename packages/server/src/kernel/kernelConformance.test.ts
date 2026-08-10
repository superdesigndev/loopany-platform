/**
 * THE M6 CONFORMANCE DOUBLE-RUN — the milestone's acceptance gate (§13).
 *
 * "同一份 golden 命令脚本对两个 backend 各跑一遍，结果一致" — the same golden command
 * script is replayed against BOTH backends and the semantic projections must
 * match:
 *   1. the LOCAL file driver (`@loopany/cli`'s driver over a temp `.loopany/`), and
 *   2. the in-process SERVER host (`kernelCli`, the exact function POST
 *      /api/kernel/cli delegates to, over a REAL pglite store).
 *
 * Both run the SAME `@loopany/kernel` at the authority (that is the whole point of
 * §9 — the kernel is pure and hosted where authority lives, so the two cannot
 * drift), and this suite PROVES it by comparing:
 *   - final objects (normalized, sorted by id),
 *   - per-object event {kind, diff, note, observation, provenance} sequences,
 *   - the trigger end-state,
 *   - the run states.
 * It also asserts REFUSAL PARITY: the same deliberately-bad commands are refused
 * with the SAME code by both backends.
 *
 * Actor identity: the server DERIVES the actor from the device credential and
 * ignores the body's provenance (a client cannot forge who acted). To make the
 * provenance sequences comparable, the local runner is driven with the SAME fixed
 * actor the server derives — so provenance parity is a real, checked property, not
 * a normalized-away one.
 *
 * Both runs happen ONCE in `beforeAll` (they mutate durable state — the temp
 * `.loopany/` and the pglite team — so a per-`it` replay would double-apply). The
 * refusal-parity cases run against a SEPARATE token/team so they never depend on
 * the golden run's ordering.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type KernelEvent, type Provenance, type Snapshot } from "@loopany/kernel";
import { loadEvents, loadSnapshot, runCommand, runTick, initWorkspace } from "@loopany/cli";

import { BAD_COMMANDS, GOLDEN_SCRIPT, SCRIPT_START } from "./conformance.script.js";

// The device token the server resolves to the golden team. Hand-shaped `dk_` demo
// token (legit per isDeviceTokenShape); the machine id derives from it.
const TOKEN = "dk_conformance_golden";
const OWNER_USER = "u_conformance_golden";
// A SECOND credential for the refusal-parity cases — its own team, replayed
// independently so those cases never depend on the golden run's state/order.
const BAD_TOKEN = "dk_conformance_refusal";
const BAD_USER = "u_conformance_refusal";

// The server derives THIS actor from the credential for every command — so the
// local runner uses it too, and provenance sequences compare across backends.
const DERIVED_ACTOR: Provenance = { entrance: "human", actorId: OWNER_USER };
const BAD_DERIVED_ACTOR: Provenance = { entrance: "human", actorId: BAD_USER };

// ---- a driver-agnostic, comparable projection of authority state ----

interface Projection {
  objects: unknown[];
  events: Record<string, ProjectedEvent[]>;
  triggers: unknown[];
  runs: unknown[];
}

interface ProjectedEvent {
  kind: string;
  diff: unknown;
  note: unknown;
  observation: unknown;
  provenance: Provenance;
}

/** Canonicalize a run's OPTIONAL fields (`sessionId`/`note`) so an "unset" value
 *  compares equal across backends. The kernel mints a fresh run WITHOUT these
 *  keys (they land only at claim/finish); the server persists that verbatim
 *  (JSONB drops `undefined`), while the local file driver's reload coerces the
 *  absent keys to `null`. Both mean "not set" — undefined vs null there is a pure
 *  representation choice, not a semantic drift — so we drop a null/undefined
 *  `sessionId`/`note` on both sides before comparing. A REAL value (a captured
 *  sessionId, a finish note) is preserved and still compared. */
function normalizeRun(run: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(run as Record<string, unknown>) };
  for (const k of ["sessionId", "note"]) {
    if (out[k] === null || out[k] === undefined) delete out[k];
  }
  return out;
}

/** Normalize an event to its SEMANTIC fields (drop the derived `id`/`at`, which
 *  are deterministic functions of the same seeds and would only add noise). */
function projectEvent(e: KernelEvent): ProjectedEvent {
  return {
    kind: e.kind,
    diff: e.diff ?? null,
    note: e.note ?? null,
    observation: e.observation ?? null,
    provenance: e.provenance,
  };
}

/** Build the comparable projection from a snapshot + per-object event streams.
 *  Objects/triggers/runs are sorted by id for a stable order-independent compare;
 *  events keep their per-stream append order (the audit sequence IS the meaning). */
function project(snapshot: Snapshot, eventsByObject: Record<string, KernelEvent[]>): Projection {
  const objects = Object.values(snapshot.objects)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const triggers = snapshot.triggers.slice().sort((a, b) => a.id.localeCompare(b.id));
  const runs = snapshot.runs
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(normalizeRun);
  const events: Record<string, ProjectedEvent[]> = {};
  for (const id of Object.keys(eventsByObject).sort()) {
    events[id] = (eventsByObject[id] ?? []).map(projectEvent);
  }
  return { objects, events, triggers, runs };
}

// ---- the LOCAL file-driver runner ----

/** Replay the golden script into a fresh temp `.loopany/` and project the result.
 *  Returns the workspace dir too so the refusal cases can reuse the same state. */
function replayLocal(actor: Provenance): { wsDir: string; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-conf-local-"));
  const { dir: wsDir } = initWorkspace(cwd, "local", SCRIPT_START);
  for (const step of GOLDEN_SCRIPT) {
    if (step.kind === "tick") runTick(wsDir, step.now);
    // Drive with the DERIVED actor (not step.actor) so provenance matches the
    // server, which ignores the body actor and derives it from the credential.
    else runCommand(wsDir, step.command, actor, step.now);
  }
  return { wsDir, cwd };
}

function projectLocal(wsDir: string): Projection {
  const snapshot = loadSnapshot(wsDir);
  const eventsByObject: Record<string, KernelEvent[]> = {};
  for (const id of Object.keys(snapshot.objects)) {
    eventsByObject[id] = loadEvents(wsDir, id);
  }
  return project(snapshot, eventsByObject);
}

// ---- the SERVER host runner (kernelCli over pglite) ----

let store: typeof import("../db/store.js");
let tokens: typeof import("../gateway/tokens.js");
let gateway: typeof import("./gateway.js");
let kstore: typeof import("./store.js");
let GOLDEN_TEAM: string;
let BAD_TEAM: string;

async function replayServer(token: string): Promise<void> {
  for (const step of GOLDEN_SCRIPT) {
    if (step.kind === "tick") {
      const r = await gateway.kernelCli(token, { tick: true, now: step.now });
      if (r.status !== 200) throw new Error(`server tick failed: ${JSON.stringify(r.body)}`);
    } else {
      // The server ignores the body actor (credential-derived); `now` is the
      // deterministic instant, matching the local driver.
      const r = await gateway.kernelCli(token, { command: step.command, now: step.now });
      if (r.status !== 200) {
        throw new Error(`server command failed (${step.command.op}): ${JSON.stringify(r.body)}`);
      }
    }
  }
}

async function projectServer(teamId: string): Promise<Projection> {
  const snapshot = await kstore.readSnapshot(teamId);
  const all = await kstore.readEvents(teamId);
  const eventsByObject: Record<string, KernelEvent[]> = {};
  for (const ev of all) (eventsByObject[ev.objectId] ??= []).push(ev);
  return project(snapshot, eventsByObject);
}

async function seedMachine(token: string, userId: string): Promise<string> {
  const machineId = tokens.machineIdFromToken(token);
  const teamId = store.teamIdForUser(userId);
  await store.createMachine({
    id: machineId,
    userId,
    teamId,
    name: `m-${userId}`,
    tokenHash: tokens.sha256(token),
    token,
  });
  return teamId;
}

// The projections + workspace state, computed ONCE (both replays mutate durable
// state, so per-`it` replays would double-apply).
let localGolden: Projection;
let serverGolden: Projection;
let badWsDir: string;
let cleanup: string[] = [];

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-conf-server-"));
  process.env.LOOPANY_DATA_DIR = tmp;
  process.env.LOOPANY_DB_PATH = path.join(tmp, "test.db");
  process.env.LOOPANY_LOG_LEVEL = "silent";

  const db = await import("../db/index.js");
  await db.runMigrations();
  store = await import("../db/store.js");
  tokens = await import("../gateway/tokens.js");
  gateway = await import("./gateway.js");
  kstore = await import("./store.js");

  GOLDEN_TEAM = await seedMachine(TOKEN, OWNER_USER);
  BAD_TEAM = await seedMachine(BAD_TOKEN, BAD_USER);

  // Golden double-run.
  const local = replayLocal(DERIVED_ACTOR);
  cleanup.push(local.cwd);
  localGolden = projectLocal(local.wsDir);
  await replayServer(TOKEN);
  serverGolden = await projectServer(GOLDEN_TEAM);

  // Isolated state for the refusal-parity cases (its own local workspace + its
  // own server team), replayed to the post-golden state.
  const bad = replayLocal(BAD_DERIVED_ACTOR);
  cleanup.push(bad.cwd);
  badWsDir = bad.wsDir;
  await replayServer(BAD_TOKEN);
});

afterAll(() => {
  for (const dir of cleanup) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("M6 conformance — the golden script runs identically on both backends", () => {
  it("local file driver and server host produce the SAME semantic projection", () => {
    // The whole projection matches — objects, per-object event sequences,
    // triggers, runs. If any field of the four record classes drifts, this fails
    // with a precise diff.
    expect(serverGolden).toEqual(localGolden);
  });

  it("the golden script actually exercised triggers + runs (not a trivial pass)", () => {
    // Two loops (recurring triggers) + a once-trigger lifecycle were fired; runs
    // were created by the ticks and the assignment dispatch. Guard against the
    // comparison passing because BOTH sides did nothing.
    expect(localGolden.objects.length).toBeGreaterThanOrEqual(4);
    expect(localGolden.triggers.length).toBeGreaterThanOrEqual(2);
    expect(localGolden.runs.length).toBeGreaterThanOrEqual(1);
    // Structured observations survived the daily series.
    const observationEvents = Object.values(localGolden.events)
      .flat()
      .filter((e) => e.kind === "observation");
    expect(observationEvents.length).toBe(5);
    // The bet died done; both loops survive.
    const ids = localGolden.objects.map((o) => (o as { id: string }).id).sort();
    expect(ids).toContain("seo-bet-manager");
    expect(ids).toContain("seo-engine-ccdp");
  });
});

describe("M6 conformance — refusal parity on deliberately bad commands", () => {
  it("both backends refuse each bad command with the SAME code", async () => {
    for (const bad of BAD_COMMANDS) {
      // LOCAL: runCommand throws a DriverError whose `code` is the Refusal code.
      let localCode: string | undefined;
      try {
        runCommand(badWsDir, bad.command, BAD_DERIVED_ACTOR, bad.now);
      } catch (e) {
        localCode = (e as { code?: string }).code;
      }
      expect(localCode, `local should refuse "${bad.label}"`).toBe(bad.code);

      // SERVER: a 422 with the same refusal code.
      const r = await gateway.kernelCli(BAD_TOKEN, { command: bad.command, now: bad.now });
      expect(r.status, `server should refuse "${bad.label}" (422)`).toBe(422);
      expect(r.body.refusal?.code, `server code for "${bad.label}"`).toBe(bad.code);

      // PARITY: the two codes are identical.
      expect(r.body.refusal?.code, `refusal parity for "${bad.label}"`).toBe(localCode);
    }
  });
});
