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
import { flagNames, loopSurfacePointer, verbHelp } from "./kernel-help.js";
import {
  ABSENT, bodyValue, cell, changedBlock, countLine, detailBlock, dueAnnotation,
  errorEnvelope, eventLine, exitForStatus, helpBlock, inlineArray, label,
  nextFireCell, raw, slugFor, typedList, waiting,
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
type Kind = "task" | "doc" | "loop";

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

  // Convergence S3 leaves kernel loop objects in place for history only. Never
  // let an old `loop *` command mutate that twin or produce a kernel-queue row;
  // teach the production owner surface locally, before auth/network/I/O.
  if (command.startsWith("loop ")) {
    const positionalId = argv[2] && !argv[2]!.startsWith("--") ? argv[2] : undefined;
    out(loopSurfacePointer(command, positionalId));
    return 2;
  }

  const positional = argv.slice(command.includes(" ") ? 2 : 1).filter((a) => !a.startsWith("--"));
  const flags = parseFlags(argv);
  const built = plan(command, positional, flags, argv, deps, out, now);
  if (typeof built === "number") return built;

  const server = (deps.server ?? resolveServerUrl(undefined)).replace(/\/$/, "");
  if (!server) return emit(out, errorEnvelope({ message: "this machine is not configured for a Loopany server", code: "ERROR", help: ["Run `loopany up` to register the machine, then retry"] }), 1);
  const token = deps.token ?? env.LOOPANY_TOKEN ?? readStored(DEVICE_FILE);

  const headers: Record<string, string> = { ...built.headers };
  // THE CREDENTIAL TRAVELS WITH THE RUN CONTEXT, never on its own.
  //
  // What makes a caller an agent is the presence of run context (CLI spec §2.2),
  // and the daemon sets the token and `LOOPANY_RUN_ID` together. Outside a run
  // the person at the keyboard is the caller, and the device token is merely a
  // readable file on their disk — attaching it names the wrong actor. It also
  // BREAKS the DUAL reads: §2.6 answers a device credential with no run context
  // `NO_RUN_CONTEXT`, so `loop show` / `loop list` / `task list` refused exactly
  // the owner they exist to serve, on every machine the daemon is registered on
  // (the same shape as the unit-4 review's B1, one layer out).
  //
  // HUMAN_COMMANDS stays as belt and braces for the other direction: a human
  // verb typed INSIDE a run still carries the run header, and the server refuses
  // it by run context before the credential is ever read.
  if (token && env.LOOPANY_RUN_ID && !HUMAN_COMMANDS.has(command)) headers.Authorization = `Bearer ${token}`;
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

const COMMANDS = new Set([
  "task list", "task show", "task create", "task update", "task close", "task tell",
  "doc show", "doc create", "doc update",
  "loop list", "loop show", "loop create", "loop evolve", "loop update",
  "loop pause", "loop resume", "loop retire", "loop run-now",
  "mirror attach", "mirror detach", "mirror list", "mirror kinds", "mirror show", "mirror update",
  "inbox", "answer",
]);
/**
 * The HUMAN verbs (CLI spec §7 plus unit 6's loop CRUD): a signed-in person on
 * this machine, so the machine's credential is deliberately NOT attached — a
 * device token on a human surface names the wrong actor.
 *
 * `loop create` and the three lifecycle verbs are here because both are the
 * owner's: creating a loop mints a standing cadence and a new actor, and pausing
 * or retiring one is the operational decision the owner keeps. A run proposes
 * either through `task create --needs-human`. Note the run header still rides
 * along when one is set, so a human who typed this inside a run is refused too —
 * correctly, since the actor stamped on the event would be wrong.
 */
const HUMAN_COMMANDS = new Set(["inbox", "answer", "task tell", "loop create", "loop pause", "loop resume", "loop retire", "loop run-now"]);

/** The three loop statuses, as the `--status` grammar. Duplicated from the
 *  server's `LOOP_STATUSES` on purpose: the flag VALUE set is the CLI's own
 *  surface, refused locally before any side effect, and the server re-validates. */
const LOOP_STATUSES = ["active", "paused", "retired"];

function commandOf(argv: string[]): string {
  const [noun, verb] = argv;
  if (noun === "inbox" || noun === "answer") return noun;
  return [noun, verb].filter((part) => part && !part.startsWith("--")).join(" ");
}

/**
 * An ATTACHABLE object id — a task, a doc or a loop.
 *
 * The kind prefix IS the type, so this catches two things at once: a mirror id
 * where an object id belongs, and — because the positional scan cannot tell an
 * argument from a flag's VALUE — an `attach` that omitted the object entirely
 * and would otherwise have posted `--kind`'s value as the object.
 */
const ATTACHABLE_PREFIXES = ["task-", "doc-", "loop-"];

function objectIdRefusal(value: string, where: string): string | undefined {
  if (ATTACHABLE_PREFIXES.some((prefix) => value.startsWith(prefix))) return undefined;
  return errorEnvelope({
    message: `${where} takes the id of the task, doc or loop that depends on the external thing`,
    code: "VALIDATION_ERROR", wrote: value, expected: "task-7f3a91", allowed: ATTACHABLE_PREFIXES.map((p) => `${p}<id>`),
    help: [
      "Ids are kind-prefixed, and the object id comes FIRST, before the flags",
      "A mirror never attaches to another mirror: a pointer to a pointer is an alias, not a dependency",
      `Run \`loopany ${where} --help\` for the full grammar`,
    ],
  });
}

/** A mirror id, wherever one is required. Same shape as `loopIdRefusal` — the
 *  kind prefix IS the type, so a wrong-kind id is caught before a round trip. */
function mirrorIdRefusal(value: string, where: string): string | undefined {
  if (value.startsWith("mirror-")) return undefined;
  return errorEnvelope({
    message: `${where} takes a mirror id`, code: "VALIDATION_ERROR", wrote: value, expected: "mirror-3f9a21c04b7e",
    help: [
      "Mirror ids are kind-prefixed: they start with `mirror-`",
      "Run `loopany mirror list --attached-to <object-id>` — every list row prints the id",
      "The OBJECT id goes in `--from`; the mirror id is the positional argument",
    ],
  });
}

/**
 * The verbs an agent trained on any other CRUD CLI reaches for, and the one
 * substitution that fixes each. A generic "unknown command" would be true and
 * useless here: the reason there is no `loop delete` is a property of the system
 * (the kernel is event-sourced), so the refusal teaches the property, not just
 * the spelling.
 */
const NEAR_MISS: Record<string, { expected: string; help: string[] }> = {
  "loop delete": {
    expected: "loopany loop retire <loop-id>",
    help: [
      "There is no hard delete anywhere in this surface: the kernel is event-sourced, so nothing is ever erased",
      "`loop retire` IS the D in CRUD — terminal, the charter freezes, the cadence is gone, the record stays readable",
      "To stop a loop only for now, run `loopany loop pause <loop-id>` — it resumes with one fire owed, not a backlog",
    ],
  },
  "loop close": {
    expected: "loopany loop retire <loop-id>",
    help: [
      "Closing is a TASK transition; a loop's lifecycle is pause ⇄ resume, and retire is the terminal one",
      "A loop never closes by finishing work — it is a standing cadence, not a unit of work",
    ],
  },
  "task delete": {
    expected: 'loopany task close <task-id> --note "…"',
    help: [
      "Nothing is deleted: a task closes with an attestation, and the closed record is the point",
      "There is no reopen either — create a new task for the follow-on work",
    ],
  },
  "doc delete": {
    expected: "loopany doc update <doc-id> --file <path>",
    help: ["A doc is rewritten in place and keeps its id, so everything citing it follows; there is no delete verb"],
  },
};
/**
 * The mirror near-misses, and each one teaches the property rather than the
 * spelling. `mirror create` is the one an agent reaches for first and it is the
 * most important to answer: there is no create, because a mirror that points
 * from nothing is a row nobody can ever find.
 */
NEAR_MISS["mirror create"] = {
  expected: "loopany mirror attach <object-id> --kind github-pr --coords owner/repo#57",
  help: [
    "There is no `mirror create`: a mirror records that some object DEPENDS on an external thing, so it is born attached",
    "One external thing is ONE mirror — attaching the same coords from a second object shares the row instead of making a twin",
    "A mirror tells you WHERE to look, never WHAT state it is in: there is no state field, and the schema has nowhere to put one",
  ],
};
NEAR_MISS["mirror delete"] = {
  expected: "loopany mirror detach <mirror-id> --from <object-id>",
  help: [
    "Nothing is deleted anywhere in this kernel: detaching removes the dependency and leaves the record readable",
    "Detaching the last attachment is legal — the mirror stays, attached to nothing",
  ],
};
NEAR_MISS["mirror rm"] = NEAR_MISS["mirror delete"]!;
NEAR_MISS["mirror remove"] = NEAR_MISS["mirror delete"]!;
NEAR_MISS["mirror sync"] = {
  expected: "loopany mirror show <mirror-id>",
  help: [
    "There is nothing to sync: a mirror is a POINTER, not a cache — it never held external state, so it can never be stale",
    "Go and look at the external thing yourself (the coords say where), and record what you FOUND on the task that owns the work",
  ],
};
NEAR_MISS["mirror refresh"] = NEAR_MISS["mirror sync"]!;
NEAR_MISS["task directive"] = {
  expected: 'loopany task tell <task-id> "…"',
  help: [
    "`tell` is you speaking to the loop that watches this task; `answer` is you replying to one that asked you something",
    "Both queue one run for the watcher, scoped to the task, carrying your words verbatim",
  ],
};
NEAR_MISS["loop remove"] = NEAR_MISS["loop delete"]!;
NEAR_MISS["loop rm"] = NEAR_MISS["loop delete"]!;
NEAR_MISS["loop archive"] = NEAR_MISS["loop delete"]!;

function plan(command: string, positional: string[], flags: Flags, argv: string[], deps: KernelCliDeps, out: Emit, now: () => number): Plan | number {
  if (!COMMANDS.has(command)) {
    const taught = NEAR_MISS[command];
    return emit(out, errorEnvelope({
      message: `unknown command ${JSON.stringify(argv.join(" ") || "(none)")}`, code: "VALIDATION_ERROR",
      wrote: argv.join(" ") || ABSENT, expected: taught?.expected, allowed: [...COMMANDS],
      help: [...(taught?.help ?? []), "Run `loopany task list --help` for one verb's full grammar"],
    }), 2);
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
    case "task tell": {
      // The directive is a POSITIONAL, exactly like `answer`'s text: the two are
      // the same conversation from opposite ends, and giving one a flag and the
      // other a positional would make them look like different mechanisms.
      const directive = argv[3];
      if (!id) return emit(out, missingArgument("task tell requires a task id", 'loopany task tell <task-id> "…"', ["Run `loopany task list --open` to find it", "`tell` is you speaking to the watching loop; `answer` is you replying to one that asked"]), 2);
      if (typeof directive !== "string" || !directive.trim() || argv.length !== 4) {
        return emit(out, errorEnvelope({
          message: "the directive text is required", code: "VALIDATION_ERROR", expected: `loopany task tell ${id} "drop this bet — close the PR, clean up, then close the task"`,
          help: [
            "Free text. The run executes the INTENT against reality first and the kernel's records last",
            "Say what you want AND why — the reason is what lets the loop judge the cases you did not name",
          ],
        }), 2);
      }
      return { path: `/api/tasks/${encodeURIComponent(id)}/directive`, method: "POST", headers: json(), body: JSON.stringify({ directive }), render: (body) => renderDirective(body) };
    }
    case "mirror attach": {
      if (!id) return emit(out, missingArgument("mirror attach requires the object that depends on the external thing", 'loopany mirror attach <object-id> --kind github-pr --coords owner/repo#57', ["A mirror points FROM a task, a doc or a loop — attaching it to nothing would make a pointer nobody can find"]), 2);
      const notObject = objectIdRefusal(id, "mirror attach"); if (notObject) return emit(out, notObject, 2);
      for (const key of ["kind", "coords"] as const) {
        if (typeof flags[key] === "string" && flags[key].trim()) continue;
        return emit(out, errorEnvelope({
          message: `mirror attach requires --${key}`, code: "VALIDATION_ERROR",
          expected: `loopany mirror attach ${id} --kind github-pr --coords owner/repo#57`,
          help: [
            "`--kind` is what kind of external thing it is; `--coords` is its immutable identity",
            "Canonical kinds: github-pr, github-issue, url, gsc-property — anything else is accepted as a plain string",
            "A mirror tells you WHERE to look, never WHAT state it is in, so there is no state to pass",
          ],
        }), 2);
      }
      return {
        path: "/api/mirrors", method: "POST", headers: json(),
        body: JSON.stringify({ objectId: id, kind: flags.kind, coords: flags.coords, ...(typeof flags.note === "string" ? { note: flags.note } : {}) }),
        render: (body) => renderAttach(body),
      };
    }
    case "mirror detach": {
      if (!id) return emit(out, missingArgument("mirror detach requires a mirror id", "loopany mirror detach <mirror-id> --from <object-id>", ["Run `loopany mirror list --attached-to <object-id>` to find it"]), 2);
      const bad = mirrorIdRefusal(id, "mirror detach"); if (bad) return emit(out, bad, 2);
      if (typeof flags.from !== "string" || !flags.from.trim()) {
        return emit(out, missingArgument("mirror detach requires --from", `loopany mirror detach ${id} --from <object-id>`, ["A mirror can hang on several objects, so the one being released is always named — guessing would remove somebody else's pointer"]), 2);
      }
      return { path: `/api/mirrors/${encodeURIComponent(id)}/detach`, method: "POST", headers: json(), body: JSON.stringify({ from: flags.from }), render: (body) => renderDetach(body) };
    }
    case "mirror list": {
      const query = new URLSearchParams();
      for (const key of ["attached-to", "kind", "coords-like"]) if (typeof flags[key] === "string") query.set(key, flags[key]);
      const echo = ["attached-to", "kind", "coords-like"].filter((key) => typeof flags[key] === "string").map((key) => `--${key} ${flags[key]}`).join(" ");
      return { path: `/api/mirrors${query.size ? `?${query}` : ""}`, render: (body) => renderMirrorList(body, echo) };
    }
    case "mirror kinds": return { path: "/api/mirrors/kinds", render: (body) => renderMirrorKinds(body) };
    case "mirror show": {
      if (!id) return emit(out, missingArgument("mirror show requires a mirror id", "loopany mirror show <mirror-id>", ["Run `loopany mirror list` — every row prints the id"]), 2);
      const bad = mirrorIdRefusal(id, "mirror show"); if (bad) return emit(out, bad, 2);
      return { path: `/api/mirrors/${encodeURIComponent(id)}`, render: (body) => renderMirrorShow(body) };
    }
    case "mirror update": {
      if (!id) return emit(out, missingArgument("mirror update requires a mirror id", 'loopany mirror update <mirror-id> --note "…"', ["Run `loopany mirror list` — every row prints the id"]), 2);
      const bad = mirrorIdRefusal(id, "mirror update"); if (bad) return emit(out, bad, 2);
      if (flags.note === undefined) {
        return emit(out, errorEnvelope({
          message: "mirror update requires --note", code: "VALIDATION_ERROR", expected: `loopany mirror update ${id} --note "…"`,
          help: [
            "The note is the ONLY editable field a mirror has",
            "Coords and kind are the external thing's identity: a different PR is a different mirror, so detach this one and attach a new one",
          ],
        }), 2);
      }
      return { path: `/api/mirrors/${encodeURIComponent(id)}`, method: "PATCH", headers: json(), body: JSON.stringify({ note: nullToken(flags.note) }), render: (body) => renderMirrorUpdate(body) };
    }
    case "doc update": {
      if (!id) return emit(out, missingArgument("doc update requires a doc id", "loopany doc update <id> --file <path>", ["Run `loopany doc show <id> --file > d.md` to get the current text, edit it, then update"]), 2);
      const file = requireFile(command, flags, out, `loopany doc update ${id} --file <path>`); if (typeof file === "number") return file;
      const raw_ = readArtifact(file, deps, out); if (typeof raw_ === "number") return raw_;
      return { path: `/api/docs/${encodeURIComponent(id)}`, method: "PATCH", headers: markdown(), body: raw_, render: (body) => renderUpdate("doc", "updated", body, now()) };
    }
    case "loop list": return planLoopList(flags, out);
    case "loop show": {
      if (!id) return emit(out, missingArgument("loop show requires a loop id", "loopany loop show <loop-id>", ["Run `loopany loop list` — ids are printed by every create and every list row", "There is no `self`: your work order names your loop id on its first line"]), 2);
      const bad = loopIdRefusal(id, "loop show"); if (bad) return emit(out, bad, 2);
      return {
        path: `/api/loops/${encodeURIComponent(id)}`,
        headers: flags.file ? { Accept: "text/markdown" } : undefined,
        render: (body) => renderShow("loop", body, flags.full === true, now()),
      };
    }
    case "loop create": {
      const file = requireFile("loop create", flags, out); if (typeof file === "number") return file;
      const raw_ = readArtifact(file, deps, out); if (typeof raw_ === "number") return raw_;
      return { path: "/api/loops", method: "POST", headers: markdown(), body: raw_, render: (body) => renderCreate("loop", body, now()) };
    }
    case "loop pause": case "loop resume": case "loop retire": {
      const verb = command.slice("loop ".length);
      if (!id) return emit(out, missingArgument(`loop ${verb} requires a loop id`, `loopany loop ${verb} <loop-id>`, ["Run `loopany loop list` to find it — the roster prints every loop's id and status"]), 2);
      const bad = loopIdRefusal(id, `loop ${verb}`); if (bad) return emit(out, bad, 2);
      if (flags.note !== undefined && (typeof flags.note !== "string" || !flags.note.trim())) {
        return emit(out, missingArgument(`--note takes text`, `loopany loop ${verb} ${id} --note "…"`, ["The note lands on the lifecycle event and is the only record of why — or drop --note entirely, it is optional"]), 2);
      }
      return {
        path: `/api/loops/${encodeURIComponent(id)}/${verb}`, method: "POST", headers: json(),
        body: JSON.stringify(typeof flags.note === "string" ? { note: flags.note } : {}),
        render: (body) => renderLifecycle(verb, body),
      };
    }
    case "loop run-now": {
      if (!id) return emit(out, missingArgument("loop run-now requires a loop id", "loopany loop run-now <loop-id>", ["Run `loopany loop list` to find it — the roster prints every loop's id and status"]), 2);
      const bad = loopIdRefusal(id, "loop run-now"); if (bad) return emit(out, bad, 2);
      // No body: the loop already says what it does, so an off-cadence run is a
      // button, not a form (API spec §1.16).
      return { path: `/api/loops/${encodeURIComponent(id)}/run-now`, method: "POST", headers: json(), body: "{}", render: (body) => renderRunNow(body) };
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
      // The TWO governed execution facets: WHEN a loop runs and WHERE it runs.
      // Either alone is a legal change, both ride the ONE approval gate — and the
      // CLI must offer both, because `loop evolve` refuses a differing `workdir:`
      // by naming this verb, and a refusal may only name a route that exists.
      if (typeof flags.cron !== "string" && typeof flags.workdir !== "string") {
        return emit(out, missingArgument("loop update requires --cron and/or --workdir", `loopany loop update ${id} --cron "0 * * * *" --approval ev-<id>`, ["Governance moves a loop's cadence, its bound directory, or both — the charter is the free zone (`loop evolve`)"]), 2);
      }
      if (typeof flags.workdir === "string" && !flags.workdir.startsWith("/")) {
        return emit(out, errorEnvelope({
          message: "--workdir takes an absolute path", code: "VALIDATION_ERROR", wrote: flags.workdir, expected: "/Users/you/Workspace/your-repo",
          help: ["The claiming machine is unknown when this is written, so a relative or `~` path has nothing to resolve against", "The directory must already EXIST on the machine that runs this loop — a machine that lacks it fails the run rather than creating a lookalike"],
        }), 2);
      }
      if (typeof flags.approval !== "string") {
        const wrote = [typeof flags.cron === "string" ? `--cron ${flags.cron}` : "", typeof flags.workdir === "string" ? `--workdir ${flags.workdir}` : ""].filter(Boolean).join(" ");
        // The one refusal where an agent cannot proceed without being told a
        // whole protocol it has no other way to discover — so it prints all of it.
        return emit(out, errorEnvelope({
          message: "loop update requires --approval", code: "FORBIDDEN",
          wrote: `loopany loop update ${id} ${wrote}`,
          expected: `loopany loop update ${id} ${wrote} --approval ev-<id>`,
          help: [
            "Cadence and workdir are the keyed zone: an agent changes them only by presenting a human approval event",
            `Step 1: \`loopany task create --file <path> --needs-human "propose this change: …" --watcher ${id}\``,
            "Step 2: a human answers in the inbox; one run is queued for your loop with that task's scope",
            "Step 3: that run reads the verdict event id with `loopany task show <id>` and passes it as --approval",
          ],
        }), 2);
      }
      return {
        path: `/api/loops/${encodeURIComponent(id)}`, method: "POST", headers: json(),
        body: JSON.stringify({
          ...(typeof flags.cron === "string" ? { cron: flags.cron } : {}),
          ...(typeof flags.workdir === "string" ? { workdir: flags.workdir } : {}),
          approval: flags.approval,
        }),
        render: (body) => renderGovernance(body),
      };
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
  for (const key of ["watcher", "creator", "since"]) if (typeof flags[key] === "string") query.set(key, flags[key]);
  const echo = flagNames("task list").filter((flag) => flags[flag.slice(2)] !== undefined).map((flag) => (typeof flags[flag.slice(2)] === "string" ? `${flag} ${flags[flag.slice(2)]}` : flag)).join(" ");
  return { path: `/api/tasks?${query}`, render: (body) => renderTaskList(body, echo, now()) };
}

function planLoopList(flags: Flags, out: Emit): Plan | number {
  const status = flags.status;
  if (status !== undefined && (typeof status !== "string" || !LOOP_STATUSES.includes(status))) {
    return emit(out, errorEnvelope({
      message: "--status takes one loop state", code: "VALIDATION_ERROR",
      wrote: status === true ? ABSENT : status, expected: "active", allowed: LOOP_STATUSES,
      help: [
        "A loop is active, paused or retired — it never closes, because it is a standing cadence and not a unit of work",
        "Run `loopany loop list` with no flag for the whole roster, retired loops included",
      ],
    }), 2);
  }
  const query = typeof status === "string" ? `?status=${encodeURIComponent(status)}` : "";
  return { path: `/api/loops${query}`, render: (body) => renderLoopList(body, typeof status === "string" ? `--status ${status}` : "") };
}

function planTaskUpdate(id: string | undefined, flags: Flags, deps: KernelCliDeps, out: Emit, now: () => number): Plan | number {
  if (!id) return emit(out, missingArgument("task update requires a task id", "loopany task update <id> --follow-up +3d", ["Run `loopany task list --open` to find the id"]), 2);
  const fieldFlags = ["follow-up", "watcher", "needs-human", "payload-merge"].filter((key) => flags[key] !== undefined);
  if (!flags.file && !fieldFlags.length) {
    return emit(out, errorEnvelope({ message: "task update requires at least one field", code: "VALIDATION_ERROR", expected: `loopany task update ${id} --follow-up +3d`, allowed: flagNames("task update"), help: [`Run \`loopany task show ${id}\` if you only wanted to read it`] }), 2);
  }
  // TRANSFER ONLY: `--watcher null` used to release a task to the unclaimed
  // pool, and the pool is gone (`kernel/types.ts` WATCHER_HINT). Refused HERE,
  // client-side, so the release habit is corrected before a round trip.
  if (typeof flags.watcher === "string") { const bad = loopIdRefusal(flags.watcher, "--watcher"); if (bad) return emit(out, bad, 2); }

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
  if (flags.watcher !== undefined) patch.watcher = flags.watcher;
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
  const allowed = new Set([...flagNames(command).map((flag) => flag.slice(2)), ...(command === "task list" ? ["open", "closed", "due"] : [])]);
  return Object.keys(flags).find((key) => !allowed.has(key) && key !== "help");
}

function unknownFlagRefusal(command: string, flag: string): string {
  const allowed = flagNames(command);
  const near = nearest(`--${flag}`, allowed);
  /**
   * `mirror update --coords` is a NEAR MISS, not a typo, and the difference
   * matters: "unknown flag, allowed: --note" is true and teaches nothing. The
   * reason there is no such flag is a property of the system — coords are the
   * external thing's identity, so a different PR is a different mirror — and
   * the refusal has to say the property and name the two-step move, exactly as
   * the server does when the same intent arrives over HTTP.
   */
  if (command === "mirror update" && ["coords", "kind", "external-kind", "state", "status"].includes(flag)) {
    const cache = flag === "state" || flag === "status";
    return errorEnvelope({
      message: cache ? `a mirror has no --${flag}` : `a mirror's --${flag} cannot be changed`,
      code: "VALIDATION_ERROR", wrote: `--${flag}`, expected: "--note", allowed,
      help: cache
        ? [
            "A mirror tells you WHERE to look, never WHAT state it is in — there is no state field, and the schema has nowhere to put one",
            "Record what you FOUND on the task that owns the work; the pointer stays a pointer, so the next run goes and looks rather than trusting a stale copy",
          ]
        : [
            "Coords and kind are the external thing's IDENTITY: a different PR is a different mirror, not the same row repointed",
            "Detach this one and attach a new one: `loopany mirror detach <mirror-id> --from <object-id>` then `loopany mirror attach <object-id> --kind <k> --coords <new>`",
            "Repointing the row would silently rewrite every timeline that already cites it",
          ],
    });
  }
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
function loopIdRefusal(value: string, where: string): string | undefined {
  if (value.startsWith("loop-")) return undefined;
  return errorEnvelope({
    message: `${where} takes a loop id`, code: "VALIDATION_ERROR", wrote: value, expected: "loop-4c1d77",
    help: [
      "There is no `self` keyword — your work order names your loop id on its first line",
      "Loop ids are kind-prefixed: they start with `loop-`",
      // `null` is the one wrong value worth naming: it was legal until the
      // watcher rule, so an agent carrying the old habit gets the reason rather
      // than a bare "not a loop id".
      ...(value === "null" ? ["A task's watcher is never empty: it is HANDED to another loop, never released. `loopany loop list` and `loopany loops` both print ids you can name."] : []),
    ],
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
  rows.push(["watcher", row.watcher ?? ABSENT]);
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

function loopRows(row: Body): [string, unknown][] {
  // `workdir` is the loop's BOUND execution site, so it belongs beside the
  // cadence: cron says when, workdir says where. Absent ⇒ the claiming daemon's
  // own per-loop scratch dir, which is a real answer, not a blank.
  const rows: [string, unknown][] = [["id", row.id], ["title", row.title], ["status", row.status], ["cron", row.cron], ["timezone", row.timezone], ["next_fire", nextFireCell(row)], ["workdir", row.workdir ?? raw(`${ABSENT} (the daemon's own scratch dir)`)], ["key", row.key]];
  for (const field of ["createdByRun", "createdByLoop", "createdAt", "updatedAt"]) {
    if (row[field] !== undefined) rows.push([label(field), row[field]]);
  }
  return rows;
}

function kindRows(kind: Kind, row: Body, now: number): [string, unknown][] {
  return kind === "task" ? taskRows(row, now) : kind === "doc" ? docRows(row) : loopRows(row);
}

function payloadBlock(row: Body): string {
  const payload = row.payload as Body | undefined;
  const entries = Object.entries(payload ?? {});
  return entries.length ? `payload:\n${entries.map(([key, value]) => `  ${key}: ${cell(value)}`).join("\n")}\n` : "";
}

function renderShow(kind: Kind, body: Body, full: boolean, now: number): string {
  const row = object(body);
  if (!row) return `error: "the server returned no ${kind}"\ncode: ERROR\n${helpBlock(["Retry; if it persists the server and this CLI disagree about the response shape"])}`;
  let text = detailBlock(kind, kindRows(kind, row, now));
  text += payloadBlock(row);
  if (typeof row.body === "string") text += `${kind === "loop" ? "charter" : "body"}: ${cell(bodyValue(row.body, full))}\n`;
  // EXTERNAL ITEMS, right under the object and above its history: the whole
  // point of the kind is that a run reading this knows what to go and check, so
  // burying it below the event tail would defeat it. `coords` is what you use;
  // there is no state column here and there never will be.
  text += mirrorsBlock(body);
  const events = (Array.isArray(body.events) ? body.events : []) as Body[];
  // `seq` leads: it is what totally orders the tail even when two events share a
  // timestamp, and it is the cursor the UI's stream resumes from. The content id
  // is a dedup key, not a handle, so it is not printed.
  text += typedList("events", ["seq", "ts", "actor", "entrance", "change"], events.map((event) => [event.seq, event.ts, event.actor, event.entrance, changeSummary(event)]));
  const id = String(row.id ?? "<id>");
  return text + helpBlock(showHints(kind, id, row));
}

/** The mirrors attached to an object, on every `show`. Rendered only when the
 *  server sent the key at all, so an older server degrades to silence rather
 *  than to a false `mirrors: []`. */
function mirrorsBlock(body: Body): string {
  if (!Array.isArray(body.mirrors)) return "";
  const mirrors = body.mirrors as Body[];
  return typedList("mirrors", ["id", "kind", "coords", "note"], mirrors.map((m) => [m.id, m.externalKind, m.coords, m.note]));
}

function showHints(kind: Kind, id: string, row: Body): string[] {
  if (kind === "task") return [`Run \`loopany task update ${id} --follow-up +1d\` to push the check out`, `Run \`loopany task update ${id} --needs-human "…"\` if you need a decision`, `Run \`loopany task close ${id} --note "…"\` when it is verified`];
  if (kind === "doc") return [`Run \`loopany doc show ${id} --full\` to read the complete body`, `Run \`loopany doc show ${id} --file > d.md\` to start an edit from the current text`];
  if (row.status === "retired") return [`${id} is retired: its charter is frozen and it never fires again, but the whole record stays readable`, "Run `loopany loop list --status active` for the loops that are still running"];
  return [
    `Run \`loopany loop show ${id} --file > charter.md\` to start a charter edit from the current text`,
    `Run \`loopany loop evolve ${id} --file charter.md\` to apply it — the charter is the free zone, no approval key`,
    row.status === "paused"
      ? `Paused, so next_fire is empty; a human resumes it with \`loopany loop resume ${id}\``
      : `Cadence is governance: \`loopany loop update ${id} --cron "…" --approval ev-<id>\` from a run, or the owner edits it`,
  ];
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
    return text + helpBlock([`Run \`loopany task list --watcher ${own}\` for everything this loop is on the hook for, due or not`, "Nothing due is a clean result — do not manufacture work"]);
  }
  const one = tasks.length === 1 ? String(tasks[0]!.id) : "<id>";
  const hints = [`Run \`loopany task show ${one}\` to read one, with its payload and event tail`, `Run \`loopany task update ${one} --follow-up +3d\` to change when its watcher is woken for it`];
  if (body.truncated) hints.unshift(`Showing the first ${tasks.length} of ${total} — narrow the query rather than paging`);
  else hints.push(`Run \`loopany task list --watcher ${own} --due\` for the work you already own`);
  return text + helpBlock(hints);
}

function renderLoopList(body: Body, echo: string): string {
  const loops = (Array.isArray(body.loops) ? body.loops : []) as Body[];
  const total = typeof body.total === "number" ? body.total : loops.length;
  let text = countLine(loops.length, total);
  text += typedList("loops", ["id", "title", "status", "cron", "next_fire"], loops.map((loop) => [loop.id, loop.title, loop.status, loop.cron, loop.nextFire]));
  if (!loops.length) {
    // The filter echo lets a caller seeing zero distinguish "my predicate was
    // narrow" from "there are no loops at all" without a second call.
    if (echo) text += `filter: ${cell(echo)}\n`;
    return text + helpBlock([
      echo ? "Run `loopany loop list` with no flag for the whole roster, retired loops included" : "Run `loopany loop create --file <path>` to make the first one — the file is the loop, and its body is the charter",
      "An empty roster is a clean result, not an error",
    ]);
  }
  const one = loops.length === 1 ? String(loops[0]!.id) : "<loop-id>";
  const hints = [`Run \`loopany loop show ${one}\` to read one, with its charter and event tail`];
  if (body.truncated) hints.unshift(`Showing the first ${loops.length} of ${total} — narrow with --status rather than paging`);
  hints.push("A blank next_fire means the loop is paused, retired, or has no cadence — `loop show` names which");
  hints.push("Retired loops stay listed on purpose: the kernel is event-sourced, so nothing is ever deleted");
  return text + helpBlock(hints);
}

/**
 * pause / resume / retire. The lifecycle is the one place where "nothing
 * changed" is the COMMON answer (a retry after a dropped connection), so the
 * no-change case is stated in the ok: line rather than left to the empty diff.
 *
 * RETIRE WARNS, IT NEVER BLOCKS (captain ruling 2026-08-04): retiring a loop
 * that still watches open tasks succeeds, and the server returns a `warning`
 * naming the count. It prints on its OWN line above the detail block — not
 * folded into the help — because a hint is advice about what to do next, and
 * this is a fact about what just happened. `ok:` still leads: the retirement
 * did land, and a warning that read as a failure would be a lie.
 */
function renderLifecycle(verb: string, body: Body): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const changed = body.changed !== false;
  const past = verb === "retire" ? "retired" : `${verb}d`;
  const warning = body.warning as Body | undefined;
  let text = `ok: ${past} ${id}${changed ? "" : ` (no change: already ${row.status ?? past})`}\n`;
  if (warning) text += `warning: ${cell(warning.message)}\n`;
  text += detailBlock("loop", [["id", row.id], ["title", row.title], ["status", row.status], ["cron", row.cron], ["next_fire", nextFireCell(row)]]);
  text += changedBlock(body.diff as never);
  text += eventLine(body.event);
  if (!changed) return text + helpBlock([`Already ${row.status ?? past} — the lifecycle verbs are idempotent, so a retry after a dropped connection costs nothing`]);
  const hints = lifecycleHints(verb, id);
  if (warning && typeof warning.hint === "string") hints.unshift(warning.hint);
  return text + helpBlock(hints);
}

/**
 * `loop run-now` — the MANUAL fire. Two things must be unmissable in the output,
 * because both are counter-intuitive from any other scheduler:
 *
 *   1. a PAUSED loop fires and STAYS paused (pause governs the cadence, not this
 *      button), so the render prints the status back and says the cadence was not
 *      touched — a caller must never read a successful fire as a resume;
 *   2. the queue is one-run-per-loop, so a second fire REPORTS the run already
 *      queued rather than minting a twin.
 */
function renderRunNow(body: Body): string {
  const row = object(body) ?? {};
  const run = (body.run ?? {}) as Body;
  const already = body.alreadyQueued === true;
  const paused = row.status === "paused";
  let text = `ok: ${already ? "already queued" : "queued"} ${cell(run.id)} for ${cell(row.id)}\n`;
  text += detailBlock("loop", [["id", row.id], ["title", row.title], ["status", row.status], ["next_fire", nextFireCell(row)]]);
  text += detailBlock("run", [["id", run.id], ["state", run.state], ["reason", run.reason]]);
  const hints: string[] = [];
  if (already) hints.push("This loop already had a run queued — one queued run per loop, so the fire joined it instead of minting a twin");
  if (paused) hints.push(`${cell(row.id)} is PAUSED and stays paused: the fire does not resume the cadence, so it is one run and then quiet again`);
  hints.push("A machine of this team claims it on its next poll; a loop bound to a workdir that machine lacks fails the run rather than running elsewhere");
  hints.push(`Run \`loopany loop show ${cell(row.id)}\` to watch it land in the event tail`);
  return text + helpBlock(hints);
}

function lifecycleHints(verb: string, id: string): string[] {
  if (verb === "pause") {
    return [
      "Disarmed: next_fire is cleared and no run of this loop is claimed until it resumes",
      `Time never un-pauses a loop — run \`loopany loop resume ${id}\` when you want it back`,
      "Everything it created stays open and readable; pausing the loop does not close its tasks",
    ];
  }
  if (verb === "resume") {
    return [
      "Re-armed to the NEXT occurrence — a week paused owes exactly one fire, not a week of them",
      `Run \`loopany loop show ${id}\` to read the new next_fire`,
      "This is also the only exit from a failure auto-pause",
    ];
  }
  return [
    "Retire is the delete: the kernel is event-sourced, so nothing is erased and there is no un-retire",
    "Any task it still watches keeps naming it, and a retired loop is never woken again — this is warned about, never blocked",
    "The charter is frozen from here — `loop evolve` and `loop update` are refused for this loop for good",
    "Run `loopany loop list --status retired` to read the retired roster; every run and product it made is kept",
  ];
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

function renderCreate(kind: Kind, body: Body, now: number): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const replay = body.created === false;
  let text = `ok: created ${id}${replay ? " (idempotent: existing object returned)" : ""}\n`;
  text += noticeLines(body, `loopany ${kind} update ${id} --file <path>`);
  text += detailBlock(kind, kindRows(kind, row, now));
  const hints: string[] = [];
  if (replay && body.contentDiffers) {
    hints.push(`Key ${cell(row.key)} already exists — create is idempotent, so your changes were NOT applied`);
    // `loop create` is human-only and `loop evolve` is agent-only, so pointing a
    // human at evolve sends them into a NO_RUN_CONTEXT refusal. Until the human
    // loop edit lands, say what a person can actually do.
    if (kind === "loop") {
      hints.push(
        `There is no human CLI verb that applies them: \`loop evolve\` runs inside a run, so edit the charter on the loop page`,
        `A run of this loop evolves its own charter; a differing \`cron:\` or \`workdir:\` stays yours even then (evolve refuses it, APPROVAL_REQUIRED)`,
      );
    } else {
      hints.push(`Run \`loopany ${kind} update ${id} --file <path>\` to apply them`);
    }
  } else if (kind === "loop") {
    // Every safe default has a CONSEQUENCE, and a loop with no cadence is the
    // one that silently never runs. Say which of the two was born.
    hints.push(row.nextFire
      ? `Armed: the first run fires at ${cell(row.nextFire)} and is claimed by any machine of this team — no MACHINE is bound`
      : "No `cron:` in the file, so this loop has no cadence and will never fire on its own — add one and evolve, or drive it by hand");
    hints.push(row.workdir
      ? `Bound to ${cell(row.workdir)}: every run executes there, and a machine that lacks it fails the run instead of running elsewhere`
      : "No `workdir:` in the file, so runs get the daemon's own per-loop scratch dir — bind one to run in a real checkout");
    hints.push(`Run \`loopany loop show ${id}\` to read it back, \`loopany loop pause ${id}\` to stop it`);
    hints.push(`Its runs evolve the charter themselves; cadence, lifecycle and creating further loops stay yours`);
  } else {
    hints.push(`Run \`loopany ${kind} show ${id}\` to read it back`);
    if (kind === "task") {
      if (row.pendingQuestion) {
        hints.push("This task is in the human inbox now; `loopany task close` is refused until it is answered", `On answer, one run is queued for ${cell(row.watcher)} with scope ${id} — read the answer with \`loopany task show ${id}\``);
      } else if (!row.followUpAt) {
        // Every safe default has a CONSEQUENCE; printing it at creation is how
        // the agent learns what omitting a field actually did. Here: the watcher
        // DEFAULTED to this run's own loop, and with no follow_up nothing wakes
        // it for this task.
        hints.push(
          `${cell(row.watcher)} is watching it${row.watcher === row.createdByLoop ? " — the default: a task you file is yours unless you name another loop" : ""}`,
          `Run \`loopany task update ${id} --follow-up +3d\` to have that loop woken for it; with no follow_up it waits for the loop's own cadence`,
        );
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
      ? [`${cell(row.watcher)} is woken automatically when the follow_up arrives — you do not have to poll for it`, `Run \`loopany task close ${id} --note "…"\` when it is verified`]
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
    // The QUESTION is the thing to read on an inbox row — it is what the
    // person is being asked, and the title only names the work it hangs on.
    const title = task.pendingQuestion ?? task.title;
    return [task.id, title, reasons.join("+"), waiting(item.askedAt ?? (task.createdAt as string), now), task.watcher];
  }));
  return text + helpBlock(items.length
    ? ['Run `loopany answer <task-id> "…"` to reply — free text; approve/reject plus instructions are all just the answer', "Run `loopany task show <task-id>` to read the full question, its payload and its history", "Answering queues one run for the watching loop — every task has one, so every answer reaches somebody"]
    : ["Nothing is waiting on you — the default mode is zero human involvement, by design", "Run `loopany task list --open` if you want to look at the open work anyway"]);
}

/**
 * `task tell` — the human speaking first.
 *
 * It renders like `answer` on purpose: they are the same wire and the same
 * consequence (one run for the watcher, the task in scope), and printing them
 * differently would suggest two mechanisms. The one difference the output
 * insists on is WHAT the run is being asked to do — execute the intent against
 * reality, not merely record it — because that is the part a person cannot tell
 * from a run id.
 */
function renderDirective(body: Body): string {
  const row = object(body) ?? {};
  const id = String(row.id ?? ABSENT);
  const run = body.run as Body | undefined;
  const notice = body.notice as Body | undefined;
  let text = `ok: told ${id}\n`;
  text += detailBlock("directive", [["task", row.id], ["title", row.title], ["said", body.directive]]);
  text += eventLine(body.event);
  if (run) {
    text += detailBlock("wake", [["run", run.alreadyQueued ? raw(`${cell(run.id)} (already queued)`) : run.id], ["loop", run.loopId], ["scope", String(run.scope ?? "").replace(/^task:/, "")], ["reason", run.reason], ["state", run.state]]);
  } else {
    text += `wake: ${ABSENT} (the watching loop had no run to queue — the directive is on the record)\n`;
  }
  if (notice) text += `warning: ${cell(notice.message)}\n`;
  const hints: string[] = [];
  if (run?.alreadyQueued) hints.push(`${cell(run.loopId)} already had a run queued — it reads this task's timeline when it claims, so the directive is not lost; one run, not two`);
  else if (run) hints.push(`One run is queued for ${cell(run.loopId)}, and your words ride in its work order verbatim`);
  hints.push("It acts on the INTENT against external reality first and this kernel's records last — so \"drop this bet\" closes the PR before it closes the task");
  if (notice && typeof notice.hint === "string") hints.unshift(notice.hint);
  hints.push(`Run \`loopany task show ${id}\` to read what it did`);
  return text + helpBlock(hints);
}

// ----------------------------------------------------------------- mirrors

/** The teaching line every mirror render ends with. Authored once here because
 *  it is the whole model in one sentence, and an agent should meet it on every
 *  mirror surface rather than only when it gets something wrong. */
const MIRROR_LAW_LINE = "A mirror tells you WHERE to look, never WHAT state it is in — go and check the coords, then record what you found on the task";

function mirrorRows(m: Body): [string, unknown][] {
  return [["id", m.id], ["kind", m.externalKind], ["coords", m.coords], ["note", m.note], ["href", m.href], ["attached_to", Array.isArray(m.attachedTo) ? (m.attachedTo as unknown[]).join(", ") : ABSENT]];
}

function renderAttach(body: Body): string {
  const mirror = (body.mirror ?? {}) as Body;
  const fresh = body.created === true;
  const changed = body.changed !== false;
  const notice = body.notice as Body | undefined;
  let text = `ok: attached ${cell(mirror.id)} to ${cell(body.object)}${fresh ? "" : changed ? " (existing mirror, now shared)" : " (no change: already attached)"}\n`;
  if (notice) text += `warning: ${cell(notice.message)}\n`;
  text += detailBlock("mirror", mirrorRows(mirror));
  text += eventLine(body.event);
  const hints: string[] = [];
  if (!fresh && changed) hints.push("One external thing is one mirror, so this attached the EXISTING row rather than minting a twin — everything it already hangs on still hangs on it");
  if (notice && typeof notice.hint === "string") hints.push(notice.hint);
  hints.push(MIRROR_LAW_LINE);
  hints.push(`Run \`loopany mirror detach ${cell(mirror.id)} --from ${cell(body.object)}\` when this object no longer depends on it`);
  return text + helpBlock(hints);
}

function renderDetach(body: Body): string {
  const mirror = (body.mirror ?? {}) as Body;
  const changed = body.changed !== false;
  const notice = body.notice as Body | undefined;
  let text = `ok: detached ${cell(mirror.id)} from ${cell(body.object)}${changed ? "" : " (no change: it was not attached)"}\n`;
  text += detailBlock("mirror", mirrorRows(mirror));
  text += eventLine(body.event);
  const hints: string[] = [];
  if (!changed && notice) hints.push("Detach is idempotent — a retry after a dropped connection costs nothing");
  if (body.orphaned === true) hints.push(`Nothing depends on ${cell(mirror.coords)} any more. The mirror stays readable — nothing in this kernel is ever deleted — and attaching it again revives the same row`);
  hints.push(`Run \`loopany mirror attach <object-id> --kind ${cell(mirror.externalKind)} --coords ${cell(mirror.coords)}\` to point something else at it`);
  return text + helpBlock(hints);
}

function renderMirrorList(body: Body, echo: string): string {
  const mirrors = (Array.isArray(body.mirrors) ? body.mirrors : []) as Body[];
  const total = typeof body.total === "number" ? body.total : mirrors.length;
  let text = countLine(mirrors.length, total);
  text += typedList("mirrors", ["id", "kind", "coords", "note", "attached"], mirrors.map((m) => [m.id, m.externalKind, m.coords, m.note, Array.isArray(m.attachedTo) ? (m.attachedTo as unknown[]).length : 0]));
  if (!mirrors.length) {
    if (echo) text += `filter: ${cell(echo)}\n`;
    return text + helpBlock([
      echo ? "Run `loopany mirror list` with no filter to see everything this team points at" : "Nothing external is tracked yet — attach the first with `loopany mirror attach <object-id> --kind github-pr --coords owner/repo#57`",
      "An empty list is a clean result, not an error",
    ]);
  }
  const one = mirrors.length === 1 ? String(mirrors[0]!.id) : "<mirror-id>";
  const hints = [`Run \`loopany mirror show ${one}\` to read one, with the objects that depend on it`, MIRROR_LAW_LINE];
  if (body.truncated) hints.unshift(`Showing the first ${mirrors.length} of ${total} — narrow with --kind or --coords-like rather than paging`);
  return text + helpBlock(hints);
}

function renderMirrorKinds(body: Body): string {
  const kinds = (Array.isArray(body.kinds) ? body.kinds : []) as Body[];
  const canonical = (Array.isArray(body.canonical) ? body.canonical : []) as Body[];
  let text = countLine(kinds.length);
  text += typedList("in_use", ["kind", "count", "known"], kinds.map((k) => [k.kind, k.count, k.known === true ? "yes" : "no"]));
  text += typedList("canonical", ["kind", "what", "coords"], canonical.map((k) => [k.kind, k.what, k.coords]));
  return text + helpBlock([
    "Kinds are FREE-FORM and normalized to kebab-case on write, so `GitHub PR` and `github_pr` both become `github-pr`",
    "A canonical kind also has its coords SHAPE checked; an unknown one is accepted as a plain string",
    kinds.some((k) => k.known === false)
      ? "The kinds marked known: no are this team's own vocabulary — that is the system working, not a mistake"
      : "Invent a kind when none of these fits; it will appear here for the next reader",
  ]);
}

function renderMirrorShow(body: Body): string {
  const mirror = (body.mirror ?? {}) as Body;
  const events = (Array.isArray(body.events) ? body.events : []) as Body[];
  let text = detailBlock("mirror", mirrorRows(mirror));
  text += typedList("events", ["seq", "ts", "actor", "entrance", "change"], events.map((event) => [event.seq, event.ts, event.actor, event.entrance, changeSummary(event)]));
  return text + helpBlock([
    MIRROR_LAW_LINE,
    `Run \`loopany mirror update ${cell(mirror.id)} --note "…"\` to relabel it — the note is the only editable field`,
    "Coords and kind are the external thing's identity: a different PR is a different mirror, so detach and attach a new one",
  ]);
}

function renderMirrorUpdate(body: Body): string {
  const mirror = (body.mirror ?? {}) as Body;
  const changed = body.changed !== false;
  let text = `ok: relabelled ${cell(mirror.id)}${changed ? "" : " (no change)"}\n`;
  text += detailBlock("mirror", mirrorRows(mirror));
  text += changedBlock(body.diff as never);
  text += eventLine(body.event);
  return text + helpBlock([
    "The label is shared by everything this mirror is attached to — one external thing is one mirror",
    MIRROR_LAW_LINE,
  ]);
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
    // Every task names a watcher, so this is the queue declining rather than
    // an absent one: the loop is retired, or is not this team's.
    text += `wake: ${ABSENT} (the watching loop had no run to queue — the answer is on the record)\n`;
  }
  return text + helpBlock(run
    ? (run.alreadyQueued
      ? [`${cell(run.loopId)} already had a run queued — it will pull both answered tasks when it claims; one run, not two`, "Run `loopany inbox` to see what is still waiting"]
      : [`One run is queued for ${cell(run.loopId)} — it will read your answer and act; nothing else is needed from you`, `Event ${cell(body.event)} is the approval key for this task, if the answer approved a governance change`, "Run `loopany inbox` to see what is still waiting"])
    : ["Nothing is queued: the watching loop could not take a run — most likely it is retired, which is terminal", "Run `loopany task update <task-id> --watcher <loop-id>` to hand it to a live loop, or close it yourself in the web UI"]);
}
