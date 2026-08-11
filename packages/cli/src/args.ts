/**
 * Flag parsing over node's built-in `node:util` parseArgs (owner directive —
 * no hand-rolled parser). parseArgs runs in STRICT mode with an explicit option
 * table, so an unknown `--flag` is REJECTED loudly (never silently swallowed as
 * a boolean — the silent-data-loss precedent), a value-bearing flag with no
 * value throws a clear error, and a short option (`-p`) is a real alias rather
 * than an unparsed token.
 *
 * The caller (cli.ts) runs `parseArgs` INSIDE its try/catch so a parse failure
 * renders as a usage error (exit 2, honoring --json), never an uncaught throw.
 *
 * On top of parseArgs we keep ONE piece the kernel CLI needs and node does not
 * model: bare `k=v` assignment pairs (the `update <id> status=done` grammar).
 * Those arrive as positionals and are split out here, exactly as before.
 */
import { parseArgs as nodeParseArgs, type ParseArgsConfig } from "node:util";

export interface ParsedArgs {
  positionals: string[];
  /** `--key value` / `--key=value` / `-p value` — string-valued flags. */
  flags: Record<string, string>;
  /** `--key` with no value — boolean flags. */
  bools: Set<string>;
  /** bare `k=v` assignment pairs (not `--`/`-` prefixed) — the update patch grammar. */
  assigns: Array<[string, string]>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The full option table shared by every verb. parseArgs does not know which
 *  verb is running, so the table is the UNION of all verbs' flags; a verb
 *  handler reads the fields it wants and ignores the rest (as before). A flag
 *  absent here is an UNKNOWN flag and strict mode rejects it. */
const OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  // value-bearing flags
  backend: { type: "string" },
  // `init --backend <url> --token <dk_…>` stores the device token for a remote
  // backend (§13 M6). LOOPANY_KERNEL_TOKEN overrides it at run time.
  token: { type: "string" },
  id: { type: "string" },
  parent: { type: "string" },
  tracks: { type: "string" },
  assignee: { type: "string" },
  type: { type: "string" },
  priority: { type: "string", short: "p" },
  cron: { type: "string" },
  timezone: { type: "string" },
  "follow-up": { type: "string" },
  "body-file": { type: "string" },
  file: { type: "string" },
  note: { type: "string" },
  "if-version": { type: "string" },
  status: { type: "string" },
  session: { type: "string" },
  // `doc put --task <id>` atomic attach target (in-run default: LOOPANY_TASK_ID).
  task: { type: "string" },
  owner: { type: "string" },
  workdir: { type: "string" },
  goal: { type: "string" },
  since: { type: "string" },
  limit: { type: "string" },
  actor: { type: "string" },
  kind: { type: "string" },
  // deterministic-clock override (hidden): tests + reproducible ticks pin `now`
  // rather than reading the wall clock (also LOOPANY_NOW). §13 M3 requirement.
  now: { type: "string" },
  wait: { type: "boolean" },
  // boolean flags
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  log: { type: "boolean" },
  due: { type: "boolean" },
  all: { type: "boolean" },
  tree: { type: "boolean" },
  // `tick --spawn` (§13 M4): after firing due triggers, consume the resulting
  // pending runs by launching each assignee's configured agent profile.
  spawn: { type: "boolean" },
  // `init --no-register` skips the daemon-registry auto-registration (the
  // simulator's virtual clock must not be ticked by the resident real-clock
  // daemon). Profiles seeding is unaffected.
  "no-register": { type: "boolean" },
};

/** Parse the post-verb argv. Throws {@link UsageError} on any parse failure —
 *  an unknown flag, a value-bearing flag with no value, or a short option node
 *  cannot bind. The caller catches it inside the error boundary. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let parsed: {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
  try {
    parsed = nodeParseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }) as typeof parsed;
  } catch (e) {
    // node throws a TypeError with a `code` like ERR_PARSE_ARGS_UNKNOWN_OPTION /
    // ERR_PARSE_ARGS_INVALID_OPTION_VALUE — surface its message as a usage error.
    throw new UsageError((e as Error).message);
  }

  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (const [key, value] of Object.entries(parsed.values)) {
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      if (value) bools.add(key);
    } else if (typeof value === "string") {
      flags[key] = value;
    }
  }
  // `-p` binds the `priority` long name; keep the old `p` alias readable too so
  // create.ts (which reads `args.flags.p ?? args.flags.priority`) still works.
  if (flags.priority !== undefined) flags.p = flags.priority;

  const positionals: string[] = [];
  const assigns: Array<[string, string]> = [];
  for (const tok of parsed.positionals) {
    // A bare `k=v` (no leading `-`, `=` past position 0) is an update patch
    // assignment; everything else is a real positional. Same rule as before.
    const eq = tok.indexOf("=");
    if (eq > 0 && !tok.startsWith("-")) assigns.push([tok.slice(0, eq), tok.slice(eq + 1)]);
    else positionals.push(tok);
  }

  return { positionals, flags, bools, assigns };
}
