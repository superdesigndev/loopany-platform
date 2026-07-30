/**
 * THE `graph` CLI ROUTER - argv in, text out.
 *
 * The `graph` binary is a pure TEXT SINK (the same shape `loopany` settled on):
 * it collects argv, inlines any file its verb needs, POSTs, prints `text` and
 * exits with `exitCode`. Every decision about what a result LOOKS like is made
 * here, server-side, once - so the CLI, the HTTP verb endpoints and the workspace
 * UI cannot drift in what they say about the same operation (captain decision 16).
 *
 * ── the three things this module is responsible for ─────────────────────────
 *
 *   PARSING     argv → a verb and its flags. Unknown flags are REFUSED rather
 *               than ignored: a run that misspells `--questoin` and gets a review
 *               with no question has been failed silently, which is the one thing
 *               decision 15(c) says must never happen.
 *   ROLE FENCE  a verb outside this run's subset is refused WITH the subset
 *               (decision 15a). Printing the subset in the work order and not
 *               enforcing it would make stability a matter of the model reading
 *               carefully.
 *   RENDERING   every result through `render.ts`, so success prints the next
 *               commands and a refusal prints the way out.
 *
 * The verbs themselves are in `verbs.ts` and know nothing about argv - they are
 * the same functions the HTTP verb endpoints and the UI call.
 */
import { logger } from "../../logger.js";
import { errorBlock, helpBlock } from "../../gateway/toon.js";
import { renderFail, renderOk } from "./render.js";
import { ALL_VERBS, VERBS, roleMayCall, verbsForRole } from "./roles.js";
import {
  artifactPush,
  mirrorTrack,
  reviewRequest,
  taskCreate,
  taskMove,
  waitAnswer,
  waitOpen,
  type VerbContext,
  type VerbResult,
} from "./verbs.js";

export interface CliResult {
  text: string;
  exitCode: number;
  /** The structured half, for `--json`. */
  json: unknown;
}

/** What a run is allowed to call, and as whom. */
export interface CliRunContext extends VerbContext {
  /** The role from the work order. Undefined ⇒ NOTHING is callable (fail-closed:
   *  a work order that forgot to name a role must not get all seven verbs). */
  role?: string;
  /** Skip the role fence - the HUMAN surfaces (UI, operator scripts). A person is
   *  not a run and has no work order; the fence exists to keep ONE run narrow. */
  unfenced?: boolean;
}

/**
 * Run one `graph` command.
 *
 * Never throws for a caller error: every refusal is a typed result with an exit
 * code, because a stack trace in an agent's context is a turn spent on the wrong
 * problem.
 */
export async function graphCli(ctx: CliRunContext, argv: string[]): Promise<CliResult> {
  const args = argv.filter((a) => typeof a === "string");
  if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return { text: usage(ctx), exitCode: args.length ? 0 : 2, json: { verbs: callable(ctx) } };
  }

  // Two-word verbs, all of them. Resolved before flag parsing so `task move` and
  // `task create` are one lookup rather than a switch inside a switch.
  const verb = `${args[0]} ${args[1] ?? ""}`.trim();
  if (!VERBS[verb]) {
    const known = callable(ctx);
    return {
      text: [
        errorBlock(`"${args.slice(0, 2).join(" ")}" is not a command`, "VALIDATION_ERROR"),
        helpBlock(known.length ? known.map((v) => `${VERBS[v]!.syntax}`) : ["this run has no verbs - see its work order"]),
      ].join("\n"),
      exitCode: 2,
      json: { error: "unknown command", allowed: known },
    };
  }

  const rest = args.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { text: verbHelp(verb), exitCode: 0, json: { verb, ...VERBS[verb]! } };
  }

  // THE ROLE FENCE. Before parsing, so an out-of-role call is refused for the
  // right reason rather than for a missing flag it was never going to need.
  if (!ctx.unfenced && !roleMayCall(ctx.role, verb)) {
    const allowed = verbsForRole(ctx.role);
    logger.warn({ verb, role: ctx.role ?? null, run: ctx.actor.actorId }, "graph cli: verb outside this run's role");
    return {
      text: [
        errorBlock(
          ctx.role
            ? `this run's role is "${ctx.role}", which does not include \`${verb}\``
            : "this work order names no role, so no verb is available to it",
          "FORBIDDEN",
        ),
        allowed.length
          ? helpBlock(allowed.map((v) => VERBS[v]!.syntax))
          : helpBlock(["ask the person who dispatched this run - the work order is incomplete"]),
      ].join("\n"),
      exitCode: 1,
      json: { error: "verb outside role", role: ctx.role ?? null, allowed },
    };
  }

  const parsed = parseFlags(rest, FLAGS[verb]!);
  if (!parsed.ok) {
    return {
      text: [errorBlock(parsed.why, "VALIDATION_ERROR"), helpBlock([VERBS[verb]!.syntax])].join("\n"),
      exitCode: 2,
      json: { error: parsed.why },
    };
  }
  const { flags, positional } = parsed;
  const wantJson = flags.has("json");

  let result: VerbResult;
  try {
    result = await dispatch(ctx, verb, flags, positional);
  } catch (err) {
    // A crash is reported as a refusal, loudly and typed. A run that gets a 500
    // with no shape cannot tell "my call was wrong" from "the server broke".
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ verb, err: message, run: ctx.actor.actorId }, "graph cli: verb threw");
    return {
      text: errorBlock(`the server could not complete \`${verb}\`: ${message}`, "ERROR"),
      exitCode: 1,
      json: { error: message },
    };
  }

  if (!result.ok) {
    return {
      text: wantJson ? JSON.stringify(result) : renderFail(verb, result),
      exitCode: 1,
      json: result,
    };
  }
  return {
    text: wantJson ? JSON.stringify({ ok: true, ...result.data, next: result.next }) : renderOk(verb, result),
    exitCode: 0,
    json: { ok: true, ...result.data, next: result.next },
  };
}

// ---- dispatch ----

async function dispatch(
  ctx: CliRunContext,
  verb: string,
  flags: Map<string, string | true>,
  positional: string[],
): Promise<VerbResult> {
  const s = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const on = (k: string): boolean => flags.has(k);

  switch (verb) {
    case "task create":
      return taskCreate(ctx, {
        type: s("type") ?? "",
        ...(s("title") ? { title: s("title")! } : {}),
        ...(s("key") ? { key: s("key")! } : {}),
        ...(s("for") ? { forId: s("for")! } : {}),
        fields: parseFields(flags),
      });

    case "task move":
      return taskMove(ctx, {
        objectId: positional[0] ?? "",
        transition: positional[1] ?? "",
        ...(s("note") ? { note: s("note")! } : {}),
      });

    case "artifact push":
      return artifactPush(ctx, {
        // The CLI inlines the file's bytes (the server never touches a disk); the
        // positional path survives only as the default title.
        body: s("body") ?? "",
        ...(positional[0] ? { filename: baseName(positional[0]) } : {}),
        ...(s("title") ? { title: s("title")! } : {}),
        ...(s("type") ? { type: s("type")! } : {}),
        ...(s("for") ? { forId: s("for")! } : {}),
        ...(s("replaces") ? { replacesId: s("replaces")! } : {}),
      });

    case "review request":
      return reviewRequest(ctx, {
        question: s("question") ?? "",
        ...(s("about") ? { aboutId: s("about")! } : {}),
        ...(s("preset") ?? s("kind") ? { preset: (s("preset") ?? s("kind"))! } : {}),
        ...(s("title") ? { title: s("title")! } : {}),
        fields: {
          ...parseFields(flags),
          // Domain semantics as INSTANCE DATA (decision 17): what an approval
          // should cause, in prose, for an agent to carry out.
          ...(s("consequence") ? { consequence: s("consequence")! } : {}),
        },
      });

    case "mirror track":
      return mirrorTrack(ctx, {
        ref: positional[0] ?? "",
        ...(s("source") ? { source: s("source")! } : {}),
        ...(s("external-id") ? { externalId: s("external-id")! } : {}),
        ...(s("title") ? { title: s("title")! } : {}),
        ...(s("for") ? { forId: s("for")! } : {}),
      });

    case "wait open":
      return waitOpen(ctx, {
        objectId: positional[0] ?? "",
        key: s("key") ?? "",
        question: s("question") ?? "",
        watcherId: s("watcher") ?? "",
        ...(s("label") ? { label: s("label")! } : {}),
      });

    case "wait answer": {
      const met = on("met");
      const notMet = on("not-met");
      if (met === notMet) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message: "say exactly one of --met or --not-met - an answer that says both says nothing",
          allowed: ["--met", "--not-met"],
        };
      }
      return waitAnswer(ctx, {
        objectId: positional[0] ?? "",
        key: positional[1] ?? "",
        met,
        evidence: s("evidence") ?? "",
      });
    }

    default:
      return { ok: false, code: "VALIDATION_ERROR", message: `\`${verb}\` has no implementation` };
  }
}

// ---- flags ----

/**
 * Which flags each verb accepts. EXHAUSTIVE on purpose: an unknown flag is a
 * refusal, so a typo surfaces as one loud line instead of a silently-dropped
 * argument. `--json` and `--help` are universal.
 */
const FLAGS: Record<string, { value: string[]; boolean: string[]; positional: number }> = {
  "task create": { value: ["type", "title", "key", "for", "field"], boolean: [], positional: 0 },
  "task move": { value: ["note"], boolean: [], positional: 2 },
  "artifact push": { value: ["body", "title", "type", "for", "replaces"], boolean: [], positional: 1 },
  "review request": {
    value: ["about", "question", "preset", "kind", "title", "consequence", "field"],
    boolean: [],
    positional: 0,
  },
  "mirror track": { value: ["source", "external-id", "title", "for"], boolean: [], positional: 1 },
  "wait open": { value: ["key", "question", "watcher", "label"], boolean: [], positional: 1 },
  "wait answer": { value: ["evidence"], boolean: ["met", "not-met"], positional: 2 },
};

const UNIVERSAL_BOOLEAN = ["json"];

type ParseResult =
  | { ok: true; flags: Map<string, string | true>; positional: string[] }
  | { ok: false; why: string };

/**
 * Parse `--k v`, `--k=v` and boolean flags. Repeating a value flag (`--field`)
 * keeps every occurrence under a numbered key, which is how `--field k=v --field
 * j=w` reaches `parseFields` without a second parser.
 */
export function parseFlags(argv: string[], spec: { value: string[]; boolean: string[]; positional: number }): ParseResult {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const booleans = new Set([...spec.boolean, ...UNIVERSAL_BOOLEAN]);
  const values = new Set(spec.value);
  let repeat = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (booleans.has(name)) {
      if (inline !== undefined) return { ok: false, why: `--${name} is a switch and takes no value` };
      flags.set(name, true);
      continue;
    }
    if (!values.has(name)) {
      return {
        ok: false,
        why: `unknown flag --${name} (this verb takes: ${[...values, ...booleans].map((f) => `--${f}`).join(", ")})`,
      };
    }
    const value = inline ?? argv[++i];
    if (value === undefined) return { ok: false, why: `--${name} needs a value` };
    // A repeated value flag keeps every occurrence; the last plain one still wins
    // for single-value flags, which is the least surprising behavior.
    if (flags.has(name)) flags.set(`${name}#${repeat++}`, value);
    else flags.set(name, value);
  }

  if (positional.length > spec.positional) {
    return { ok: false, why: `too many arguments: this verb takes ${spec.positional}` };
  }
  return { ok: true, flags, positional };
}

/** `--field k=v` occurrences → an object. Values that parse as JSON land as JSON
 *  (so `--field mergeIntent=true` is a boolean and `--field n=3` a number), which
 *  is what lets instance data carry a domain without a typed schema per domain. */
export function parseFields(flags: Map<string, string | true>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of flags) {
    if (key !== "field" && !key.startsWith("field#")) continue;
    if (typeof value !== "string") continue;
    const at = value.indexOf("=");
    if (at <= 0) continue;
    const name = value.slice(0, at).trim();
    const raw = value.slice(at + 1);
    if (!name) continue;
    out[name] = coerce(raw);
  }
  return out;
}

function coerce(raw: string): unknown {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("{") || v.startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ---- help ----

function callable(ctx: CliRunContext): string[] {
  return ctx.unfenced ? ALL_VERBS : verbsForRole(ctx.role);
}

function usage(ctx: CliRunContext): string {
  const verbs = callable(ctx);
  const lines = [
    "graph — the workspace's operation surface.",
    "",
    ctx.unfenced
      ? "Every verb, because you are acting as a person rather than as a run."
      : `This run's role is ${ctx.role ? `"${ctx.role}"` : "UNSET, so nothing is callable"}.`,
    "",
  ];
  for (const verb of verbs) {
    lines.push(`  ${VERBS[verb]!.syntax}`);
    lines.push(`      ${VERBS[verb]!.when}`);
  }
  lines.push("");
  lines.push("Every command prints what to do next; every refusal prints what you may do instead.");
  lines.push("Add --json to read a field out of a result. Every verb is safe to retry.");
  return lines.join("\n");
}

function verbHelp(verb: string): string {
  const usage = VERBS[verb]!;
  const spec = FLAGS[verb]!;
  return [
    `verb: ${verb}`,
    `syntax: ${usage.syntax}`,
    `when: ${usage.when}`,
    `flags: ${[...spec.value.map((f) => `--${f} <v>`), ...spec.boolean.map((f) => `--${f}`), "--json"].join("  ")}`,
    "",
    "This verb is idempotent: running it twice with the same arguments changes nothing.",
  ].join("\n");
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
