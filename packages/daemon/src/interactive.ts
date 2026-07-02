/**
 * Interactive mode — `loopany loops` / `loopany edit <id> [...flags]`, run by the
 * owner (or their Claude Code) OUTSIDE a run. Reuses the device token + server URL
 * the daemon persisted under ~/.loopany and talks to the machine's authenticated
 * loop channel (/api/machine/loop). No run token, no re-auth, no claim — the
 * machine is already connected, so editing an existing loop needs none of that.
 */
import { readFileSync } from "node:fs";
import { DEVICE_FILE, SERVER_FILE, readStored } from "./config.js";

type Flags = Record<string, string | boolean>;

type LoopRow = {
  id: string;
  name: string;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  notify: string;
  nextRunAt: string | null;
};

/** `--k v` pairs, bare `--flag` → true; everything else is positional. */
export function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
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

/** The PATCH /api/machine/loop response (real edit or `--dry-run` preview). */
interface EditResponse {
  ok?: boolean;
  dryRun?: boolean;
  applied?: string[];
  name?: string;
  error?: string;
  changes?: Array<{ key: string; from: unknown; to: unknown }>;
  rejections?: Array<{ key: string; reason: string }>;
}

/** Render a value for the before→after preview (null/undefined → em-dash). */
function fmtPreview(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Print the `--dry-run` edit preview (per-key before→after + rejections). Exit 0
 *  when valid, 1 when the server flagged rejections (a removed field / bad value). */
function printEditDryRun(data: EditResponse): number {
  const out = (s: string) => void process.stdout.write(s);
  out(`dry-run · ${data.name ?? "loop"} — nothing changed\n`);
  const changes = data.changes ?? [];
  if (changes.length) {
    out("changes:\n");
    for (const c of changes) out(`  ${c.key}: ${fmtPreview(c.from)} -> ${fmtPreview(c.to)}\n`);
  } else {
    out("changes: (none)\n");
  }
  const rejections = data.rejections ?? [];
  if (rejections.length) {
    out("rejected:\n");
    for (const r of rejections) out(`  ${r.key}: ${r.reason}\n`);
  }
  return data.ok === false || rejections.length > 0 ? 1 : 0;
}

function printLoops(loops: LoopRow[]): void {
  if (loops.length === 0) {
    process.stdout.write("no loops on this machine yet\n");
    return;
  }
  for (const l of loops) {
    const state = l.enabled ? "on" : "paused";
    const tz = l.timezone ? ` ${l.timezone}` : "";
    process.stdout.write(`${l.id}  ${state.padEnd(6)}  ${l.cron}${tz}  ${l.name}\n`);
  }
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

export async function runInteractive(argv: string[]): Promise<number> {
  const token = readStored(DEVICE_FILE);
  const flagServer = (() => {
    const i = process.argv.indexOf("--server-url");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();
  const server = (flagServer || process.env.LOOPANY_SERVER_URL || readStored(SERVER_FILE) || "").replace(/\/$/, "");
  if (!token || !server) {
    process.stderr.write(
      "loopany: this machine isn't connected yet — start the daemon once with --server-url … --api-key … (or set LOOPANY_SERVER_URL / LOOPANY_TOKEN)\n",
    );
    return 2;
  }

  const verb = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `${server}/api/machine/loop`;

  try {
    if (verb === "loops") {
      const res = await fetch(base, { method: "GET", headers });
      const data = (await res.json().catch(() => ({}))) as { loops?: LoopRow[]; error?: string };
      if (!res.ok || !data.loops) {
        process.stderr.write(`loopany: ${data.error || `list failed (${res.status})`}\n`);
        return 1;
      }
      printLoops(data.loops);
      return 0;
    }

    if (verb === "edit") {
      const id = positional[0];
      if (!id) {
        process.stderr.write(USAGE);
        return 2;
      }
      const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
      let patch: Record<string, unknown>;
      try {
        patch = buildPatch(flags);
      } catch (err) {
        // A removed/unknown flag or an unreadable file/JSON — fail loudly with guidance.
        process.stderr.write(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      if (Object.keys(patch).length === 0) {
        process.stderr.write(USAGE);
        return 2;
      }
      const res = await fetch(base, { method: "PATCH", headers, body: JSON.stringify({ id, patch, dryRun }) });
      const data = (await res.json().catch(() => ({}))) as EditResponse;
      if (dryRun && data.dryRun) return printEditDryRun(data);
      if (!res.ok || !data.ok) {
        process.stderr.write(`loopany: ${data.error || `edit failed (${res.status})`}\n`);
        return 1;
      }
      process.stdout.write(`updated ${data.name ?? id} — ${(data.applied ?? []).join(", ")}\n`);
      return 0;
    }

    process.stderr.write(`loopany: unknown command "${verb ?? ""}" (try: loops, edit)\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
