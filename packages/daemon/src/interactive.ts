/**
 * Interactive mode — `loopany loops` / `loopany edit <id> [...flags]`, run by the
 * owner (or their Claude Code) OUTSIDE a run. Goes through the shared CLI client
 * (`postCli`), which reuses the device token + server URL the daemon persisted under
 * ~/.loopany and POSTs `{argv}` to the unified `/api/machine/cli`, falling back to the
 * legacy `/api/machine/loop` channel on a 404 (old server). No run token, no re-auth,
 * no claim — the machine is already connected, so editing an existing loop needs none.
 */
import { readFileSync } from "node:fs";

import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printTextOrTooOld } from "./cli-client.js";

type Flags = Record<string, string | boolean>;

/** Injectable seams so tests exercise the fetch path without a real ~/.loopany or
 *  network (mirrors LogDeps). Absent ⇒ postCli resolves the real token/server. */
export interface InteractiveDeps {
  fetchImpl?: typeof fetch;
  server?: string;
  token?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** `--k v` / `--k=v` pairs, bare `--flag` → true; everything else is positional. */
export function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        // `--fields=timezone,notify` — the value rides on the same token.
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Read a flag's file path into raw string content (for `--workflow-file` etc). */
function readFileFlag(flags: Flags, flag: string): string | undefined {
  const path = flags[flag];
  if (typeof path !== "string") return undefined;
  return readFileSync(path, "utf8");
}

/** The ONLY flags `loopany edit` accepts (batch 2 slim-down to JSON-only + the
 *  content trio). The scalar envelope flags (--cron/--tz/--name/--notify/--model/
 *  --pause/--resume/--run-at/--task-file) and --json-file are GONE: reshape a loop
 *  with a single `--json '<obj>'` patch, and push development-artifact content
 *  (workflow JS / UI HTML / schema JSON) via the file flags. `dry-run` is a mode,
 *  `server-url`/`api-key` are global daemon flags — allowed here, not patch keys. */
const EDIT_FLAGS = new Set(["json", "workflow-file", "ui-file", "schema-file", "dry-run", "server-url", "api-key"]);

/** The flags `loopany loops` accepts: `--fields <set>`, the `--json` escape hatch,
 *  `--help`, plus the global daemon flags (consumed separately). An unknown flag is a
 *  usage error (exit 2) — the server validates unknown `--fields` VALUES separately. */
const LOOPS_FLAGS = new Set(["fields", "json", "help", "server-url", "api-key"]);

/**
 * Assemble the `loopany edit` patch body from the surviving flags. `--json '<obj>'`
 * carries the envelope + goal/enabled/allowControl etc; the `--*-file` flags read a
 * development-artifact file's raw content into workflow/ui/stateSchema (schema parsed
 * as JSON). Explicit `--json` keys win over the file flags. The server is the sole
 * validator — the daemon only shapes the body. Throws on an UNKNOWN flag (a removed
 * scalar like --cron fails loudly, not silently) or unreadable/invalid file/JSON.
 */
export function buildPatch(flags: Flags): Record<string, unknown> {
  const unknown = Object.keys(flags).filter((k) => !EDIT_FLAGS.has(k));
  if (unknown.length) {
    throw new Error(`unknown flag --${unknown[0]} — try \`loopany --help\` (edit takes --json '<obj>', --workflow-file, --ui-file, --schema-file)`);
  }

  const patch: Record<string, unknown> = {};

  // Convenience file flags — multi-line workflow/ui/schema content is awkward to
  // embed in JSON on a CLI, so read the file's raw content into the patch field
  // (schema parsed as JSON, mirroring the run-token `set-schema --file` shape).
  const workflowFile = readFileFlag(flags, "workflow-file");
  if (workflowFile !== undefined) patch.workflow = workflowFile;
  const uiFile = readFileFlag(flags, "ui-file");
  if (uiFile !== undefined) patch.ui = uiFile;
  const schemaFile = readFileFlag(flags, "schema-file");
  if (schemaFile !== undefined) patch.stateSchema = JSON.parse(schemaFile);

  // Explicit --json object wins over the file flags above.
  if (typeof flags["json"] === "string") {
    const parsed = JSON.parse(flags["json"]);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--json must be a JSON object of loop fields");
    }
    Object.assign(patch, parsed);
  }
  return patch;
}

const USAGE =
  "loopany: usage: loopany edit <loop-id> [options]\n" +
  "  --json '<json-object>'      the whole patch — e.g. '{\"cron\":\"0 9 * * *\",\"goal\":\"ship v1\"}'\n" +
  "                              (envelope: name/cron/timezone/notify/model/allowControl/taskFile/\n" +
  "                               enabled/runAt/goal · {\"goal\":null} clears it, {\"enabled\":true}\n" +
  "                               reopens a completed loop)\n" +
  "  --workflow-file <path>      set the deterministic pre-stage JS from a file\n" +
  "  --ui-file <path>            set the dashboard HTML from a file\n" +
  "  --schema-file <path.json>   set the metric schema (JSON array) from a file\n" +
  "  --dry-run                   validate + preview before/after, change nothing\n" +
  "  the server validates every field; unknown keys are rejected.\n";

export async function runInteractive(argv: string[], injected: InteractiveDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const err = injected.err ?? ((s: string) => void process.stderr.write(s));
  const flagServer = (() => {
    const i = process.argv.indexOf("--server-url");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  // Shared postCli deps: the injected server/token override the persisted ones so
  // tests need no real ~/.loopany; production leaves them undefined and postCli
  // resolves the device token + server url itself (same values as before).
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const verb = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  const notConnected = () =>
    err("loopany: this machine isn't connected yet — start the daemon once with --server-url … --api-key … (or set LOOPANY_SERVER_URL / LOOPANY_TOKEN)\n");

  if (verb === "loops") {
    // Forward the user's flags so the server can honor `--fields`/`--json` and reject
    // unknown fields — the old bug HARDCODED `["loops"]`, silently dropping every flag
    // (help promised `--fields` that never shipped; `--json` returned TOON). An unknown
    // FLAG is a usage error (exit 2), mirroring how an unknown VERB exits 2 client-side.
    const unknown = Object.keys(flags).filter((k) => !LOOPS_FLAGS.has(k));
    if (unknown.length) return err(`loopany: unknown flag --${unknown[0]} — try \`loopany loops --help\`\n`), 2;
    const cliArgv = ["loops"];
    if (typeof flags["fields"] === "string") cliArgv.push("--fields", flags["fields"]);
    if (flags["json"] === true || flags["json"] === "true") cliArgv.push("--json");
    if (flags["help"] === true) cliArgv.push("--help");
    // Legacy fallback (old server, no /api/machine/cli): GET /api/machine/loop.
    const legacy: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
      const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const r = await postCli(cliArgv, legacy, cliDeps);
    if (r.kind === "not-configured") return notConnected(), 2;
    if (r.kind === "read-error") return err(`loopany: cannot read ${r.path}\n`), 1;
    if (r.kind === "network-error") return err(`loopany: ${r.message}\n`), 1;
    // Text-sink: the server renders the TOON list, the JSON escape hatch (`--json`), and
    // the empty/error states; we just print `text`. A too-old server (no `text`) → a
    // definitive SERVER_TOO_OLD error, never blank output.
    return printTextOrTooOld(r.body, r.status, out);
  }

  if (verb === "edit") {
    const id = positional[0];
    if (!id) return err(USAGE), 2;
    const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
    let patch: Record<string, unknown>;
    try {
      patch = buildPatch(flags);
    } catch (e) {
      // A removed/unknown flag or an unreadable file/JSON — fail loudly with guidance.
      return err(`loopany: ${e instanceof Error ? e.message : String(e)}\n`), 2;
    }
    // Bare `loopany edit <id>` with no edit inputs is a usage error. But `--json '{}'`
    // (or any explicit input flag that resolves to an empty patch) is a VALID no-op:
    // forward it so the server reports "nothing to change" + the allowed-key list (F8),
    // instead of short-circuiting to the usage screen client-side.
    const gaveInput = flags["json"] !== undefined || flags["workflow-file"] !== undefined || flags["ui-file"] !== undefined || flags["schema-file"] !== undefined;
    if (!gaveInput) return err(USAGE), 2;
    // The whole edit travels as one unified verb: `edit <id> --json <patch> [--dry-run]`.
    const cliArgv = ["edit", id, "--json", JSON.stringify(patch), ...(dryRun ? ["--dry-run"] : [])];
    // Legacy fallback: PATCH /api/machine/loop with the {id, patch, dryRun} body the
    // old server expects (the unified deviceCli parses the same patch out of --json).
    const legacy: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
      const res = await fetchImpl(`${server}/api/machine/loop`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id, patch, dryRun }),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const r = await postCli(cliArgv, legacy, cliDeps);
    if (r.kind === "not-configured") return notConnected(), 2;
    if (r.kind === "read-error") return err(`loopany: cannot read ${r.path}\n`), 1;
    if (r.kind === "network-error") return err(`loopany: ${r.message}\n`), 1;
    // Text-sink: the server renders the apply / dry-run / rejection / error TOON (and
    // pins exit 1 for rejections via `exitCode`); we just print it. A too-old server
    // (no `text`) → a definitive SERVER_TOO_OLD error.
    return printTextOrTooOld(r.body, r.status, out);
  }

  err(`loopany: unknown command "${verb ?? ""}" (try: loops, edit)\n`);
  return 2;
}
