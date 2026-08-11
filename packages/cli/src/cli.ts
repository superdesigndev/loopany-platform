/**
 * The `loopany-kernel` verb dispatch. Human and agent share ONE surface (§10).
 *
 *   Read : show <id> [--log] · list [--status|--assignee|--due] · search · inbox
 *   Write: create · update <id> k=v… [--note] [--if-version] · note
 *          doc put <key> [--file --task <id>] · doc list · mirror add <kind> <coords>
 *   Host : init [--backend local]   (remote backend lands in M6)
 *
 * Every verb accepts --json — INCLUDING usage errors (§10: 全部 --json), which
 * render as {ok:false, code:"USAGE", message}. Write verbs accept --dry-run
 * (decide without apply). Refusals/conflicts render as error:/code:/hint: text,
 * exit 1; usage errors exit 2. Notices print LOUDLY. Argument parsing runs
 * INSIDE the error boundary, so a bad flag is a rendered usage error, not a
 * throw.
 *
 * This module is I/O-shaped only at its edges (fs via the driver, stdout via the
 * returned strings) so it is fully testable against a temp dir: `run(argv, deps)`
 * returns `{ stdout, stderr, exitCode }` and never calls process.exit itself.
 */
import {
  type Command,
  type CreateCommand,
  type Provenance,
  type Snapshot,
  type TaskObject,
  inboxView,
  loopsView,
  slugify,
  sortTasksForList,
  treeView,
} from "@loopany/kernel";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UsageError, parseArgs, type ParsedArgs } from "./args.js";
import {
  DriverError,
  type CommandResult,
  type TickResultReport,
  initWorkspace,
  requireWorkspace,
} from "./driver.js";
import { type Backend, selectBackend } from "./backend.js";
import {
  clip,
  renderError,
  renderFlatList,
  renderInbox,
  renderLoops,
  renderNotices,
  renderSearchHits,
  renderTimeline,
  renderShow,
  renderTree,
} from "./render.js";
import { handbackTargetFor } from "./prompt.js";
import { realSpawn, resolveSelfBin, spawnPendingRuns, type SpawnFn, type SpawnReport } from "./spawn.js";
import type { SyncTransport } from "./remote.js";
import { realProbe, seedProfiles, type ProbeFn } from "./seedProfiles.js";
import {
  readRegistry,
  registerWorkspace,
  unregisterWorkspace,
  type RegistryEntry,
} from "./registry.js";

export interface CliDeps {
  cwd: string;
  now: string;
  env: Record<string, string | undefined>;
  /** The process-spawn seam for `tick --spawn` (§13 M4). Injectable so tests
   *  drive a fake agent with no real subprocess; the bin passes `realSpawn`. */
  spawn?: SpawnFn;
  /** The remote-backend HTTP transport seam (§13 M6). Injectable so the
   *  conformance harness drives the in-process server route with no subprocess;
   *  the bin leaves it undefined (the default child-process transport). */
  transport?: SyncTransport;
  /** Absolute path of the CLI entry recorded in the workspace registry at `init`
   *  (so the daemon replays THIS binary). The bin passes `process.argv[1]`; tests
   *  pass a stub. Falls back to argv[1] when absent. */
  binPath?: string;
  /** The registry home dir override (`.loopany/kernel.json` lives under it).
   *  Injected in tests so the real `~/.loopany` is never written; the bin leaves
   *  it undefined (the OS home). */
  registryHome?: string;
  /** PATH-probe seam for default profile seeding at `init`. Injected in tests so
   *  the seed never depends on the host's installed agents; the bin passes the
   *  real PATH probe. */
  probe?: ProbeFn;
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function ok(stdout: string): CliOutcome {
  return { stdout, stderr: "", exitCode: 0 };
}

// ---- actor provenance ----

/** entrance=human by default; --session / --actor / LOOPANY_SESSION_ID promote
 *  to agent-run provenance (every agent action is attributable to a session —
 *  §3). --actor sets actorId; the default human actor is LOOPANY_ACTOR or "cli". */
function resolveActor(args: ParsedArgs, env: CliDeps["env"]): Provenance {
  const sessionId = args.flags.session ?? env.LOOPANY_SESSION_ID;
  const explicitActor = args.flags.actor;
  if (sessionId !== undefined || explicitActor !== undefined) {
    return {
      entrance: "agent-run",
      actorId: explicitActor ?? env.LOOPANY_ACTOR ?? "agent",
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }
  return { entrance: "human", actorId: env.LOOPANY_ACTOR ?? "cli" };
}

/** The effective `now`: a hidden `--now <iso>` flag (or `LOOPANY_NOW` env) pins a
 *  deterministic instant over the wall clock in `deps.now` (§13 M3). An invalid
 *  instant is a plain usage error rather than a silent fall-through to the clock,
 *  which would make a mistyped `--now` invisibly non-deterministic. */
function resolveNow(args: ParsedArgs, deps: CliDeps): string {
  const override = args.flags.now ?? deps.env.LOOPANY_NOW;
  if (override === undefined) return deps.now;
  if (!Number.isFinite(Date.parse(override))) {
    throw new UsageError(`--now must be an ISO instant, got "${override}"`);
  }
  return override;
}

// ---- value coercion for the update patch grammar ----

/** Coerce a `k=v` string value for the update patch. The kernel validates
 *  TYPES, so we only turn the wire syntax into the JSON shape it expects:
 *  `null` -> null, `refs` -> string[], `if-version`/version-ish stays string
 *  here (kernel reads ifVersion off the command, not the patch). */
function coercePatchValue(key: string, raw: string): unknown {
  if (raw === "null") return null;
  if (key === "refs") return raw.length === 0 ? [] : raw.split(",").map((s) => s.trim());
  return raw;
}

/** `--if-version N` must be a NON-NEGATIVE INTEGER. Unchecked `Number()` turns
 *  `abc` into NaN and `` into 0, both of which the kernel then reports as a
 *  bogus concurrency CONFLICT ("expected NaN") — a usage error misclassified
 *  (C5). Reject here, before the command is built, as a plain usage error.
 *
 *  A digit string above Number.MAX_SAFE_INTEGER still `Number()`-rounds to the
 *  nearest float (…993 -> …992), so the CAS token compared downstream is NOT the
 *  one the caller supplied — a silent mutation. That is §12-recorded M5 debt:
 *  the unsafe-integer refusal lands with the zod input-validation pass (all three
 *  boundaries share one schema), not as a hand-rolled check here. */
function parseIfVersion(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`--if-version must be a non-negative integer, got "${raw}"`);
  }
  return Number(trimmed);
}

// ---- write-verb execution (shared decide/apply/render path) ----

function execWrite(
  backend: Backend,
  command: Command,
  args: ParsedArgs,
  deps: CliDeps,
  guard?: (locked: Snapshot) => void,
): CliOutcome {
  const actor = resolveActor(args, deps.env);
  const dryRun = args.bools.has("dry-run");
  const res = backend.command(command, actor, resolveNow(args, deps), { dryRun, guard });
  return renderWriteResult(res, args, dryRun);
}

/** Select the backend for a verb, injecting the fetch/transport seam if deps
 *  provide one (tests / conformance harness). All verbs but `init` go through
 *  this — `init` creates the workspace, it does not read one. */
function backendFor(deps: CliDeps): Backend {
  return selectBackend(deps.cwd, deps.env, deps.transport);
}

function renderWriteResult(res: CommandResult, args: ParsedArgs, dryRun: boolean): CliOutcome {
  if (args.bools.has("json")) {
    return ok(
      JSON.stringify(
        { ok: true, dryRun, result: res.result ?? null, notices: res.notices },
        null,
        2,
      ),
    );
  }
  const lines: string[] = [];
  if (dryRun) lines.push("(dry-run — nothing persisted)");
  if (res.result) lines.push(res.result.existing ? `ok ${res.result.id} (existing)` : `ok ${res.result.id}`);
  else lines.push("ok");
  if (res.notices.length > 0) lines.push(renderNotices(res.notices));
  return ok(lines.join("\n"));
}

// ---- verbs ----

function verbInit(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const backend = args.flags.backend ?? "local";
  // `local` (default) is the file driver; anything else is a server URL and
  // selects the M6 remote backend (every verb then POSTs the Command there). A
  // remote backend must look like an http(s) URL — a typo like `--backend prod`
  // that is neither `local` nor a URL is a loud usage error, never a silent
  // treat-as-URL that fails obscurely at the first request.
  if (backend !== "local" && !/^https?:\/\//.test(backend)) {
    throw new UsageError(
      `--backend must be "local" or an http(s) server URL, got "${backend}"`,
    );
  }
  // A `--token <dk_…>` is stored in config for the remote backend (a local
  // workspace ignores it). LOOPANY_KERNEL_TOKEN overrides it at run time.
  const token = backend === "local" ? undefined : args.flags.token;
  // Seed default profiles from PATH - ONLY matters on a fresh create (initWorkspace
  // never overwrites an existing config's profiles). We probe unconditionally and
  // pass the block; on an already-existing workspace `existed` comes back true and
  // the seed was ignored, so we report it as such rather than claim a seed.
  const { profiles, seeded } = seedProfiles(deps.probe ?? realProbe);
  const { dir, existed } = initWorkspace(deps.cwd, backend, deps.now, token, profiles);
  // Auto-register the workspace so the resident daemon ticks it. Best-effort: a
  // registry write failure warns but never fails init (the workspace is created
  // regardless; the user can `register` later). The registry `dir` is the
  // workspace ROOT that HOLDS `.loopany/` (the daemon's spawn cwd), not the
  // `.loopany/` dir `initWorkspace` returns - matching `register`/`unregister`.
  //
  // `--no-register` skips this entirely: a simulator sandbox runs on a virtual
  // clock (`LOOPANY_NOW`), so the resident real-clock daemon must never tick it.
  const skipRegister = args.bools.has("no-register");
  const root = repoRootOf(dir);
  const bin = deps.binPath ?? process.argv[1] ?? "loopany-kernel";
  let registerWarning: string | undefined;
  if (!skipRegister) {
    try {
      registerWorkspace({ dir: root, bin }, { home: deps.registryHome });
    } catch (e) {
      registerWarning = `could not register workspace for auto-tick: ${(e as Error).message}`;
    }
  }
  const seededLine =
    existed
      ? undefined
      : seeded.length > 0
        ? `profiles seeded: ${seeded.join(", ")}`
        : "profiles seeded: none (no agent binaries found on PATH)";
  if (args.bools.has("json")) {
    return ok(
      JSON.stringify(
        {
          ok: true,
          dir,
          existed,
          backend,
          registered: !skipRegister && registerWarning === undefined,
          ...(skipRegister ? { registerSkipped: true } : {}),
          ...(existed ? {} : { profilesSeeded: seeded }),
          ...(registerWarning ? { warning: registerWarning } : {}),
        },
        null,
        2,
      ),
    );
  }
  const lines = [
    existed
      ? `workspace already initialized at ${dir}`
      : `initialized ${dir} (backend: ${backend})`,
  ];
  if (seededLine) lines.push(seededLine);
  if (skipRegister) lines.push("registry: skipped (--no-register)");
  if (registerWarning) lines.push(`warning: ${registerWarning}`);
  return ok(lines.join("\n"));
}

/** `register` / `unregister` - enroll (or drop) THIS workspace in the registry
 *  the resident daemon reads to auto-tick local kernels. Operate on the discovered
 *  workspace from cwd (same walk-up as every other verb), so the recorded `dir` is
 *  the repo root holding `.loopany/`, not the `.loopany/` dir itself. */
function verbRegister(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const wsDir = requireWorkspace(deps.cwd);
  const dir = repoRootOf(wsDir);
  const bin = deps.binPath ?? process.argv[1] ?? "loopany-kernel";
  const entry: RegistryEntry = { dir, bin };
  registerWorkspace(entry, { home: deps.registryHome });
  if (args.bools.has("json")) return ok(JSON.stringify({ ok: true, registered: true, dir, bin }, null, 2));
  return ok(`registered ${dir} for daemon auto-tick`);
}

function verbUnregister(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const wsDir = requireWorkspace(deps.cwd);
  const dir = repoRootOf(wsDir);
  const { removed } = unregisterWorkspace(dir, { home: deps.registryHome });
  if (args.bools.has("json")) return ok(JSON.stringify({ ok: true, removed, dir }, null, 2));
  return ok(removed ? `unregistered ${dir}` : `${dir} was not registered`);
}

/** The repo root holding a `.loopany/` dir is its parent. */
function repoRootOf(wsDir: string): string {
  return resolve(wsDir, "..");
}

function bodyFromFile(args: ParsedArgs, deps: CliDeps, key: string): string | undefined {
  const file = args.flags[key];
  if (file === undefined) return undefined;
  // Resolve RELATIVE to deps.cwd, not the process CWD. run() is a testable
  // library surface (the M6 conformance harness drives it with a deps.cwd that
  // differs from process.cwd()), so a bare readFileSync(file) would look for the
  // file next to the harness/process, not the workspace the caller named. An
  // absolute path is returned unchanged by resolve().
  const path = resolve(deps.cwd, file);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new UsageError(`cannot read --${key} "${file}"`);
  }
}

function verbCreate(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const title = args.positionals[0];
  if (title === undefined) throw new UsageError('create needs a "<title>"');
  // Noun-style confusion guard (haiku-6: `create task --id ...` in the style of
  // `gh pr create` - the noun lands as the TITLE and every task is called
  // "task"). A bare kind-noun is never a real title; refuse loudly so the
  // agent corrects instead of silently shipping an unnamed task.
  if (/^(task|doc|mirror)$/i.test(title.trim())) {
    throw new UsageError(
      `"${title}" looks like a kind, not a title - the syntax is: create "<title>" [--id <id>] [flags]`,
    );
  }
  const cmd: CreateCommand = { op: "create", title };
  if (args.flags.id) cmd.id = args.flags.id;
  if (args.flags.parent) cmd.parent = args.flags.parent;
  if (args.flags.tracks) cmd.tracks = args.flags.tracks;
  if (args.flags.assignee) cmd.assignee = args.flags.assignee;
  if (args.flags.owner) cmd.owner = args.flags.owner;
  if (args.flags.workdir) cmd.workdir = args.flags.workdir;
  if (args.flags.goal) cmd.goal = args.flags.goal;
  if (args.flags.type) cmd.type = args.flags.type;
  const priority = args.flags.p ?? args.flags.priority;
  if (priority) cmd.priority = priority;
  if (args.flags.status) cmd.status = args.flags.status;
  if (args.flags.cron) cmd.cron = args.flags.cron;
  if (args.flags.timezone) cmd.timezone = args.flags.timezone;
  if (args.flags["follow-up"]) cmd.followUpAt = args.flags["follow-up"];
  const body = bodyFromFile(args, deps, "body-file");
  if (body !== undefined) cmd.body = body;
  return execWrite(backendFor(deps), cmd, args, deps);
}

function verbUpdate(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const id = args.positionals[0];
  if (id === undefined) throw new UsageError("update needs an <id>");
  if (args.assigns.length === 0 && args.flags.note === undefined) {
    throw new UsageError("update needs at least one k=v pair or --note");
  }
  const patch: Record<string, unknown> = {};
  for (const [k, v] of args.assigns) patch[k] = coercePatchValue(k, v);
  // `--follow-up <date>` is the taught grammar for `status=follow-up` (CORE step 4,
  // SKILL.md, the once scenario). It parses (it is in the args OPTIONS table), so
  // dropping it would be the silent-flag-loss the args header bans — mirror
  // verbCreate and map it into the patch (a bare `followUpAt=<date>` assign still
  // works and wins if both are given, since assigns are applied first).
  if (args.flags["follow-up"] && patch.followUpAt === undefined) {
    patch.followUpAt = args.flags["follow-up"];
  }
  const cmd: Command = {
    op: "update",
    id,
    patch,
    ...(args.flags.note !== undefined ? { note: args.flags.note } : {}),
    ...(args.flags["if-version"] !== undefined
      ? { ifVersion: parseIfVersion(args.flags["if-version"]) }
      : {}),
  };
  return execWrite(backendFor(deps), cmd, args, deps);
}

function verbNote(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const id = args.positionals[0];
  let note = args.positionals[1];
  // FREE-TEXT RESCUE: the tokenizer classifies ANY bare token containing "=" as
  // a k=v assign, so a note whose TEXT mentions e.g. `status=done` (this
  // system's everyday vocabulary) used to vanish into args.assigns and die as
  // a usage error - an agent-facing trap. `note` takes no assigns, so a lone
  // assign next to a lone positional IS the text: rebuild it verbatim.
  if (note === undefined && args.positionals.length === 1 && args.assigns.length === 1) {
    note = args.assigns[0]!.join("=");
  }
  if (id === undefined || note === undefined) throw new UsageError('note needs <id> "<text>"');
  return execWrite(backendFor(deps), { op: "note", id, note }, args, deps);
}

function verbDoc(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const sub = args.positionals[0];
  if (sub === "list") return docList(deps, args);
  if (sub !== "put") throw new UsageError('doc supports "doc put <key> [--file f.md] [--task <id>]" and "doc list"');
  const key = args.positionals[1];
  if (key === undefined) throw new UsageError("doc put needs a <key>");
  const backend = backendFor(deps);
  const fileBody = bodyFromFile(args, deps, "file");
  // `doc put` is an upsert. Defaulting a missing --file to "" is fine for
  // CREATION (an empty-body doc is a legal first version), but on an EXISTING
  // doc it silently WIPES the stored body down to empty — confirmed data loss.
  // Refuse the no-file upsert of an existing key; an explicit empty --file still
  // works if the caller really means to blank it.
  //
  // The existence check MUST run against the LOCKED snapshot: a pre-lock read
  // here can be raced by a concurrent `doc put` that creates the key in the
  // window between the read and the lock, so a bare `doc put` that saw "no doc"
  // would then wipe the body written under it (TOCTOU). The LOCAL backend closes
  // that with a guard evaluated inside the write lock; the REMOTE backend's guard
  // runs against a pre-POST snapshot (there is no client-held lock at the server),
  // so the guard alone leaves an identical wipe window: A sees no doc, B creates
  // it, A's POSTed doc-put wipes B's body. We therefore ALSO carry `ifVersion: 0`
  // on the create-only path, which decideDocPut enforces at the AUTHORITY — an
  // absent doc passes (0 vs no existing version), an existing doc CONFLICTs (its
  // version can never be 0). The guard is retained only for its friendlier exit-2
  // usage message on the local path (and as a fast pre-POST reject on the remote).
  const bareCreate = fileBody === undefined;
  const guard = bareCreate
    ? (locked: Snapshot) => {
        if (locked.objects[slugify(key)] !== undefined) {
          // A UsageError (not a DriverError) so it renders as an exit-2 usage
          // error, consistent with the pre-lock guard this replaces.
          throw new UsageError(
            `doc "${key}" already exists — pass --file to replace its body ` +
              "(a bare `doc put` with no --file would wipe it)",
          );
        }
      }
    : undefined;
  const body = fileBody ?? "";
  // The atomic attach: --task wins; inside a run the ambient LOOPANY_TASK_ID
  // fills it in, so a bare `doc put` from an agent pass auto-attaches to the
  // task that is running (six sim rounds proved the separate second step
  // simply never happens). Out-of-run owner puts stay unattached by default.
  const attachTask = args.flags.task ?? deps.env.LOOPANY_TASK_ID;
  const command: Command = {
    op: "doc-put",
    key,
    body,
    ...(attachTask ? { attachTask } : {}),
    ...(bareCreate ? { ifVersion: 0 } : {}),
  };
  return execWrite(backend, command, args, deps, guard);
}

/** `doc list` — the doc enumeration a workspace never had (docs were only
 *  reachable by knowing the key, or a lucky `search`). One line per doc. */
function docList(deps: CliDeps, args: ParsedArgs): CliOutcome {
  const snapshot = backendFor(deps).snapshot();
  const docs = Object.values(snapshot.objects)
    .filter((o) => o.archetype === "doc")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (args.bools.has("json")) return ok(JSON.stringify(docs, null, 2));
  if (docs.length === 0) return ok("(no docs)");
  return ok(
    docs
      .map((d) =>
        d.archetype === "doc"
          ? `${d.id}  (v${d.version})  ${d.updatedAt}  ${clip(d.title ?? "", 40) || "—"}`
          : "",
      )
      .join("\n"),
  );
}

/** `mirror list` — the mirror twin of `doc list`. One line per pointer. */
function mirrorList(deps: CliDeps, args: ParsedArgs): CliOutcome {
  const snapshot = backendFor(deps).snapshot();
  const mirrors = Object.values(snapshot.objects)
    .filter((o) => o.archetype === "mirror")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (args.bools.has("json")) return ok(JSON.stringify(mirrors, null, 2));
  if (mirrors.length === 0) return ok("(no mirrors)");
  return ok(
    mirrors
      .map((m) => (m.archetype === "mirror" ? `${m.id}  [${m.kind}]  ${m.coords}` : ""))
      .join("\n"),
  );
}

function verbMirror(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const sub = args.positionals[0];
  if (sub === "list") return mirrorList(deps, args);
  if (sub !== "add") throw new UsageError('mirror supports "mirror add <kind> <coords>" and "mirror list"');
  const kind = args.positionals[1];
  const coords = args.positionals[2];
  if (kind === undefined || coords === undefined) throw new UsageError("mirror add needs <kind> <coords>");
  // Same atomic attach as `doc put`: --task wins, the ambient in-run
  // LOOPANY_TASK_ID fills it otherwise, out-of-run adds stay unattached.
  const attachTask = args.flags.task ?? deps.env.LOOPANY_TASK_ID;
  return execWrite(
    backendFor(deps),
    { op: "mirror-add", kind, coords, ...(attachTask ? { attachTask } : {}) },
    args,
    deps,
  );
}

// ---- reads ----

function verbShow(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const id = args.positionals[0];
  if (id === undefined) throw new UsageError("show needs an <id>");
  const backend = backendFor(deps);
  const snapshot = backend.snapshot();
  const obj = snapshot.objects[id];
  if (!obj) throw new DriverError("UNKNOWN_OBJECT", `no object "${id}"`);
  const events = args.bools.has("log") ? backend.events(id) : null;
  if (args.bools.has("json")) {
    // The JSON envelope must carry the SAME four record classes the text view
    // surfaces (§3), or --json is strictly weaker than text — a break M6
    // conformance would then bake in. A task's live triggers + its one active
    // run ride alongside the object/events (empty for non-task archetypes).
    const triggers =
      obj.archetype === "task" ? snapshot.triggers.filter((t) => t.taskId === obj.id) : [];
    const activeRun =
      obj.archetype === "task"
        ? snapshot.runs.find(
            (r) =>
              r.taskId === obj.id &&
              (r.state === "pending" || r.state === "claimed" || r.state === "running"),
          ) ?? null
        : null;
    return ok(
      JSON.stringify(
        { object: obj, triggers, activeRun, events: events ?? undefined },
        null,
        2,
      ),
    );
  }
  return ok(renderShow(obj, snapshot, events));
}

function verbList(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const snapshot = backendFor(deps).snapshot();
  // The due-filter and the tree's due markers both read "now"; route through
  // resolveNow so `--now`/LOOPANY_NOW (§13 M3, a deterministic-read requirement
  // M6's golden conformance depends on) actually steers the output instead of
  // being parsed and silently ignored.
  const now = resolveNow(args, deps);
  const filters = {
    status: args.flags.status,
    assignee: args.flags.assignee,
    due: args.bools.has("due") || args.flags.due !== undefined,
  };
  // `--tree` (spec §10) forces the tree view explicitly — the default when no
  // filter is present, but also selectable OVER a filter so the caller can ask
  // for the full tree regardless. The M6 golden conformance script uses the
  // spec's verbs literally, so the flag must at minimum be accepted.
  const filtered = Boolean(filters.status || filters.assignee || filters.due);
  if (args.bools.has("tree") || !filtered) {
    const tree = treeView(snapshot);
    if (args.bools.has("json")) return ok(JSON.stringify(tree, null, 2));
    return ok(renderTree(tree, snapshot, now));
  }
  const list = sortTasksForList(matchTasks(snapshot, filters, now));
  if (args.bools.has("json")) return ok(JSON.stringify(list, null, 2));
  return ok(renderFlatList(list, snapshot));
}

function matchTasks(
  snapshot: Snapshot,
  f: { status?: string; assignee?: string; due: boolean },
  now: string,
): TaskObject[] {
  return tasksOf(snapshot).filter((t) => {
    if (f.status && t.status !== f.status) return false;
    if (f.assignee && t.assignee !== f.assignee) return false;
    if (f.due) {
      if (t.status !== "follow-up" || !t.followUpAt) return false;
      if (Date.parse(t.followUpAt) > Date.parse(now)) return false;
    }
    return true;
  });
}

function tasksOf(snapshot: Snapshot): TaskObject[] {
  return Object.values(snapshot.objects).filter((o): o is TaskObject => o.archetype === "task");
}

function verbSearch(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const kw = args.positionals[0];
  if (kw === undefined) throw new UsageError("search needs a <keyword>");
  const needle = kw.toLowerCase();
  const snapshot = backendFor(deps).snapshot();
  const hits = Object.values(snapshot.objects).filter((o) => {
    if (o.id.toLowerCase().includes(needle)) return true;
    if (o.archetype === "task") return o.title.toLowerCase().includes(needle) || o.body.toLowerCase().includes(needle);
    if (o.archetype === "doc") {
      return (o.title ?? "").toLowerCase().includes(needle) || o.body.toLowerCase().includes(needle) || o.key.toLowerCase().includes(needle);
    }
    return o.coords.toLowerCase().includes(needle) || o.kind.toLowerCase().includes(needle);
  });
  if (args.bools.has("json")) return ok(JSON.stringify(hits, null, 2));
  return ok(renderSearchHits(hits));
}

function verbInbox(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const me = args.flags.assignee ?? args.flags.actor ?? deps.env.LOOPANY_ACTOR ?? deps.env.LOOPANY_INBOX;
  if (me === undefined) {
    throw new UsageError("inbox needs --assignee <me> (or set LOOPANY_ACTOR / LOOPANY_INBOX)");
  }
  const snapshot = backendFor(deps).snapshot();
  // inboxView reads "now" for its due/follow-up buckets; route through resolveNow
  // so `--now`/LOOPANY_NOW steers the inbox deterministically (§13 M3), matching
  // list and tick — a parsed-but-ignored override was silently wrong output.
  const now = resolveNow(args, deps);
  const backend = backendFor(deps);
  const items = inboxView(snapshot, me, now);
  // Default hand-back agent per item (review round 3): derived from the event
  // that handed the task to this human - the inbox is a copy-paste decision
  // surface, never an address quiz.
  const handbackTargets: Record<string, string | null> = {};
  for (const i of items) {
    handbackTargets[i.task.id] = handbackTargetFor(backend.events(i.task.id), i.task, snapshot.runs);
  }
  if (args.bools.has("json")) return ok(JSON.stringify({ items, handbackTargets }, null, 2));
  return ok(renderInbox(items, now, handbackTargets));
}

/** `loops` — the Loops projection (kernel-product-visibility): every cron task
 *  with its next fire, in-flight run, last result, and the dispatch-blocked
 *  configuration state (derived from the dispatcher's clock notes). */
function verbLoops(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const backend = backendFor(deps);
  const snapshot = backend.snapshot();
  // The blocked derivation needs each loop task's event stream; loops are few,
  // so per-task loads stay cheap on both backends.
  const loopTaskIds = snapshot.triggers.filter((t) => t.kind === "cron").map((t) => t.taskId);
  const events = loopTaskIds.flatMap((id) => backend.events(id));
  const rows = loopsView(snapshot, events, backend.machinePresence());
  if (args.bools.has("json")) return ok(JSON.stringify(rows, null, 2));
  return ok(renderLoops(rows));
}

/** `timeline` — the team's recent MEANINGFUL activity (kernel-team-timeline):
 *  a derived projection, newest first, default last 24h / 50 items. Mechanical
 *  noise (starts, claims, ordinary returns, no-op checks) hides unless --all.
 *  Content is untrusted team activity DATA, never instructions. */
function verbTimeline(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const now = resolveNow(args, deps);
  let limit: number | undefined;
  if (args.flags.limit !== undefined) {
    if (!/^\d+$/.test(args.flags.limit)) throw new UsageError(`--limit must be a positive integer, got "${args.flags.limit}"`);
    limit = Number(args.flags.limit);
  }
  if (args.flags.since !== undefined && !Number.isFinite(Date.parse(args.flags.since))) {
    throw new UsageError(`--since must be an ISO instant, got "${args.flags.since}"`);
  }
  const items = backendFor(deps).timeline({
    since: args.flags.since ?? new Date(Date.parse(now) - 24 * 3600_000).toISOString(),
    limit,
    taskId: args.flags.task,
    actor: args.flags.actor,
    all: args.bools.has("all"),
  });
  if (args.bools.has("json")) return ok(JSON.stringify(items, null, 2));
  return ok(renderTimeline(items));
}

// ---- dispatch + host ----

/** `run <id> [--wait]` — the third dispatch entrance (§5.1): create a manual
 *  run(pending). `--wait` is ACCEPTED as a no-op in M3 (the local host does not
 *  yet spawn/await an agent — that is M4 `tick --spawn`); it parses so the M4
 *  surface and any script written against it does not have to change. */
function verbRun(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const id = args.positionals[0];
  if (id === undefined) throw new UsageError("run needs an <id>");
  return execWrite(backendFor(deps), { op: "run", id }, args, deps);
}

/** `tick [--json] [--spawn]` — the host verb an agent NEVER calls (§10). Runs the
 *  kernel's tick against the current snapshot, applies each per-fire changeset
 *  atomically, and reports the fired/skipped/discarded notices. The clock is
 *  `--now`/LOOPANY_NOW (deterministic) or the wall clock.
 *
 *  With `--spawn` (§13 M4) it then CONSUMES the resulting pending runs: for each
 *  it claims the run, launches the assignee's configured agent profile, waits,
 *  and finishes the run from the exit code. The spawn seam is injected via
 *  `deps.spawn` (tests) or defaults to a real subprocess (`realSpawn`). */
function verbTick(args: ParsedArgs, deps: CliDeps): CliOutcome {
  const backend = backendFor(deps);
  const wantsSpawn = args.bools.has("spawn");
  // `--spawn` is the LOCAL host loop (§5.2): it claims each pending run and
  // launches the assignee's config profile as a subprocess against THIS
  // machine's filesystem. A remote backend's pending runs belong to the
  // server's fleet (L3 daemon poll territory, the NEXT milestone) — spawning
  // them locally would fork execution authority, so fail loud rather than
  // silently no-op or reach past the backend into a non-existent local workspace.
  // This precondition MUST fire before `backend.tick` — a remote tick POSTs to
  // the server and fires due crons at the authority, so refusing after the tick
  // would mutate remote state and then discard the result.
  if (wantsSpawn && backend.kind !== "local") {
    throw new DriverError(
      "SPAWN_REMOTE_UNSUPPORTED",
      "`tick --spawn` runs the LOCAL agent loop and needs a local backend",
      { hint: "a remote backend's runs are dispatched by the server fleet, not by this CLI" },
    );
  }
  const now = resolveNow(args, deps);
  const report: TickResultReport = backend.tick(now);
  let spawnReport: SpawnReport | null = null;
  if (wantsSpawn) {
    const ws = requireWorkspace(deps.cwd);
    spawnReport = spawnPendingRuns(ws, now, deps.spawn ?? realSpawn, deps.env, resolveSelfBin(deps.env));
  }
  if (args.bools.has("json")) {
    return ok(
      JSON.stringify(
        {
          ok: true,
          applied: report.applied,
          notices: report.notices,
          ...(spawnReport ? { spawned: spawnReport.spawned, spawnNotices: spawnReport.notices } : {}),
        },
        null,
        2,
      ),
    );
  }
  const lines: string[] = [
    report.applied === 0 ? "tick: nothing due" : `tick: ${report.applied} fire(s) applied`,
  ];
  if (report.notices.length > 0) lines.push(renderNotices(report.notices));
  if (spawnReport) {
    lines.push(
      spawnReport.spawned.length === 0
        ? "spawn: nothing to run"
        : `spawn: ${spawnReport.spawned.length} run(s) executed`,
    );
    if (spawnReport.notices.length > 0) lines.push(renderNotices(spawnReport.notices));
  }
  return ok(lines.join("\n"));
}

// ---- top-level dispatch ----

export function run(argv: readonly string[], deps: CliDeps): CliOutcome {
  const verb = argv[0];
  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    return { stdout: USAGE, stderr: "", exitCode: verb === undefined ? 2 : 0 };
  }
  // Per-verb help short-circuits BEFORE parseArgs (`--help` is not in the strict
  // option table, so it would otherwise render as an unknown-flag usage error).
  // The default screen stays lean; the sub-verb detail lives here.
  const verbHelp = VERB_USAGE[verb];
  if (verbHelp !== undefined && wantsHelp(argv.slice(1))) {
    return { stdout: verbHelp, stderr: "", exitCode: 0 };
  }
  // parseArgs runs INSIDE the boundary (C2): a value-bearing flag with no value
  // or an unknown flag is a USAGE error rendered like any other, never an
  // uncaught throw. `--json` may not be parseable yet, so the catch sniffs it
  // from the raw argv for a machine-readable usage error (S4).
  try {
    const args = parseArgs(argv.slice(1));
    switch (verb) {
      case "init":
        return verbInit(args, deps);
      case "register":
        return verbRegister(args, deps);
      case "unregister":
        return verbUnregister(args, deps);
      case "create":
        return verbCreate(args, deps);
      case "update":
        return verbUpdate(args, deps);
      case "note":
        return verbNote(args, deps);
      case "doc":
        return verbDoc(args, deps);
      case "mirror":
        return verbMirror(args, deps);
      case "show":
        return verbShow(args, deps);
      case "list":
        return verbList(args, deps);
      case "search":
        return verbSearch(args, deps);
      case "inbox":
        return verbInbox(args, deps);
      case "timeline":
        return verbTimeline(args, deps);
      case "loops":
        return verbLoops(args, deps);
      case "kanban":
        // The workspace launcher intercepts `kanban` BEFORE this dispatch (the
        // TUI is a separate tsx entry so React/Ink never load here). Reaching
        // this case means the BUNDLED callback CLI (the daemon's shipped
        // kernel-cli.mjs, deliberately TUI-free) - refuse with direction
        // instead of a bare unknown-verb.
        return {
          stdout: "",
          stderr:
            "the interactive kanban board is not part of this bundled callback CLI —\n" +
            "use `list`, `show <id>`, `timeline`, or `inbox --assignee <me>` (all --json capable)",
          exitCode: 1,
        };
      case "run":
        return verbRun(args, deps);
      case "tick":
        return verbTick(args, deps);
      default:
        return renderUnknownVerb(verb, argv);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      return { stdout: "", stderr: renderUsageError(e.message, argv), exitCode: 2 };
    }
    if (e instanceof DriverError) {
      return { stdout: "", stderr: renderErrorFor(e, argv), exitCode: 1 };
    }
    throw e;
  }
}

/** True when `--json` appears anywhere in argv. Used when a usage error fires
 *  before (or instead of) a successful parse — §10 wants EVERY surface to honor
 *  --json, including usage errors (S4). */
function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function renderUsageError(message: string, argv: readonly string[]): string {
  if (wantsJson(argv)) {
    return JSON.stringify({ ok: false, code: "USAGE", message }, null, 2);
  }
  return `usage: ${message}`;
}

function renderUnknownVerb(verb: string, argv: readonly string[]): CliOutcome {
  if (wantsJson(argv)) {
    return {
      stdout: "",
      stderr: JSON.stringify({ ok: false, code: "USAGE", message: `unknown verb "${verb}"` }, null, 2),
      exitCode: 2,
    };
  }
  return { stdout: "", stderr: `unknown verb "${verb}"\n\n${USAGE}`, exitCode: 2 };
}

function renderErrorFor(e: DriverError, argv: readonly string[]): string {
  if (wantsJson(argv)) {
    return JSON.stringify(
      { ok: false, code: e.code, message: e.message, issues: e.issues, hint: e.hint },
      null,
      2,
    );
  }
  return renderError(e);
}

const USAGE = `loopany-kernel — the kernel CLI (M2 local file driver)

workspace
  init [--backend local]            # remote backend lands in M6; seeds agent
       [--no-register]              #   profiles from PATH + auto-registers for
                                    #   daemon auto-tick (--no-register skips the
                                    #   registry, e.g. a virtual-clock sandbox)
  register / unregister             # enroll (or drop) this workspace in the
                                    #   registry the resident daemon auto-ticks

read
  kanban                              # for humans: interactive read-only board (TTY only)
  show <id> [--log]
  list [--status <s>] [--assignee <a>] [--due] [--tree]   # no filter = tree (depth 2)
  search <keyword>
  inbox --assignee <me>
  loops                             # every cron loop: next fire, last result,
                                    #   in-flight run, blocked/config state
  timeline [--since <iso>] [--limit N] [--task <id>] [--actor <id>] [--all]
                                    # recent meaningful team activity (24h/50
                                    #   default); --all reveals mechanical rows

write  (all accept --dry-run)
  create "<title>" [--id --parent --tracks --assignee --owner --workdir --type -p --status
                    --cron "<expr>" --timezone <tz> --follow-up <date> --body-file f.md]
  update <id> k=v … [--note "<text>"] [--if-version N]
  note <id> "<text>"
  doc put <key> [--file f.md]       # doc --help for the full doc surface
  mirror add <kind> <coords>        # mirror --help for the full mirror surface

dispatch
  run <id> [--wait]                # the third dispatch entrance (a manual run)

host  (an agent never calls these)
  tick [--spawn]                   # fire due triggers; --spawn also runs each
                                   #   pending run through its config profile

flags
  --json           machine-readable output
  --session <id>   agent-run provenance (also LOOPANY_SESSION_ID)
  --actor <id>     provenance actorId
  --now <iso>      pin the clock deterministically (also LOOPANY_NOW)`;

/** `<verb> --help` short-circuit texts. A verb absent here degrades to the
 *  full USAGE screen via the normal unknown-flag/usage paths. */
const VERB_USAGE: Record<string, string> = {
  doc: `doc — keyed prose the humans read (no state machine, one upsert verb)

  doc put <key> [--file f.md] [--task <id>] [--if-version N] [--dry-run]
      create-or-replace the doc \`slugify(<key>)\`. --file is REQUIRED to
      replace an existing doc (a bare put only creates — it refuses rather
      than wipe a stored body). --task attaches the doc to that task's refs
      atomically; inside a run LOOPANY_TASK_ID fills it in automatically.
      --if-version N refuses when the stored version differs (CAS).

  doc list [--json]
      one line per doc: <id>  (v<version>)  <updatedAt>  <title>`,
  mirror: `mirror — an ADDRESS for an external fact (no bytes, immutable, dedup by hash)

  mirror add <kind> <coords> [--task <id>] [--dry-run]
      record that an external thing matters here. kinds: github-pr |
      github-issue | url. The id derives from (kind, coords), so a repeat
      add of the same pair is a silent no-op ({existing: true}). --task
      attaches the mirror to that task's refs atomically; inside a run
      LOOPANY_TASK_ID fills it in automatically (a dedup hit still attaches).

  mirror list [--json]
      one line per mirror: <id>  [<kind>]  <coords>`,
};

/** True when a post-verb argv asks for help (`--help`, `-h`, or a bare `help`). */
function wantsHelp(rest: readonly string[]): boolean {
  return rest.includes("--help") || rest.includes("-h") || rest[0] === "help";
}
