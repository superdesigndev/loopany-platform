/**
 * THE REWRITE CLI — `loopany task|doc|loop …`, plus the two human verbs.
 *
 * A THIN SHELL over the HTTP API (CLI spec §2.3). It does exactly four local
 * jobs: attach the device credential and, when present, the invisible run
 * context; read the `--file` bytes and post them UNPARSED; render the response
 * as TOON; map the status to an exit code. Front-matter validation is the
 * server's job at its single upload/update seam — a client-side validator would
 * be a second copy of the closed key set and would drift.
 *
 * What IS local, and why: the flag grammar. A flag is the CLI's own surface, so
 * an unknown flag, two contradictory flags, or a `--file` and a flag supplying
 * the same field are all refused here, loudly, before any side effect. Never
 * ignored and never resolved by a precedence rule (§5.7, §6.4).
 *
 * AUTH (§2.2): there are no per-run bearer tokens. Authentication is the
 * machine's device credential; `LOOPANY_RUN_ID` rides as the `X-Loopany-Run`
 * header — never a command argument and never a flag, so an agent can neither
 * type it nor forge a different one.
 */
import fs from "node:fs";

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";
import { flagNames, verbHelp } from "./kernel-help.js";
import {
  ABSENT, bodyValue, cell, changedBlock, countLine, detailBlock, dueAnnotation,
  errorEnvelope, eventLine, exitForStatus, helpBlock, inlineArray, label, raw,
  slugFor, typedList, waiting,
} from "./kernel-render.js";

export interface KernelCliDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  server?: string;
  token?: string;
  readFile?: (path: string) => string;
  readStdin?: () => string;
  out?: (text: string) => void;
  /** Injected so golden outputs are deterministic; never read inside a render. */
  now?: () => number;
}

type Flags = Record<string, string | true>;
type Body = Record<string, unknown>;
type Emit = (text: string) => void;

interface Plan {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  render: (body: Body, status: number) => string;
}

// ------------------------------------------------------------------ entry point

export async function runKernelCli(argv: string[], deps: KernelCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const now = deps.now ?? Date.now;
  const command = commandOf(argv);

  // §5.7: --help is answered locally, before any side effect. This is the
  // no-round-trip guarantee that makes `--help` safe on a verb that writes.
  if (argv.includes("--help") || argv.includes("-h")) { out(verbHelp(command)); return 0; }

  const positional = argv.slice(command.includes(" ") ? 2 : 1).filter((a) => !a.startsWith("--"));
  const flags = parseFlags(argv);
  const built = plan(command, positional, flags, argv, deps, out, now);
  if (typeof built === "number") return built;

  const server = (deps.server ?? resolveServerUrl(undefined)).replace(/\/$/, "");
  if (!server) return emit(out, errorEnvelope({ message: "this machine is not configured for a Loopany server", code: "ERROR", help: ["Run `loopany up` to register the machine, then retry"] }), 1);
  const token = deps.token ?? env.LOOPANY_TOKEN ?? readStored(DEVICE_FILE);

  const headers: Record<string, string> = { ...built.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  // The run context is INVISIBLE: read from the environment the daemon set,
  // attached as a header, never surfaced as an argument the agent could edit.
  if (env.LOOPANY_RUN_ID) headers["X-Loopany-Run"] = env.LOOPANY_RUN_ID;
  if (env.LOOPANY_SESSION) headers.Cookie = env.LOOPANY_SESSION.includes("=") ? env.LOOPANY_SESSION : `better-auth.session_token=${env.LOOPANY_SESSION}`;

  let status: number;
  let payload: Body = {};
  let text: string | undefined;
  try {
    const response = await (deps.fetchImpl ?? fetch)(server + built.path, { method: built.method ?? "GET", headers, body: built.body });
    status = response.status;
    if ((response.headers.get("content-type") ?? "").includes("text/markdown")) text = await response.text();
    else payload = (await response.json().catch(() => ({}))) as Body;
  } catch (error) {
    // Transport: retry with backoff, do not rewrite the command (§4).
    return emit(out, errorEnvelope({ message: error instanceof Error ? error.message : String(error), code: "ERROR", help: ["The kernel could not be reached — retry with backoff; the command itself is fine"] }), 1);
  }

  if (status < 200 || status >= 300) return emit(out, renderRefusal(payload, status), exitForStatus(status));
  // `--file` output is a FILE: no ok: line and no help block, because either
  // would corrupt it. The one output shape in the surface that is not TOON.
  if (text !== undefined) { out(text); return 0; }
  return emit(out, built.render(payload, status), 0);
}

function emit(out: Emit, text: string, exit: number): number { out(text); return exit; }

// -------------------------------------------------------------------- the router

const COMMANDS = new Set(["task list", "task show", "task create", "task update", "task close", "doc show", "doc create", "doc update", "loop evolve", "loop update", "inbox", "answer"]);

function commandOf(argv: string[]): string {
  const [noun, verb] = argv;
  if (noun === "inbox" || noun === "answer") return noun;
  return [noun, verb].filter((part) => part && !part.startsWith("--")).join(" ");
}

function plan(command: string, positional: string[], flags: Flags, argv: string[], deps: KernelCliDeps, out: Emit, now: () => number): Plan | number {
  if (!COMMANDS.has(command)) {
    return emit(out, errorEnvelope({ message: `unknown command ${JSON.stringify(argv.join(" ") || "(none)")}`, code: "VALIDATION_ERROR", wrote: argv.join(" ") || ABSENT, allowed: [...COMMANDS], help: ["Run `loopany task list --help` for one verb's full grammar"] }), 2);
  }
  const unknown = firstUnknownFlag(command, flags);
  if (unknown) return emit(out, unknownFlagRefusal(command, unknown), 2);
  const id = positional[0];

  switch (command) {
    case "task list": return planTaskList(flags, out, now);
    case "task show": case "doc show": {
      const kind = command.startsWith("task") ? "task" : "doc";
      if (!id) return emit(out, missingArgument(`${command} requires a ${kind} id`, `loopany ${command} <id>`, [`Run \`loopany ${kind === "task" ? "task list --open" : "doc show <id>"}\` — ids are printed by every create and every list row`]), 2);
      return {
        path: `/api/${kind}s/${encodeURIComponent(id)}`,
        headers: flags.file ? { Accept: "text/markdown" } : undefined,
        render: (body) => renderShow(kind, body, flags.full === true, now()),
      };
    }
    case "task create": case "doc create": {
      const kind = command.startsWith("task") ? "task" : "doc";
      const file = requireFile(command, flags, out); if (typeof file === "number") return file;
      const raw_ = readArtifact(file, deps, out); if (typeof raw_ === "number") return raw_;
      const shaped = applyArtifactFlags(kind, raw_, flags); if (!shaped.ok) return emit(out, shaped.refusal, 2);
      return { path: `/api/${kind}s`, method: "POST", headers: markdown(), body: shaped.text, render: (body) => renderCreate(kind, body, now()) };
    }
    case "task update": return planTaskUpdate(id, flags, deps, out, now);
    case "task close": {
      if (!id) return emit(out, missingArgument("task close requires a task id", "loopany task close <id> --note \"…\"", ["Run `loopany task list --open` to find the id"]), 2);
      if (typeof flags.note !== "string" || !flags.note.trim()) return emit(out, missingArgument("task close requires --note", `loopany task close ${id} --note "…"`, ["The note lands on the closing event and is the only record of why this closed — one sentence is enough"]), 2);
      return { path: `/api/tasks/${encodeURIComponent(id)}/close`, method: "POST", headers: json(), body: JSON.stringify({ note: flags.note }), render: (body) => renderClose(body, now()) };
    }
    case "doc update": {
      if (!id) return emit(out, missingArgument("doc update requires a doc id", "loopany doc update <id> --file <path>", ["Run `loopany doc show <id> --file > d.md` to get the current text, edit it, then update"]), 2);
      const file = requireFile(command, flags, out, `loopany doc update ${id} --file <path>`); if (typeof file === "number") return file;
      const raw_ = readArtifact(file, deps, out); if (typeof raw_ === "number") return raw_;
      return { path: `/api/docs/${encodeURIComponent(id)}`, method: "PATCH", headers: markdown(), body: raw_, render: (body) => renderUpdate("doc", "updated", body, now()) };
    }
    case "loop evolve": {
      if (!id) return emit(out, missingArgument("loop evolve requires a loop id", "loopany loop evolve <loop-id> --file <path>", ["There is no `self` — every command takes an explicit id", "Your work order names your loop id on its first line"]), 2);
      const bad = loopIdRefusal(id, "loop evolve"); if (bad) return emit(out, bad, 2);
      const file = requireFile("loop evolve", flags, out, `loopany loop evolve ${id} --file <path>`); if (typeof file === "number") return file;
      const raw_ = readArtifact(file, deps, out); if (typeof raw_ === "number") return raw_;
      return { path: `/api/loops/${encodeURIComponent(id)}/evolve`, method: "POST", headers: markdown(), body: raw_, render: (body) => renderEvolve(body) };
    }
    case "loop update": {
      if (!id) return emit(out, missingArgument("loop update requires a loop id", 'loopany loop update <loop-id> --cron "0 * * * *" --approval ev-<id>', ["Your work order names your loop id on its first line"]), 2);
      const bad = loopIdRefusal(id, "loop update"); if (bad) return emit(out, bad, 2);
      if (typeof flags.cron !== "string") return emit(out, missingArgument("loop update requires --cron", `loopany loop update ${id} --cron "0 * * * *" --approval ev-<id>`, ["Cadence is the only governance field in v1"]), 2);
      if (typeof flags.approval !== "string") {
        // The one refusal where an agent cannot proceed without being told a
        // whole protocol it has no other way to discover — so it prints all of it.
        return emit(out, errorEnvelope({
          message: "loop update requires --approval", code: "FORBIDDEN",
          wrote: `loopany loop update ${id} --cron ${flags.cron}`,
          expected: `loopany loop update ${id} --cron ${flags.cron} --approval ev-<id>`,
          help: [
            "Cadence is the keyed zone: an agent changes it only by presenting a human approval event",
            `Step 1: \`loopany task create --file <path> --needs-human "propose this cadence: …" --watcher ${id}\``,
            "Step 2: a human answers in the inbox; one run is queued for your loop with that task's scope",
            "Step 3: that run reads the verdict event id with `loopany task show <id>` and passes it as --approval",
          ],
        }), 2);
      }
      return { path: `/api/loops/${encodeURIComponent(id)}`, method: "POST", headers: json(), body: JSON.stringify({ cron: flags.cron, approval: flags.approval }), render: (body) => renderGovernance(body) };
    }
    case "inbox": {
      if (argv.length !== 1) return emit(out, errorEnvelope({ message: "inbox takes no arguments", code: "VALIDATION_ERROR", wrote: argv.join(" "), expected: "loopany inbox", help: ["The inbox is the safety floor — a filter could hide an arm of it, so there are none"] }), 2);
      return { path: "/api/inbox", render: (body) => renderInbox(body, now()) };
    }
    default: {
      const taskId = argv[1];
      const answer = argv[2];
      if (!taskId) return emit(out, missingArgument("answer requires a task id", 'loopany answer <task-id> "…"', ["Run `loopany inbox` to see the tasks waiting on you"]), 2);
      if (typeof answer !== "string" || !answer.trim() || argv.length !== 3) {
        return emit(out, errorEnvelope({
          message: "answer text is required", code: "VALIDATION_ERROR", expected: `loopany answer ${taskId} "(b) give it one more day"`,
          help: ["Free text — approve, reject and instructions are all just the answer; the kernel never parses it", 'A reason is what lets the loop converge next time; "no" alone teaches it nothing'],
        }), 2);
      }
      return { path: `/api/tasks/${encodeURIComponent(taskId)}/verdict`, method: "POST", headers: json(), body: JSON.stringify({ answer }), render: (body) => renderAnswer(body) };
    }
  }
}

// ------------------------------------------------------------------ per-verb plans

function planTaskList(flags: Flags, out: Emit, now: () => number): Plan | number {
  if (flags.open && flags.closed) {
    return emit(out, errorEnvelope({ message: "--open and --closed are mutually exclusive", code: "VALIDATION_ERROR", wrote: "--open --closed", expected: "--open", help: ["A task is `open` or `closed` — there is no third state, so no query spans both", "Run `loopany task list --open` for live work, `--closed --since 14d` for recent history"] }), 2);
  }
  if (flags.unwatched && flags.watcher) {
    return emit(out, errorEnvelope({ message: "--unwatched and --watcher are mutually exclusive", code: "VALIDATION_ERROR", wrote: "--unwatched --watcher", expected: "--unwatched", help: ["`--unwatched` IS the empty-watcher predicate; naming a loop as well asks for two different sets"] }), 2);
  }
  for (const key of ["watcher", "creator"] as const) {
    if (typeof flags[key] === "string") { const bad = loopIdRefusal(flags[key], `--${key}`); if (bad) return emit(out, bad, 2); }
  }
  if (typeof flags.since === "string" && !/^\d+[hd]$/.test(flags.since)) {
    return emit(out, errorEnvelope({
      message: "--since takes a bare duration", code: "VALIDATION_ERROR", wrote: flags.since, expected: "14d", allowed: ["<N>d", "<N>h"],
      help: ["`--since` looks backward and takes no sign — write `14d`, not `-14d` or `+14d`", "Run `loopany task list --closed --since 14d` to read recent decisions"],
    }), 2);
  }
  const query = new URLSearchParams();
  query.set("status", flags.closed ? "closed" : "open");
  if (flags.due) query.set("due", "true");
  if (flags.unwatched) query.set("watcher", "none");
  for (const key of ["watcher", "creator", "since"]) if (typeof flags[key] === "string") query.set(key, flags[key]);
  const echo = flagNames("task list").filter((flag) => flags[flag.slice(2)] !== undefined).map((flag) => (typeof flags[flag.slice(2)] === "string" ? `${flag} ${flags[flag.slice(2)]}` : flag)).join(" ");
  return { path: `/api/tasks?${query}`, render: (body) => renderTaskList(body, echo, now()) };
}

function planTaskUpdate(id: string | undefined, flags: Flags, deps: KernelCliDeps, out: Emit, now: () => number): Plan | number {
  if (!id) return emit(out, missingArgument("task update requires a task id", "loopany task update <id> --follow-up +3d", ["Run `loopany task list --open` to find the id"]), 2);
  const fieldFlags = ["follow-up", "watcher", "needs-human", "payload-merge"].filter((key) => flags[key] !== undefined);
  if (!flags.file && !fieldFlags.length) {
    return emit(out, errorEnvelope({ message: "task update requires at least one field", code: "VALIDATION_ERROR", expected: `loopany task update ${id} --follow-up +3d`, allowed: flagNames("task update"), help: [`Run \`loopany task show ${id}\` if you only wanted to read it`] }), 2);
  }
  if (typeof flags.watcher === "string") { const bad = loopIdRefusal(flags.watcher, "--watcher", true); if (bad) return emit(out, bad, 2); }

  if (typeof flags.file === "string") {
    if (flags["payload-merge"] !== undefined) {
      return emit(out, errorEnvelope({ message: "--payload-merge cannot be combined with --file", code: "VALIDATION_ERROR", wrote: "--payload-merge + --file", expected: "(one or the other)", help: ["A file replaces payload wholesale; --payload-merge merges into the stored one — the two cannot both be the truth", "Edit `payload:` in the file, or drop --file"] }), 2);
    }
    const raw_ = readArtifact(flags.file, deps, out); if (typeof raw_ === "number") return raw_;
    const shaped = applyArtifactFlags("task", raw_, flags); if (!shaped.ok) return emit(out, shaped.refusal, 2);
    return { path: `/api/tasks/${encodeURIComponent(id)}`, method: "PATCH", headers: markdown(), body: shaped.text, render: (body) => renderUpdate("task", "updated", body, now()) };
  }

  const patch: Body = {};
  if (flags["follow-up"] !== undefined) patch.followUp = nullToken(flags["follow-up"]);
  if (flags.watcher !== undefined) patch.watcher = nullToken(flags.watcher);
  if (flags["needs-human"] !== undefined) patch.needsHuman = nullToken(flags["needs-human"]);
  let merged: string[] = []; let deleted: string[] = [];
  if (flags["payload-merge"] !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(flags["payload-merge"])); } catch { parsed = undefined; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emit(out, errorEnvelope({
        message: "--payload-merge is not a JSON object", code: "VALIDATION_ERROR", wrote: String(flags["payload-merge"]), expected: '{"merged_at":"2026-08-02T11:31:00+08:00"}',
        help: ["One inline JSON object; keys merge at the top level only, and a `null` value deletes a key", "Its keys and values are never inspected by the kernel"],
      }), 2);
    }
    patch.payloadMerge = parsed;
    const entries = Object.entries(parsed as Body);
    merged = entries.filter(([, value]) => value !== null).map(([key]) => key);
    deleted = entries.filter(([, value]) => value === null).map(([key]) => key);
  }
  return { path: `/api/tasks/${encodeURIComponent(id)}`, method: "PATCH", headers: json(), body: JSON.stringify(patch), render: (body) => renderUpdate("task", "updated", body, now(), { merged, deleted }) };
}

// ------------------------------------------------------------------- local guards

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 2) { flags[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
  }
  return flags;
}

function firstUnknownFlag(command: string, flags: Flags): string | undefined {
  const allowed = new Set([...flagNames(command).map((flag) => flag.slice(2)), ...(command === "task list" ? ["open", "closed", "due", "unwatched"] : [])]);
  return Object.keys(flags).find((key) => !allowed.has(key) && key !== "help");
}

function unknownFlagRefusal(command: string, flag: string): string {
  const allowed = flagNames(command);
  const near = nearest(`--${flag}`, allowed);
  // `--mine` is exactly what an agent trained on any other task CLI reaches for,
  // and the fix is one substitution the refusal can pre-compute.
  const identityMagic = ["mine", "me", "self"].includes(flag);
  return errorEnvelope({
    message: `unknown flag --${flag}`, code: "VALIDATION_ERROR", wrote: `--${flag}`,
    expected: identityMagic ? "--watcher <loop-id>" : near, allowed,
    help: identityMagic
      ? ["There is no `--mine` and no `self` — every command takes an explicit loop id", "Your work order names your loop id; `--watcher <id>` is what you owe, `--creator <id>` is what you made", `Run \`loopany ${command} --help\` for the full grammar`]
      : [`Run \`loopany ${command} --help\` for the full grammar`],
  });
}

/** §5.4: there is no `self`. A loop id is kind-prefixed, and the refusal says
 *  where the caller's real one comes from rather than only that this one is wrong. */
function loopIdRefusal(value: string, where: string, allowNull = false): string | undefined {
  if (value.startsWith("loop-")) return undefined;
  if (allowNull && value === "null") return undefined;
  return errorEnvelope({
    message: `${where} takes a loop id`, code: "VALIDATION_ERROR", wrote: value, expected: "loop-4c1d77",
    help: ["There is no `self` keyword — your work order names your loop id on its first line", "Loop ids are kind-prefixed: they start with `loop-`"],
  });
}

function missingArgument(message: string, expected: string, help: string[]): string {
  return errorEnvelope({ message, code: "VALIDATION_ERROR", expected, help });
}

function requireFile(command: string, flags: Flags, out: Emit, expected?: string): string | number {
  if (typeof flags.file === "string" && flags.file) return flags.file;
  return emit(out, missingArgument(`${command} requires --file`, expected ?? `loopany ${command} --file <path>`, ["Write the front matter + body to a file, then upload it — the file is the object", "`--file -` reads stdin, for an artifact generated in-process"]), 2);
}

function readArtifact(path: string, deps: KernelCliDeps, out: Emit): string | number {
  try {
    return path === "-" ? (deps.readStdin?.() ?? fs.readFileSync(0, "utf8")) : (deps.readFile?.(path) ?? fs.readFileSync(path, "utf8"));
  } catch (error) {
    // A local failure, so transport class: the command is right, the file is not.
    return emit(out, errorEnvelope({ message: `cannot read --file ${path}: ${error instanceof Error ? error.message : String(error)}`, code: "ERROR", help: ["Write the artifact file first, then upload it — creation is file-first"] }), 1);
  }
}

/** §6.4's G8: a flag and a front-matter key supplying the same field is refused
 *  loudly, with BOTH values printed. There is no precedence rule to memorize, and
 *  the silent version routes a future human answer to the wrong loop. */
const FLAG_TO_KEY: Record<string, Record<string, string>> = {
  task: { "needs-human": "needs_human", watcher: "watcher", "follow-up": "follow_up" },
  doc: {},
};

type Shaped = { ok: true; text: string } | { ok: false; refusal: string };

function applyArtifactFlags(kind: string, raw_: string, flags: Flags): Shaped {
  const mapping = FLAG_TO_KEY[kind] ?? {};
  const fence = raw_.indexOf("\n---", 4);
  const head = fence >= 0 ? raw_.slice(0, fence) : raw_;
  for (const [flag, key] of Object.entries(mapping)) {
    if (flags[flag] === undefined) continue;
    const inFile = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head);
    if (inFile) {
      return { ok: false, refusal: errorEnvelope({
        message: `${key} was supplied twice, by --${flag} and by the file's front matter`, code: "VALIDATION_ERROR",
        wrote: `--${flag} ${String(flags[flag])}  +  "${key}: ${inFile[1]?.trim() ?? ""}"`, expected: "(supply it in exactly one place)",
        help: ["Nothing was written — there is no precedence rule, so the kernel refuses rather than pick for you", `Drop \`--${flag}\`, or remove \`${key}:\` from the file`],
      }) };
    }
  }
  const additions = Object.entries(mapping)
    .filter(([flag]) => typeof flags[flag] === "string")
    .map(([flag, key]) => `${key}: ${JSON.stringify(nullToken(flags[flag]))}`);
  if (!additions.length || fence < 0) return { ok: true, text: raw_ };
  return { ok: true, text: `${raw_.slice(0, fence)}\n${additions.join("\n")}${raw_.slice(fence)}` };
}

function nullToken(value: unknown): unknown { return value === "null" ? null : value; }
function json() { return { "Content-Type": "application/json" }; }
function markdown() { return { "Content-Type": "text/markdown; charset=utf-8" }; }

function nearest(got: string, candidates: string[]): string | undefined {
  const ranked = candidates.map((c) => ({ c, d: distance(got, c) })).sort((a, b) => a.d - b.d);
  return ranked[0] && ranked[0].d <= 3 && ranked[0].d !== ranked[1]?.d ? ranked[0].c : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; }
  }
  return row[b.length]!;
}

// ----------------------------------------------------------------- the renderers

/** Every refusal the server authored: the prose is printed verbatim, the SHAPE is
 *  the CLI's (§3.4). The slug is derived from the status, so nothing is parsed. */
function renderRefusal(body: Body, status: number): string {
  const issue = (Array.isArray(body.issues) ? body.issues[0] : undefined) as Body | undefined;
  return errorEnvelope({
    message: typeof body.message === "string" ? body.message : `the kernel refused this call (${status})`,
    code: slugFor(typeof body.code === "string" ? body.code : undefined, status),
    wrote: issue?.got, expected: issue?.expected,
    help: typeof body.hint === "string" && body.hint ? [body.hint] : [],
  });
}

function object(body: Body): Body | undefined {
  return (body.task ?? body.doc ?? body.loop) as Body | undefined;
}

function taskRows(row: Body, now: number): [string, unknown][] {
  const rows: [string, unknown][] = [["id", row.id], ["title", row.title], ["status", row.status]];
  // The raw instant plus the derived answer, so the agent never has to do a
  // clock comparison it is unreliable at.
  rows.push(["follow_up", row.followUpAt ? raw(`${String(row.followUpAt)}${dueAnnotation(row.followUpAt as string, now)}`) : ABSENT]);
  rows.push(["watcher", row.watcher ? row.watcher : raw(`${ABSENT} (unclaimed pool)`)]);
  rows.push(["question", row.pendingQuestion], ["key", row.key]);
  for (const field of ["createdByRun", "createdByLoop", "createdAt", "updatedAt", "closedAt"]) {
    if (row[field] !== undefined) rows.push([label(field), row[field]]);
  }
  return rows;
}

function docRows(row: Body): [string, unknown][] {
  const rows: [string, unknown][] = [["id", row.id], ["title", row.title], ["format", row.format], ["key", row.key]];
  for (const field of ["createdByRun", "createdByLoop", "createdAt", "updatedAt"]) {
    if (row[field] !== undefined) rows.push([label(field), row[field]]);
  }
  return rows;
}

function payloadBlock(row: Body): string {
  const payload = row.payload as Body | undefined;
  const entries = Object.entries(payload ?? {});
  return entries.length ? `payload:\n${entries.map(([key, value]) => `  ${key}: ${cell(value)}`).join("\n")}\n` : "";
}

function renderShow(kind: "task" | "doc", body: Body, full: boolean, now: number): string {
  const row = object(body);
  if (!row) return `error: "the server returned no ${kind}"\ncode: ERROR\n${helpBlock(["Retry; if it persists the server and this CLI disagree about the response shape"])}`;
  let text = detailBlock(kind, kind === "task" ? taskRows(row, now) : docRows(row));
  text += payloadBlock(row);
  if (typeof row.body === "string") text += `body: ${cell(bodyValue(row.body, full))}\n`;
  const events = (Array.isArray(body.events) ? body.events : []) as Body[];
  // `seq` leads: it is what totally orders the tail even when two events share a
  // timestamp, and it is the cursor the UI's stream resumes from. The content id
  // is a dedup key, not a handle, so it is not printed.
  text += typedList("events", ["seq", "ts", "actor", "entrance", "change"], events.map((event) => [event.seq, event.ts, event.actor, event.entrance, changeSummary(event)]));
  const id = String(row.id ?? "<id>");
  return text + helpBlock(kind === "task"
    ? [`Run \`loopany task update ${id} --follow-up +1d\` to push the check out`, `Run \`loopany task update ${id} --needs-human "…"\` if you need a decision`, `Run \`loopany task close ${id} --note "…"\` when it is verified`]
    : [`Run \`loopany doc show ${id} --full\` to read the complete body`, `Run \`loopany doc show ${id} --file > d.md\` to start an edit from the current text`]);
}

function changeSummary(event: Body): string {
  if (event.kind === "object-created") return "created";
  const diff = event.diff as Record<string, { old?: unknown; new?: unknown }> | null | undefined;
  const entries = Object.entries(diff ?? {});
  if (entries.length) return entries.map(([field, change]) => `${label(field)}: ${cell(change.old)} → ${cell(change.new)}`).join("; ");
  return typeof event.note === "string" && event.note ? event.note : String(event.kind ?? ABSENT);
}

function renderTaskList(body: Body, echo: string, now: number): string {
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []) as Body[];
  const total = typeof body.total === "number" ? body.total : tasks.length;
  const own = typeof body.viewerLoop === "string" ? body.viewerLoop : "<your-loop-id>";
  let text = countLine(tasks.length, total);
  text += typedList("tasks", ["id", "title", "follow_up", "watcher", "question"], tasks.map((task) => [task.id, task.title, task.followUpAt, task.watcher, task.pendingQuestion]));
  if (!tasks.length) {
    // The filter echo lets an agent seeing zero distinguish "my predicate was
    // narrow" from "the system is empty" without a second call.
    if (echo) text += `filter: ${cell(echo)}\n`;
    return text + helpBlock(["Run `loopany task list --open --unwatched` to see the unclaimed pool", "Nothing due is a clean result — do not manufacture work"]);
  }
  const one = tasks.length === 1 ? String(tasks[0]!.id) : "<id>";
  const hints = [`Run \`loopany task show ${one}\` to read one, with its payload and event tail`, `Run \`loopany task update ${one} --watcher ${own} --follow-up +3d\` to adopt one`];
  if (body.truncated) hints.unshift(`Showing the first ${tasks.length} of ${total} — narrow the query rather than paging`);
  else hints.push(`Run \`loopany task list --watcher ${own} --due\` for the work you already own`);
  return text + helpBlock(hints);
}

/** §5.1's three key cases, all exit 0. Silent discard is forbidden: when the
 *  submitted content differs, the response says so AND names the command that
 *  would apply it. */
function noticeLines(body: Body, applyWith: string): string {
  if (!body.contentDiffers) return "";
  const differs = (body.differingFields as string[] | undefined) ?? [];
  const notice = body.notice as Body | undefined;
  return `warning: ${cell(typeof notice?.message === "string" ? notice.message : "submitted content differs from the stored object; nothing was written")}\n${inlineArray("differs", differs.map(label))}`;
}

function renderCreate(kind: "task" | "doc", body: Body, now: number): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const replay = body.created === false;
  let text = `ok: created ${id}${replay ? " (idempotent: existing object returned)" : ""}\n`;
  text += noticeLines(body, `loopany ${kind} update ${id} --file <path>`);
  text += detailBlock(kind, kind === "task" ? taskRows(row, now) : docRows(row));
  const hints: string[] = [];
  if (replay && body.contentDiffers) {
    hints.push(`Key ${cell(row.key)} already exists — create is idempotent, so your changes were NOT applied`, `Run \`loopany ${kind} update ${id} --file <path>\` to apply them`);
  } else {
    hints.push(`Run \`loopany ${kind} show ${id}\` to read it back`);
    if (kind === "task") {
      if (row.pendingQuestion) {
        hints.push("This task is in the human inbox now; `loopany task close` is refused until it is answered", `On answer, one run is queued for ${cell(row.watcher)} with scope ${id} — read the answer with \`loopany task show ${id}\``);
      } else if (!row.watcher && !row.followUpAt) {
        // Every safe default has a CONSEQUENCE; printing it at creation is how
        // the agent learns what omitting a field actually did.
        hints.push(`Run \`loopany task update ${id} --watcher ${cell(row.createdByLoop)} --follow-up +3d\` to adopt it yourself`, "Unwatched with no follow_up: the inbox orphan floor surfaces it to a human after 48h");
      } else {
        hints.push(`Run \`loopany task update ${id} --follow-up +3d\` to change when it resurfaces`);
      }
    } else {
      hints.push(`Cite it from a task: put \`doc: ${id}\` under \`payload:\` and name the id in the body`, `Run \`loopany doc update ${id} --file <path>\` to rewrite it in place`);
    }
  }
  return text + helpBlock(hints);
}

function renderUpdate(kind: "task" | "doc", verb: string, body: Body, now: number, payloadDelta?: { merged: string[]; deleted: string[] }): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const changed = body.changed !== false;
  let text = `ok: ${verb} ${id}${changed ? "" : " (no change)"}\n`;
  if (typeof body.warning === "string") text += `warning: ${cell(body.warning)}\n`;
  text += detailBlock(kind, kind === "task" ? taskRows(row, now) : docRows(row));
  if (payloadDelta && (payloadDelta.merged.length || payloadDelta.deleted.length)) {
    text += payloadBlock(row);
    text += inlineArray("merged", payloadDelta.merged);
    text += inlineArray("deleted", payloadDelta.deleted);
  }
  text += changedBlock(body.diff as never);
  text += eventLine(body.event);
  const hints = changed
    ? (kind === "task"
      ? [`Run \`loopany task list --watcher ${cell(row.watcher)} --due\` on your next fire to pick this up again`, `Run \`loopany task close ${id} --note "…"\` when it is verified`]
      : [`Every task and charter citing ${id} now sees the new version — the id did not change`, `Run \`loopany doc show ${id} --file > d.md\` to start the next edit from the current text`])
    : ["Round-tripped without change — the file is the canonical form of the object"];
  if (changed && kind === "task" && row.pendingQuestion) {
    hints.length = 0;
    hints.push("This task is in the human inbox now; `loopany task close` is refused until it is answered", `On answer, one run is queued for ${cell(row.watcher)} with scope ${id}`, "Stop here — your job on this task is done until a human replies");
  }
  return text + helpBlock(hints);
}

function renderClose(body: Body, now: number): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const changed = body.changed !== false;
  let text = `ok: closed ${id}${changed ? "" : " (no change: already closed)"}\n`;
  text += detailBlock("task", taskRows(row, now));
  text += noticeLines(body, "");
  text += eventLine(body.event);
  return text + helpBlock(changed
    ? [`Run \`loopany task list --creator ${cell(row.createdByLoop)} --closed --since 14d\` to read your recent closures before proposing again`, "Run `loopany doc create --file <path>` to register this run's product, if you have not already"]
    : ["Close is idempotent — a retry after a dropped connection is free and costs nothing"]);
}

function renderEvolve(body: Body): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const changed = body.changed !== false;
  const charter = typeof row.body === "string" ? row.body : "";
  let text = `ok: evolved ${id}${changed ? "" : " (no change)"}\n`;
  text += detailBlock("loop", [["id", row.id], ["title", row.title], ["body", raw(`${charter.length} bytes`)]]);
  text += changedBlock(body.diff as never);
  text += eventLine(body.event);
  return text + helpBlock([
    "The diff renders on the loop page; your next run receives the new charter as its prompt",
    `Cadence, retirement and creating other loops are governance: propose with \`loopany task create --file <path> --needs-human "…" --watcher ${id}\``,
  ]);
}

function renderGovernance(body: Body): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const approval = body.approval as Body | undefined;
  let text = `ok: updated ${id}\n`;
  text += detailBlock("loop", [["id", row.id], ["title", row.title], ["cron", row.cron], ["status", row.status], ["next_fire", row.nextFire ?? raw(`${ABSENT} (paused)`)]]);
  text += changedBlock(body.diff as never);
  if (approval) {
    // The three-link audit chain — proposing run, human event, executing run —
    // printed at the moment it is forged, which is the only place an agent or a
    // transcript reader can see that the change was authorized and by what.
    text += detailBlock("approval", [["key", approval.event], ["entrance", approval.entrance], ["answered", approval.ts], ["task", approval.task], ["actor", approval.actor]]);
  }
  const notice = body.notice as Body | undefined;
  if (notice) text += `warning: ${cell(notice.message)}\n`;
  text += eventLine(body.event);
  const hints = [`Run \`loopany task close ${cell(approval?.task)} --note "cadence applied"\` to finish the proposal`, "A faster cadence does not stack runs: one queued run per loop, and a fire that finds one already queued records `clock-skipped`"];
  if (notice) hints.unshift("Time never un-pauses a loop — a human does, on the loop page");
  return text + helpBlock(hints);
}

function renderInbox(body: Body, now: number): string {
  const items = (Array.isArray(body.items) ? body.items : []) as { task?: Body; reasons?: string[]; askedAt?: string | null }[];
  let text = countLine(items.length);
  text += typedList("inbox", ["id", "title", "reason", "waiting", "watcher"], items.map((item) => {
    const task = item.task ?? {};
    const reasons = item.reasons ?? [];
    // On a question row the QUESTION is the thing to read; the other two arms
    // have nothing but the title.
    const title = reasons.includes("question") && task.pendingQuestion ? task.pendingQuestion : task.title;
    return [task.id, title, reasons.join("+"), waiting(item.askedAt ?? (task.createdAt as string), now), task.watcher];
  }));
  return text + helpBlock(items.length
    ? ['Run `loopany answer <task-id> "…"` to reply — free text; approve/reject plus instructions are all just the answer', "Run `loopany task show <task-id>` to read the full question, its payload and its history", "Rows with a watcher queue one run for that loop the moment you answer; rows without one just record the answer"]
    : ["Nothing is waiting on you — the default mode is zero human involvement, by design", "Run `loopany task list --open --unwatched` if you want to look at the unclaimed pool anyway"]);
}

function renderAnswer(body: Body): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const run = body.run as Body | undefined;
  let text = `ok: answered ${id}\n`;
  text += detailBlock("task", [["id", row.id], ["title", row.title], ["status", row.status], ["question", raw("cleared")]]);
  text += eventLine(body.event);
  if (run) {
    // The human's mental model is "I wrote a sentence, did anything happen?" —
    // and the answer is a concrete run id they can follow.
    text += detailBlock("wake", [["run", run.alreadyQueued ? raw(`${cell(run.id)} (already queued)`) : run.id], ["loop", run.loopId], ["scope", String(run.scope ?? "").replace(/^task:/, "")], ["reason", run.reason], ["state", run.state]]);
  } else {
    text += `wake: ${ABSENT} (no watcher — the answer sits on the record)\n`;
  }
  return text + helpBlock(run
    ? (run.alreadyQueued
      ? [`${cell(run.loopId)} already had a run queued — it will pull both answered tasks when it claims; one run, not two`, "Run `loopany inbox` to see what is still waiting"]
      : [`One run is queued for ${cell(run.loopId)} — it will read your answer and act; nothing else is needed from you`, `Event ${cell(body.event)} is the approval key for this task, if the answer approved a governance change`, "Run `loopany inbox` to see what is still waiting"])
    : ["Nothing is queued: no loop was named as the watcher, so your answer waits to be claimed", "The task is still open — a steward loop may pick it up, or close it yourself in the web UI"]);
}
