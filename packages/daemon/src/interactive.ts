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

/** CLI flag → server patch key (the server is the sole validator). */
const PATCH_FIELDS: Record<string, string> = {
  cron: "cron",
  name: "name",
  tz: "timezone",
  timezone: "timezone",
  notify: "notify",
  model: "model",
  "run-at": "runAt",
  "task-file": "taskFile",
};

/** Read a flag's file path into raw string content (for `--workflow-file` etc). */
function readFileFlag(flags: Flags, flag: string): string | undefined {
  const path = flags[flag];
  if (typeof path !== "string") return undefined;
  return readFileSync(path, "utf8");
}

/**
 * Assemble the patch body. Precedence, lowest → highest: envelope flags, then
 * the convenience `--*-file` content flags, then an explicit `--json` /
 * `--json-file` object (its keys win). The server is the sole validator — the
 * daemon only shapes the body. Throws on unreadable/invalid file or JSON.
 */
export function buildPatch(flags: Flags): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [flag, key] of Object.entries(PATCH_FIELDS)) {
    if (typeof flags[flag] === "string") patch[key] = flags[flag];
  }
  if (flags["pause"]) patch.enabled = false;
  if (flags["resume"]) patch.enabled = true;
  if (flags["allow-control"] !== undefined) patch.allowControl = flags["allow-control"] === true || flags["allow-control"] === "true";

  // Convenience file flags — multi-line workflow/ui/schema content is awkward to
  // embed in JSON on a CLI, so read the file's raw content into the patch field
  // (schema parsed as JSON, mirroring the run-token `set-schema --file` shape).
  const workflowFile = readFileFlag(flags, "workflow-file");
  if (workflowFile !== undefined) patch.workflow = workflowFile;
  const uiFile = readFileFlag(flags, "ui-file");
  if (uiFile !== undefined) patch.ui = uiFile;
  const schemaFile = readFileFlag(flags, "schema-file");
  if (schemaFile !== undefined) patch.stateSchema = JSON.parse(schemaFile);

  // Explicit --json / --json-file object wins over everything above.
  let jsonRaw: string | undefined;
  if (typeof flags["json"] === "string") jsonRaw = flags["json"];
  else if (typeof flags["json-file"] === "string") jsonRaw = readFileSync(flags["json-file"], "utf8");
  if (jsonRaw !== undefined) {
    const parsed = JSON.parse(jsonRaw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--json must be a JSON object of loop fields");
    }
    Object.assign(patch, parsed);
  }
  return patch;
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
  "  envelope:  --cron \"…\"  --name …  --tz …  --notify always|auto|never  --model …\n" +
  "             --pause | --resume  --allow-control true|false  --run-at 2h  --task-file <path>\n" +
  "  content:   --workflow-file <path>  --ui-file <path>  --schema-file <path.json>\n" +
  "  partial:   --json '<json-object>' | --json-file <path>   (explicit JSON keys win)\n" +
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
      const patch = buildPatch(flags);
      if (Object.keys(patch).length === 0) {
        process.stderr.write(USAGE);
        return 2;
      }
      const res = await fetch(base, { method: "PATCH", headers, body: JSON.stringify({ id, patch }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; applied?: string[]; name?: string; error?: string };
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
