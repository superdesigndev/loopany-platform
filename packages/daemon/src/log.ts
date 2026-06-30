/**
 * `loopany log [<loop>] [--limit N] [--json]` — print how a loop's recent runs
 * actually went (status + execution transcript), so the owner's Claude Code can
 * read prior runs before editing or evolving a loop.
 *
 * Like `loopany loops`/`edit`, this is an owner-OUTSIDE-a-run command: it reuses
 * the device token + server URL the daemon persisted under ~/.loopany and hits the
 * device-token-scoped read endpoint (`GET /api/machine/log`). No run token, no
 * re-auth — the machine is already connected.
 *
 * The loop is resolved like the watcher resolves what to watch: an explicit
 * `<loop>` id wins; otherwise the current working directory is matched against
 * each loop's folder (`resolveLoopDir`), so running it inside a loop's workdir
 * finds that loop. Every external touch is an injectable seam for tests.
 */
import path from "node:path";

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";
import { resolveLoopDir } from "./loopdir.js";

interface LoopRow {
  id: string;
  name: string;
  workdir: string | null;
  taskFile: string | null;
}

interface RunRow {
  id: string;
  ts: string;
  role: string;
  phase: string;
  outcome: string | null;
  status: string | null;
  durationMs: number | null;
  error: string | null;
  message: string | null;
  transcript: string;
  transcriptTruncated: boolean;
}

export type LogDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  // Local config — overridable so tests are isolated from the ambient ~/.loopany.
  server?: string;
  token?: string;
};

type Seams = {
  cwd: () => string;
  fetchFn: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
};

function seams(d: LogDeps): Seams {
  return {
    cwd: d.cwd ?? (() => process.cwd()),
    fetchFn: d.fetchFn ?? fetch,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
  };
}

/** `--k v` pairs, bare `--flag` → true; everything else is positional. */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
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

/** Resolve the loop to read: an explicit id (matched by id, else name) wins;
 *  otherwise pick the loop whose folder contains the current directory (the most
 *  specific match if several nest). Returns the id, or an error explaining why. */
function resolveLoopId(
  loops: LoopRow[],
  explicit: string | undefined,
  cwd: string,
): { id: string } | { error: string } {
  if (explicit) {
    const byId = loops.find((l) => l.id === explicit);
    if (byId) return { id: byId.id };
    const byName = loops.filter((l) => l.name === explicit);
    if (byName.length === 1) return { id: byName[0]!.id };
    if (byName.length > 1) return { error: `"${explicit}" matches multiple loops — pass the loop id instead` };
    return { error: `no loop "${explicit}" on this machine — run \`loopany loops\` to list them` };
  }
  if (loops.length === 0) return { error: "no loops on this machine yet" };
  const here = path.resolve(cwd);
  const matches = loops
    .map((l) => ({ l, dir: resolveLoopDir({ loopId: l.id, workdir: l.workdir, taskFile: l.taskFile }) }))
    .filter(({ dir }) => here === dir || here.startsWith(dir + path.sep))
    // Most specific folder wins when loops nest.
    .sort((a, b) => b.dir.length - a.dir.length);
  if (matches.length === 0) {
    return { error: "no loop folder matches this directory — pass a loop id, e.g. `loopany log <loop-id>` (`loopany loops` lists them)" };
  }
  return { id: matches[0]!.l.id };
}

/** One run rendered for humans: a header line then its (clipped) transcript. */
function formatRun(r: RunRow): string {
  const outcome = r.phase === "done" ? (r.outcome ?? "done") : r.phase;
  const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
  const head = `● ${r.ts}  ${r.role}  ${outcome}${dur}`;
  const lines = [head];
  if (r.error) lines.push(`  error: ${r.error}`);
  if (r.message) lines.push(`  ${r.message}`);
  if (r.transcript) {
    lines.push("");
    lines.push(r.transcript);
    if (r.transcriptTruncated) lines.push("  … (transcript truncated)");
  }
  return lines.join("\n");
}

export async function runLog(argv: string[], injected: LogDeps = {}): Promise<number> {
  const d = seams(injected);
  const token = "token" in injected ? injected.token : readStored(DEVICE_FILE);
  const flagServer = (() => {
    const i = argv.indexOf("--server-url");
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  const server = "server" in injected ? (injected.server ?? "") : resolveServerUrl(flagServer);
  if (!token || !server) {
    d.err(
      "loopany: this machine isn't connected yet — start the daemon once with --server-url … --api-key … (or set LOOPANY_SERVER_URL / LOOPANY_TOKEN)\n",
    );
    return 2;
  }

  const { positional, flags } = parseArgs(argv);
  const json = flags["json"] === true || flags["json"] === "true";
  const limit = typeof flags["limit"] === "string" ? flags["limit"] : undefined;
  const headers = { Authorization: `Bearer ${token}` };

  try {
    // List the machine's loops to resolve which one this directory belongs to.
    const listRes = await d.fetchFn(`${server}/api/machine/loop`, { method: "GET", headers });
    const listData = (await listRes.json().catch(() => ({}))) as { loops?: LoopRow[]; error?: string };
    if (!listRes.ok || !listData.loops) {
      d.err(`loopany: ${listData.error || `could not list loops (${listRes.status})`}\n`);
      return 1;
    }
    const resolved = resolveLoopId(listData.loops, positional[0], d.cwd());
    if ("error" in resolved) {
      d.err(`loopany: ${resolved.error}\n`);
      return 2;
    }

    const qs = new URLSearchParams({ loopId: resolved.id });
    if (limit) qs.set("limit", limit);
    const res = await d.fetchFn(`${server}/api/machine/log?${qs.toString()}`, { method: "GET", headers });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      name?: string;
      runs?: RunRow[];
      error?: string;
    };
    if (!res.ok || !data.ok || !data.runs) {
      d.err(`loopany: ${data.error || `log failed (${res.status})`}\n`);
      return 1;
    }

    if (json) {
      d.out(`${JSON.stringify(data.runs, null, 2)}\n`);
      return 0;
    }
    d.out(`${data.name ?? resolved.id} — ${data.runs.length} recent run${data.runs.length === 1 ? "" : "s"}\n`);
    if (data.runs.length === 0) {
      d.out("no runs yet\n");
      return 0;
    }
    d.out(`\n${data.runs.map(formatRun).join("\n\n")}\n`);
    return 0;
  } catch (err) {
    d.err(`loopany: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
