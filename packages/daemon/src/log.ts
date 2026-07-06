/**
 * `loopany log [<loop>] [--limit N] [--transcript] [--json]` — print how a loop's
 * recent runs actually went, so the owner's Claude Code can read prior runs before
 * editing or evolving a loop.
 *
 * The default human render is a CONCISE survey: per run just the header, session id,
 * metrics, error, and one-line message — NOT the full clipped transcript (which is
 * up to 8KB × N runs and buries the useful bits). The session id is the pointer to
 * the full session JSONL for a deep dive. Pass `--transcript` (alias `--full`) to
 * inline the clipped transcript; `--json` always returns the full structured runs.
 *
 * Like `loopany loops`/`edit`, this is an owner-OUTSIDE-a-run command: it goes
 * through the shared CLI client (`postCli`), which reuses the device token + server
 * URL the daemon persisted under ~/.loopany and POSTs `{argv}` to the unified
 * `/api/machine/cli`, falling back to the legacy `/api/machine/log` on a 404 (old
 * server). No run token, no re-auth — the machine is already connected.
 *
 * The loop is resolved like the watcher resolves what to watch: an explicit
 * `<loop>` id wins; otherwise the current working directory is matched against
 * each loop's folder (`resolveLoopDir`), so running it inside a loop's workdir
 * finds that loop — a CLIENT-side resolution, since the server's `log` dispatch
 * needs an explicit loop id. Every external touch is an injectable seam for tests.
 */
import path from "node:path";

import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli } from "./cli-client.js";
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
  /** Claude-reported spend for this run (USD estimate); null for older runs. */
  costUsd?: number | null;
  error: string | null;
  message: string | null;
  // The claude-code session id behind this run — lets the reader jump to its
  // on-disk `<session>.jsonl` for the full, unclipped record (see evolve.md).
  sessionId: string | null;
  // The metrics the run reported (the state object).
  state: Record<string, unknown> | null;
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

/** Boolean flags that never take a value — so `log --json <loop>` keeps `<loop>`
 *  as a positional instead of swallowing it as `--json`'s argument. */
const BOOL_FLAGS = new Set(["json", "transcript", "full"]);

/** `--k v` pairs, bare/boolean `--flag` → true; everything else is positional. */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
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

/** One run rendered for humans: a concise header + session id + metrics + message
 *  by default; the (clipped) transcript is appended only when `showTranscript`. */
function formatRun(r: RunRow, showTranscript: boolean): string {
  const outcome = r.phase === "done" ? (r.outcome ?? "done") : r.phase;
  const dur = r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
  const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : "";
  const head = `● ${r.ts}  ${r.role}  ${outcome}${dur}${cost}`;
  const lines = [head];
  if (r.sessionId) lines.push(`  session: ${r.sessionId}`);
  const metrics: string[] = [];
  if (r.state) for (const [k, v] of Object.entries(r.state)) metrics.push(`${k}=${v}`);
  if (metrics.length) lines.push(`  metrics: ${metrics.join(", ")}`);
  if (r.error) lines.push(`  error: ${r.error}`);
  if (r.message) lines.push(`  ${r.message}`);
  // The transcript is verbose (up to 8KB/run); only inline it on --transcript/--full.
  if (showTranscript && r.transcript) {
    lines.push("");
    lines.push(r.transcript);
    if (r.transcriptTruncated) lines.push("  … (transcript truncated)");
  }
  return lines.join("\n");
}

export async function runLog(argv: string[], injected: LogDeps = {}): Promise<number> {
  const d = seams(injected);
  const flagServer = (() => {
    const i = argv.indexOf("--server-url");
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  // Shared postCli deps: injected server/token override the persisted ones so tests
  // never touch ~/.loopany; production leaves them undefined and postCli resolves.
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchFn,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const { positional, flags } = parseArgs(argv);
  const json = flags["json"] === true || flags["json"] === "true";
  const showTranscript = flags["transcript"] === true || flags["full"] === true;
  const limit = typeof flags["limit"] === "string" ? flags["limit"] : undefined;

  const notConnected = () =>
    d.err("loopany: this machine isn't connected yet — start the daemon once with --server-url … --api-key … (or set LOOPANY_SERVER_URL / LOOPANY_TOKEN)\n");

  // 1. List the machine's loops so we can resolve which one this directory belongs
  //    to (client-side — the server's unified `log` needs an explicit loop id).
  const legacyLoops: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const listed = await postCli(["loops"], legacyLoops, cliDeps);
  if (listed.kind === "not-configured") return notConnected(), 2;
  if (listed.kind === "read-error") return d.err(`loopany: cannot read ${listed.path}\n`), 1;
  if (listed.kind === "network-error") return d.err(`loopany: ${listed.message}\n`), 1;
  const listData = listed.body as { loops?: LoopRow[]; error?: string };
  if (listed.status >= 400 || !listData.loops) {
    d.err(`loopany: ${listData.error || `could not list loops (${listed.status})`}\n`);
    return 1;
  }
  const resolved = resolveLoopId(listData.loops, positional[0], d.cwd());
  if ("error" in resolved) {
    d.err(`loopany: ${resolved.error}\n`);
    return 2;
  }

  // 2. Fetch the resolved loop's recent runs.
  const logArgv = ["log", resolved.id, ...(limit ? ["--limit", limit] : [])];
  const legacyLog: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const qs = new URLSearchParams({ loopId: resolved.id });
    if (limit) qs.set("limit", limit);
    const res = await fetchImpl(`${server}/api/machine/log?${qs.toString()}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const got = await postCli(logArgv, legacyLog, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "read-error") return d.err(`loopany: cannot read ${got.path}\n`), 1;
  if (got.kind === "network-error") return d.err(`loopany: ${got.message}\n`), 1;
  const data = got.body as { ok?: boolean; name?: string; runs?: RunRow[]; error?: string };
  if (got.status >= 400 || !data.ok || !data.runs) {
    d.err(`loopany: ${data.error || `log failed (${got.status})`}\n`);
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
  d.out(`\n${data.runs.map((r) => formatRun(r, showTranscript)).join("\n\n")}\n`);
  return 0;
}
