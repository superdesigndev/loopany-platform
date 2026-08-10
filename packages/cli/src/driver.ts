/**
 * The LOCAL file driver — a `.loopany/` workspace as the kernel's authority.
 *
 * A driver's whole job (§9): load a Snapshot, hand a Command to the pure kernel
 * (`decide` -> Changeset | Refusal), VALIDATE + fold it (`applyChangeset`, which
 * enforces every CAS/active-run precondition), then persist the validated fold
 * and append the events. The kernel runs at the authority, so the local backend
 * and the (future) server backend cannot drift.
 *
 * Storage layout (§9):
 *   .loopany/objects/<id>.md      strict frontmatter codec (objectFile.ts)
 *   .loopany/events/<objId>.jsonl append-only, one stream per object
 *   .loopany/triggers/<id>.json   the future table
 *   .loopany/runs/<id>.json       the handoff table
 *   .loopany/config.json          backend + workspace metadata
 *
 * Atomicity: a workspace-level lockfile is held for the whole command, and each
 * object write is temp-file + rename. This is the DEMO-PHASE file impl — it
 * accepts a documented crash window between the object/trigger/run writes and
 * the event append (a crash there leaves the fold applied but an event
 * unappended). No WAL: §9 defers real transactionality to the SQLite/server
 * tiers. The window is stated, not hidden.
 */
import {
  ACTIVE_RUN_STATES,
  type ApplyConflict,
  type Command,
  type KernelEvent,
  type Provenance,
  type Refusal,
  type RunRecord,
  type RunState,
  type Snapshot,
  type Trigger,
  applyChangeset,
  decide,
  tick,
} from "@loopany/kernel";
import { CodecError, parseObject, serializeObject } from "./objectFile.js";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKSPACE_DIR = ".loopany";

export interface WorkspaceConfig {
  /** "local" or a server URL. `init --backend <url>` records the remote
   *  authority; the M6 remote backend POSTs every Command there. */
  backend: string;
  createdAt: string;
  /** The `dk_` device token for a remote backend, if the user stored it at init
   *  (`init --backend <url> --token <dk_…>`). `LOOPANY_KERNEL_TOKEN` overrides it.
   *  Absent for a local workspace. */
  token?: string;
  /** Executor bindings (assignee name -> launch profile). Seeded at CREATE from
   *  the agent binaries found on PATH (never on a re-init over an existing
   *  config). `readProfiles` (spawn.ts) validates the shape when `tick --spawn`
   *  reads it back; the loose `unknown` here keeps the driver from importing the
   *  Profiles type. */
  profiles?: Record<string, unknown>;
}

/** A driver error the CLI renders as `error:/code:` text. `code` is a Refusal
 *  code or "CONFLICT" (ApplyConflict) or a workspace/codec class — TWO error
 *  shapes (Refusal vs ApplyConflict) rendered ONE consistent way, deliberately
 *  NOT unified (§12 recorded debt). */
export class DriverError extends Error {
  readonly code: string;
  readonly issues?: string[];
  readonly hint?: string;
  constructor(code: string, message: string, extra?: { issues?: string[]; hint?: string }) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    this.issues = extra?.issues;
    this.hint = extra?.hint;
  }
}

export function refusalToError(r: Refusal): DriverError {
  return new DriverError(r.code, r.message, { issues: r.issues, hint: r.hint });
}

export function conflictToError(c: ApplyConflict): DriverError {
  // ApplyConflict {kind,id,message} rendered under the same skin as a Refusal —
  // the driver is the ONE place §12's two error shapes converge, so M5/M6 render
  // them identically without either side re-translating.
  return new DriverError("CONFLICT", `${c.message} (${c.kind} ${c.id})`, {
    hint: "the workspace changed under this command — re-read and retry",
  });
}

// ---- workspace discovery (walk up like git) ----

/** Find the nearest ancestor holding a `.loopany/`, from `start` upward. */
export function findWorkspace(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_DIR, "config.json"))) return join(dir, WORKSPACE_DIR);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireWorkspace(start: string): string {
  const ws = findWorkspace(start);
  if (!ws) {
    throw new DriverError("NO_WORKSPACE", "no .loopany/ workspace found", {
      hint: "run `loopany-kernel init` here (or in a parent directory)",
    });
  }
  return ws;
}

// ---- init ----

export function initWorkspace(
  cwd: string,
  backend: string,
  now: string,
  token?: string,
  profiles?: Record<string, unknown>,
): { dir: string; existed: boolean } {
  const dir = join(resolve(cwd), WORKSPACE_DIR);
  // Ensure the table dirs UNCONDITIONALLY, before the already-initialized
  // early-return: a workspace whose objects/events/triggers/runs dir was
  // removed (or never fully created) must self-heal on a re-init rather than
  // report success and then die with an uncaught ENOENT from the first write.
  // `mkdirSync(..., {recursive:true})` is a no-op when the dir already exists.
  for (const sub of ["objects", "events", "triggers", "runs"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  if (existsSync(join(dir, "config.json"))) return { dir, existed: true };
  // `profiles` are seeded ONLY on this CREATE path (an existing config returns
  // above untouched, so a re-init never clobbers hand-tuned profiles).
  const config: WorkspaceConfig = {
    backend,
    createdAt: now,
    ...(token ? { token } : {}),
    ...(profiles && Object.keys(profiles).length > 0 ? { profiles } : {}),
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  return { dir, existed: false };
}

export function readConfig(wsDir: string): WorkspaceConfig {
  const raw = readFileSync(join(wsDir, "config.json"), "utf8");
  const parsed = JSON.parse(raw) as WorkspaceConfig;
  if (typeof parsed.backend !== "string") {
    throw new DriverError("BAD_CONFIG", "config.json is missing a backend");
  }
  if (parsed.token !== undefined && typeof parsed.token !== "string") {
    throw new DriverError("BAD_CONFIG", "config.json `token` must be a string");
  }
  return parsed;
}

// ---- lockfile (held per command) ----

function acquireLock(wsDir: string): () => void {
  const lockPath = join(wsDir, "lock");
  let fd: number;
  try {
    // wx = create-exclusive: fails if the lock already exists (another command
    // holds the workspace). No retry loop — the demo driver fails loud.
    fd = openSync(lockPath, "wx");
  } catch {
    throw new DriverError("WORKSPACE_LOCKED", "another loopany-kernel command holds this workspace", {
      hint: "wait for it to finish, or remove .loopany/lock if it is stale",
    });
  }
  writeFileSync(lockPath, `${process.pid}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try {
      rmSync(lockPath);
    } catch {
      /* best-effort */
    }
  };
}

// ---- load Snapshot + events ----

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e: Dirent) => e.isFile() && e.name.endsWith(ext))
    .map((e: Dirent) => e.name)
    .sort();
}

export function loadSnapshot(wsDir: string): Snapshot {
  const objects: Record<string, ReturnType<typeof parseObject>> = {};
  for (const name of listFiles(join(wsDir, "objects"), ".md")) {
    const text = readFileSync(join(wsDir, "objects", name), "utf8");
    let obj;
    try {
      obj = parseObject(text);
    } catch (e) {
      throw new DriverError("CORRUPT_OBJECT", `objects/${name}: ${(e as Error).message}`);
    }
    // The filename IS the object's identity on disk. An `id` field that
    // disagrees with the basename (a hand-edit, a rename, or a copied file
    // carrying another object's id) would let the driver index by a name no
    // writer would ever find again, or silently shadow the first file with the
    // same id — the last-writer-wins corruption (C7). Since a well-formed file's
    // id EQUALS its (unique) basename, this one check subsumes duplicate-id
    // detection: two files cannot share a basename, so two valid ids never
    // collide in the index.
    const basename = name.slice(0, -".md".length);
    if (obj.id !== basename) {
      throw new DriverError(
        "CORRUPT_OBJECT",
        `objects/${name}: id "${obj.id}" does not match filename "${basename}"`,
        { hint: "the file's `id` field must equal its basename" },
      );
    }
    objects[obj.id] = obj;
  }
  const triggers: Trigger[] = [];
  for (const name of listFiles(join(wsDir, "triggers"), ".json")) {
    triggers.push(readJsonRecord(wsDir, "triggers", name, "CORRUPT_TRIGGER", validateTrigger));
  }
  const runs: RunRecord[] = [];
  for (const name of listFiles(join(wsDir, "runs"), ".json")) {
    runs.push(readJsonRecord(wsDir, "runs", name, "CORRUPT_RUN", validateRun));
  }
  return { objects, triggers, runs };
}

/** Read + JSON.parse a workspace record file, wrapping a parse failure into a
 *  DriverError instead of letting a raw SyntaxError escape past run()'s error
 *  boundary (C8), then SHAPE-validate the parsed value. Valid JSON is not enough:
 *  `null` / `{}` / a bad enum in triggers|runs/*.json parses cleanly but would
 *  crash a downstream renderer (dereferencing t.taskId) or feed the M3 tick junk.
 *  The `validate` guard completes the C8 corruption story for the two JSON
 *  tables — a shape drift is a rendered CORRUPT_* error, never a silent load. */
function readJsonRecord<T>(
  wsDir: string,
  sub: string,
  name: string,
  code: string,
  validate: (v: unknown, where: string) => T,
): T {
  const raw = readFileSync(join(wsDir, sub, name), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new DriverError(code, `${sub}/${name}: ${(e as Error).message}`, {
      hint: "the file is not valid JSON — it was hand-edited or truncated",
    });
  }
  let record: T & { id: string };
  try {
    record = validate(parsed, `${sub}/${name}`) as T & { id: string };
  } catch (e) {
    throw new DriverError(code, (e as Error).message, {
      hint: "the record's shape is invalid — it was hand-edited or written by a different version",
    });
  }
  // The filename IS the record's identity on disk (same argument as objects):
  // an `id` that disagrees with the basename lets a copied `triggers/copy.json`
  // carrying an existing id load cleanly and render the trigger/run TWICE. Since
  // two files cannot share a basename, requiring id == basename subsumes
  // duplicate-id detection for these two JSON tables exactly as it does for
  // objects — a duplicate can only exist under a second filename, which then
  // fails this check.
  const basename = name.slice(0, -".json".length);
  if (record.id !== basename) {
    throw new DriverError(
      code,
      `${sub}/${name}: id "${record.id}" does not match filename "${basename}"`,
      { hint: "the file's `id` field must equal its basename" },
    );
  }
  return record;
}

// ---- record shape guards (valid JSON is not a valid record) ----

/** The full RunState set (the kernel exports only ACTIVE_RUN_STATES; the closed
 *  terminal set is added here so a hand-written run row can be enum-checked). */
const RUN_STATES: readonly RunState[] = [...ACTIVE_RUN_STATES, "done", "failed", "superseded"];
const RUN_CAUSES = ["assignment", "cron", "once", "manual"] as const;
const TRIGGER_KINDS = ["cron", "once"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqStr(rec: Record<string, unknown>, key: string, where: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`${where}: field "${key}" must be a string`);
  return v;
}

function optStr(rec: Record<string, unknown>, key: string, where: string): string | null {
  const v = rec[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`${where}: field "${key}" must be a string or null`);
  return v;
}

function reqEnum<T extends string>(
  rec: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string,
): T {
  const v = reqStr(rec, key, where);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${where}: field "${key}" is not one of ${allowed.join(" | ")} (got "${v}")`);
  }
  return v as T;
}

function reqBool(rec: Record<string, unknown>, key: string, where: string): boolean {
  const v = rec[key];
  if (typeof v !== "boolean") throw new Error(`${where}: field "${key}" must be a boolean`);
  return v;
}

function validateTrigger(v: unknown, where: string): Trigger {
  if (!isRecord(v)) throw new Error(`${where}: a trigger must be a JSON object`);
  const disabledByRaw = optStr(v, "disabledBy", where);
  if (disabledByRaw !== null && disabledByRaw !== "owner" && disabledByRaw !== "invariant") {
    throw new Error(`${where}: field "disabledBy" is not one of owner | invariant | null`);
  }
  return {
    id: reqStr(v, "id", where),
    taskId: reqStr(v, "taskId", where),
    kind: reqEnum(v, "kind", TRIGGER_KINDS, where),
    spec: reqStr(v, "spec", where),
    timezone: optStr(v, "timezone", where),
    enabled: reqBool(v, "enabled", where),
    disabledBy: disabledByRaw as Trigger["disabledBy"],
    nextFireAt: optStr(v, "nextFireAt", where),
  };
}

function validateRun(v: unknown, where: string): RunRecord {
  if (!isRecord(v)) throw new Error(`${where}: a run must be a JSON object`);
  return {
    id: reqStr(v, "id", where),
    taskId: reqStr(v, "taskId", where),
    cause: reqEnum(v, "cause", RUN_CAUSES, where),
    scheduledAt: reqStr(v, "scheduledAt", where),
    state: reqEnum(v, "state", RUN_STATES, where),
    assignee: optStr(v, "assignee", where),
    triggerId: optStr(v, "triggerId", where),
    createdAt: reqStr(v, "createdAt", where),
    // sessionId (captured at claim, the transcript deep-dive key — §7 rung ⑤) and
    // note (left at finish) are OPTIONAL on RunRecord. Dropping them here erased
    // them on every reload: run-finish spreads the reloaded record, so a truncated
    // reload wrote sessionId:undefined back to disk. Preserve them verbatim.
    sessionId: optStr(v, "sessionId", where),
    note: optStr(v, "note", where),
  };
}

const EVENT_ENTRANCES = ["human", "agent-run", "clock"] as const;

/** Shape-guard one event line. Valid JSON is not a valid event: a `null` / `{}` /
 *  a line with a bad `provenance` parses cleanly but crashes the `--log` renderer
 *  (it dereferences `e.provenance.entrance`) with a raw TypeError that escapes
 *  run()'s DriverError catch (C8). We require the field set the renderer reads
 *  (kind / at / objectId / provenance) and validate provenance's own shape, so a
 *  drift is a rendered CORRUPT_EVENT, never an uncaught throw. We do NOT re-check
 *  the closed EventKind enum here — an unknown kind still renders as a one-liner
 *  and this guard's job is crash-safety, not schema totality.
 *
 *  The OPTIONAL renderer inputs are type-checked too: `render.ts` does
 *  `clip(e.note)` (a `.replace` on a non-string throws), `summarizeDiff(e.diff)`
 *  (dereferences each `{old,new}` entry — a null entry throws), and
 *  `session=${e.provenance.sessionId}`. A malformed-but-valid-JSON value there
 *  (a numeric `note`, a null-valued `diff` entry, a non-string `sessionId`)
 *  would escape as a raw TypeError, defeating this guard's crash-safety purpose;
 *  reject each as a CORRUPT_EVENT.
 *
 *  `expectedObjectId` is the stream's own object id (its filename): an event
 *  whose `objectId` names a DIFFERENT object was mis-filed (a hand-edit, a bad
 *  merge, a copied line) and would render in the wrong task's `--log` history —
 *  the events file is the append-only audit record (§3), so a cross-stream line
 *  is corruption, matching the id==basename posture on objects/triggers/runs. */
function validateEvent(v: unknown, where: string, expectedObjectId: string): KernelEvent {
  if (!isRecord(v)) throw new Error(`${where}: an event must be a JSON object`);
  const prov = v.provenance;
  if (!isRecord(prov)) throw new Error(`${where}: field "provenance" must be an object`);
  reqEnum(prov as Record<string, unknown>, "entrance", EVENT_ENTRANCES, `${where}.provenance`);
  reqStr(prov as Record<string, unknown>, "actorId", `${where}.provenance`);
  // sessionId is optional but, if present, MUST be a string (the renderer
  // interpolates it verbatim; a non-string would render but is a schema drift).
  optStr(prov as Record<string, unknown>, "sessionId", `${where}.provenance`);
  reqStr(v, "id", where);
  const objectId = reqStr(v, "objectId", where);
  if (objectId !== expectedObjectId) {
    throw new Error(
      `${where}: event objectId "${objectId}" does not match the stream "${expectedObjectId}"`,
    );
  }
  reqStr(v, "kind", where);
  reqStr(v, "at", where);
  // note: optional, but the renderer does clip(note).replace(...) — a non-string
  // throws a raw TypeError. Require string-or-absent.
  if (v.note !== undefined && v.note !== null && typeof v.note !== "string") {
    throw new Error(`${where}: field "note" must be a string`);
  }
  // diff: optional, but summarizeDiff dereferences {old,new} on each ENTRY — a
  // non-object entry (or a null one) throws. Require a record whose values are
  // objects (old/new may be any JSON value).
  if (v.diff !== undefined && v.diff !== null) {
    if (!isRecord(v.diff)) throw new Error(`${where}: field "diff" must be an object`);
    for (const [k, entry] of Object.entries(v.diff)) {
      if (!isRecord(entry)) {
        throw new Error(`${where}: diff entry "${k}" must be an object with old/new`);
      }
    }
  }
  return v as unknown as KernelEvent;
}

/** Load one object's full event stream (the `--log` source). Chronological by
 *  append order (the JSONL is append-only). */
export function loadEvents(wsDir: string, objectId: string): KernelEvent[] {
  const name = `${safeName(objectId)}.jsonl`;
  const path = join(wsDir, "events", name);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const events: KernelEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (e) {
      // A corrupt JSONL line must not escape as a raw SyntaxError past run()'s
      // catch (C8) — wrap it into a rendered DriverError with the line number.
      throw new DriverError("CORRUPT_EVENT", `events/${name}: line ${i + 1}: ${(e as Error).message}`, {
        hint: "an event line is not valid JSON — the stream was hand-edited or truncated",
      });
    }
    // Valid JSON is not enough: a `null` / `{}` / bad-provenance line parses
    // cleanly but would crash the `--log` renderer. Shape-guard it into the same
    // rendered CORRUPT_EVENT (C8), matching readJsonRecord's posture.
    try {
      events.push(validateEvent(parsed, `events/${name}: line ${i + 1}`, objectId));
    } catch (e) {
      throw new DriverError("CORRUPT_EVENT", (e as Error).message, {
        hint: "an event line has the wrong shape — the stream was hand-edited or written by a different version",
      });
    }
  }
  return events;
}

/** id -> a filesystem-safe basename. Kernel ids are slugs/hashes (safe already),
 *  but a mirror id or a hostile hand-edited id could carry a separator; refuse
 *  path escape rather than write outside the workspace. */
function safeName(id: string): string {
  if (id.length === 0 || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new DriverError("BAD_ID", `unsafe object id "${id}"`);
  }
  return id;
}

// ---- persist a validated fold ----

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Persist the DIFF between a before/after snapshot plus append events. Only the
 *  objects/triggers/runs the changeset touched are re-written (the changeset
 *  IS that set), so an unrelated file is never rewritten. */
function persist(
  wsDir: string,
  before: Snapshot,
  after: Snapshot,
  events: readonly KernelEvent[],
): void {
  // Objects: write every object whose serialized form changed.
  for (const [id, obj] of Object.entries(after.objects)) {
    if (before.objects[id] === obj) continue; // identical reference => untouched
    let serialized: string;
    try {
      serialized = serializeObject(obj);
    } catch (e) {
      // serializeObject wraps the codec's write-side ceilings (e.g. an oversize
      // body) into a CodecError; surface it as a rendered OBJECT_TOO_LARGE
      // DriverError at the persist seam rather than a raw stack. The lock's
      // finally-release still runs, and the fold is not committed.
      if (e instanceof CodecError) {
        throw new DriverError("OBJECT_TOO_LARGE", `objects/${id}: ${e.message}`, {
          hint: "the object exceeds a codec ceiling — shrink the body or split it into a doc",
        });
      }
      throw e;
    }
    writeFileAtomic(join(wsDir, "objects", `${safeName(id)}.md`), serialized);
  }
  // Triggers: write puts, delete removed ids.
  const afterTrigIds = new Set(after.triggers.map((t) => t.id));
  for (const t of after.triggers) {
    const prev = before.triggers.find((p) => p.id === t.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(t)) continue;
    writeFileAtomic(join(wsDir, "triggers", `${safeName(t.id)}.json`), JSON.stringify(t, null, 2) + "\n");
  }
  for (const t of before.triggers) {
    if (!afterTrigIds.has(t.id)) rmSync(join(wsDir, "triggers", `${safeName(t.id)}.json`), { force: true });
  }
  // Runs: write puts (runs are never deleted, only state-transitioned).
  for (const r of after.runs) {
    const prev = before.runs.find((p) => p.id === r.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(r)) continue;
    writeFileAtomic(join(wsDir, "runs", `${safeName(r.id)}.json`), JSON.stringify(r, null, 2) + "\n");
  }
  // Events: append-only, one stream per object. This is the crash window — a
  // crash between the writes above and this append leaves the fold persisted but
  // an event unrecorded. Accepted for the demo tier (§9).
  const byObject = new Map<string, KernelEvent[]>();
  for (const e of events) {
    const list = byObject.get(e.objectId) ?? [];
    list.push(e);
    byObject.set(e.objectId, list);
  }
  for (const [objectId, list] of byObject) {
    const path = join(wsDir, "events", `${safeName(objectId)}.jsonl`);
    appendFileSync(path, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

// ---- the command loop ----

export interface CommandResult {
  snapshot: Snapshot;
  notices: string[];
  result?: { id: string; existing?: boolean };
}

/** decide -> applyChangeset -> persist, under the workspace lock. `dryRun`
 *  stops after decide (validate-only, zero persistence — the `--dry-run` path).
 *
 *  `guard` is a caller precondition evaluated against the LOCKED snapshot, BEFORE
 *  decide. It exists to close read-then-write TOCTOU races that a pre-lock read in
 *  the verb layer cannot (e.g. `doc put`'s "already exists?" check): a caller that
 *  reads outside the lock can be raced by a concurrent command in the window; a
 *  guard runs inside the same lock the write commits under, so its view is the one
 *  the command actually acts on. It throws a DriverError to refuse. */
export function runCommand(
  wsDir: string,
  command: Command,
  actor: Provenance,
  now: string,
  opts: { dryRun?: boolean; guard?: (locked: Snapshot) => void } = {},
): CommandResult {
  const release = opts.dryRun ? () => {} : acquireLock(wsDir);
  try {
    const before = loadSnapshot(wsDir);
    if (opts.guard) opts.guard(before);
    const decision = decide(command, before, actor, now);
    if (!decision.ok) throw refusalToError(decision.refusal);
    if (opts.dryRun) {
      return { snapshot: before, notices: decision.notices, result: decision.result };
    }
    const applied = applyChangeset(before, decision.changeset);
    if (!applied.ok) throw conflictToError(applied.conflict);
    persist(wsDir, before, applied.snapshot, decision.changeset.events);
    return { snapshot: applied.snapshot, notices: decision.notices, result: decision.result };
  } finally {
    release();
  }
}

/** A read that needs the current snapshot without a write (show/list/…). No
 *  lock — reads tolerate the demo driver's crash window. */
export function readSnapshot(wsDir: string): Snapshot {
  return loadSnapshot(wsDir);
}

export interface TickResultReport {
  /** One notice per fire outcome (fired / superseded / discarded / skipped …),
   *  straight from the kernel's tick. */
  notices: string[];
  /** The number of per-fire changesets that were applied. */
  applied: number;
  /** The final snapshot after every fire folded. */
  snapshot: Snapshot;
}

/** Run the kernel's `tick(now)` and persist each per-fire changeset ATOMICALLY.
 *
 *  tick returns one changeset PER FIRE precisely so a host can apply each on its
 *  own; we hold the workspace lock for the whole tick, then apply every changeset
 *  through `applyChangeset` (CAS-validated) folding the working snapshot forward,
 *  and persist the diff + events per fire. A conflict on any single fire aborts the
 *  tick with the typed DriverError (the earlier fires that already persisted stay —
 *  each fire is its own transaction, the spec's "atomically-per-fire" guarantee).
 *
 *  The clock is a PARAMETER (`now`): tests inject a deterministic instant, so tick
 *  is reproducible with no wall-clock read anywhere in the kernel or the driver. */
export function runTick(wsDir: string, now: string): TickResultReport {
  const release = acquireLock(wsDir);
  try {
    const before = loadSnapshot(wsDir);
    const result = tick(before, now);
    let working = before;
    let applied = 0;
    for (const cs of result.changesets) {
      const res = applyChangeset(working, cs);
      if (!res.ok) throw conflictToError(res.conflict);
      persist(wsDir, working, res.snapshot, cs.events);
      working = res.snapshot;
      applied++;
    }
    return { notices: result.notices, applied, snapshot: working };
  } finally {
    release();
  }
}

// re-export for the conformance harness / CLI
export { CodecError };
