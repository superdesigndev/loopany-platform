/**
 * Bare `loopany` on a REWRITE (runs-v2) stack — the kernel HOME view.
 *
 * The legacy home (`home.ts`) posts `home` to the unified `/api/machine/cli` and
 * prints whatever the SERVER renders from the LEGACY tables (`loops`/`runs` +
 * machine presence). On a kernel stack those tables hold nothing the user is
 * working with, so the same command rendered an empty machine dashboard beside a
 * live kernel — the entry surface wearing the old product's skin. When
 * `LOOPANY_RUNS_V2=1` this module answers instead, and the legacy path is left
 * byte-identical for every stack that has not flipped the flag.
 *
 * COMPOSED, never a new endpoint: it reads the two kernel surfaces that already
 * exist — `GET /api/views/loops` (the roster, plus the cross-loop `recentRuns`
 * strip the health computation already had in hand) and `GET /api/inbox` (the §6
 * safety floor's counts) — in PARALLEL, and renders them with the rewrite CLI's
 * own TOON grammar (`kernel-render.ts`), so the home reads exactly like every
 * other `loopany …` answer on this stack.
 *
 * A HUMAN surface, so the device credential is deliberately NOT attached (the
 * same rule `kernel-cli.ts` HUMAN_COMMANDS encodes: with no run context a device
 * token names the machine, and `apiAuth` answers a human-only endpoint
 * `UNAUTHORIZED` for it). A `LOOPANY_SESSION` cookie rides along when set,
 * exactly as it does for `loopany inbox`.
 *
 * NEVER EMPTY, NEVER ALARMING (P5/P8): this runs on the SessionStart hot path, so
 * every failure — no server configured, an unreachable/hung one, a refusal —
 * degrades to a DEFINITIVE home that names the state and the fix, and exits 0.
 */
import { resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { binLine } from "./home.js";
import { ABSENT, cell, helpBlock, nextFireCell, typedList } from "./kernel-render.js";
import { resolveDurableBinPath } from "./bin-shim.js";

/** The SessionStart hot-path budget, shared with the legacy home: fail fast to a
 *  degraded view rather than stall a session on a hung server. */
const HOME_TIMEOUT_MS = 4_000;
/** How much of the roster and the activity strip a home prints before it stops
 *  being a glance. Both surfaces say how many were withheld — a home that
 *  silently clipped would read as "that is all there is". */
const LOOPS_CAP = 12;
const RUNS_CAP = 5;

const DESCRIPTION =
  "Loopany rewrite (kernel): event-sourced loops, tasks and docs. This CLI targets your LOCAL dev stack.";

export interface KernelHomeDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  server?: string;
  binPath?: () => string | null;
  out?: (text: string) => void;
}

interface Fetched {
  status: number;
  body: Record<string, unknown>;
}

export async function runKernelHome(deps: KernelHomeDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const env = deps.env ?? process.env;
  const bin = (deps.binPath ?? (() => resolveDurableBinPath()))();
  const server = (deps.server ?? resolveServerUrl(undefined)).replace(/\/$/, "");

  if (!server) return out(notConnectedHome(bin)), 0;

  const doFetch = deps.fetchImpl ?? ((url: string, init?: RequestInit) => boundedFetch(String(url), init ?? {}, HOME_TIMEOUT_MS));
  const headers: Record<string, string> = {};
  // A human surface: the session cookie is the only credential that belongs here.
  if (env.LOOPANY_SESSION) headers.Cookie = env.LOOPANY_SESSION.includes("=") ? env.LOOPANY_SESSION : `better-auth.session_token=${env.LOOPANY_SESSION}`;

  const read = async (path: string): Promise<Fetched | { error: string }> => {
    try {
      const response = await (doFetch as typeof fetch)(server + path, { headers });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  // Two reads, one wait: the roster is the home, the inbox count is the floor.
  const [loopsRead, inboxRead] = await Promise.all([read("/api/views/loops"), read("/api/inbox")]);

  if ("error" in loopsRead) return out(degradedHome(bin, server, loopsRead.error)), 0;
  if (loopsRead.status < 200 || loopsRead.status >= 300) return out(refusedHome(bin, server, loopsRead)), 0;

  out(renderKernelHome({ bin, server, loops: loopsRead.body, inbox: inboxRead }));
  return 0;
}

// ------------------------------------------------------------------- the render

type Row = Record<string, unknown>;

const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** The three header lines every kernel home leads with, degraded or not: what
 *  binary this is, what it does, and WHICH stack it is pointed at. The stack line
 *  is load-bearing — `loopany-dev` exists so a dev stack is never confused for
 *  production, and the home is where that is stated. */
function header(bin: string | null, stack: string): string {
  return `${binLine(bin)}\ndescription: ${DESCRIPTION}\nstack: ${stack}\n`;
}

export function renderKernelHome(input: { bin: string | null; server: string; loops: Row; inbox: Fetched | { error: string } }): string {
  const loops = asRows(input.loops.loops);
  const runs = asRows(input.loops.recentRuns);
  const shownLoops = loops.slice(0, LOOPS_CAP);
  const shownRuns = runs.slice(0, RUNS_CAP);

  let text = header(input.bin, `runs-v2 · ${input.server}`);
  text += typedList("loops", ["id", "title", "status", "next_fire"], shownLoops.map((loop) => [loop.id, loop.title, loop.status, nextFireCell(loop)]));
  text += `inbox: ${inboxLine(input.inbox)}\n`;
  text += typedList("runs", ["at", "loop", "state", "summary"], shownRuns.map((run) => [run.finishedAt ?? run.startedAt, run.loopId, run.state, run.summary]));
  return text + helpBlock(homeHints(loops, shownLoops.length, runs.length, shownRuns.length));
}

/** The §6 safety floor as one line. A failed inbox read is SAID, never rendered
 *  as a zero — "nothing is waiting on you" is exactly the wrong thing to invent. */
function inboxLine(inbox: Fetched | { error: string }): string {
  if ("error" in inbox) return `${ABSENT} (unavailable: ${inbox.error})`;
  if (inbox.status < 200 || inbox.status >= 300) {
    const message = typeof inbox.body.message === "string" ? inbox.body.message : `the kernel refused this read (${inbox.status})`;
    return `${ABSENT} (unavailable: ${message})`;
  }
  const counts = (inbox.body.counts ?? {}) as Record<string, unknown>;
  const total = Number(counts.total ?? 0);
  if (!total) return "0 waiting — nothing needs you";
  return `${total} waiting — questions ${Number(counts.question ?? 0)}, due+unwatched ${Number(counts.dueUnwatched ?? 0)}, orphans ${Number(counts.orphan ?? 0)}`;
}

function homeHints(loops: Row[], shownLoops: number, runCount: number, shownRuns: number): string[] {
  if (!loops.length) {
    return [
      "No loops on this stack yet — run `loopany loop create --file <path>`; the file IS the loop, and its body is the charter",
      "A loop artifact needs `title:` and an ABSOLUTE `workdir:` that exists here; omit `cron:` for an on-demand loop",
      "Run `loopany --help` for every command, `loopany loop create --help` for this one's grammar",
    ];
  }
  const hints: string[] = [];
  if (loops.length > shownLoops) hints.push(`Showing ${shownLoops} of ${loops.length} loops — run \`loopany loop list\` for the whole roster`);
  if (runCount > shownRuns) hints.push(`Showing the ${shownRuns} newest of ${runCount} recent runs — run \`loopany loop show <loop-id>\` for one loop's history`);
  hints.push("Run `loopany loop show <loop-id>` to read a charter, `loopany loop list --status active` for the live roster");
  hints.push('Run `loopany inbox` to see what is waiting on you, `loopany answer <task-id> "…"` to reply');
  hints.push("Run `loopany --help` for every command, `loopany <verb> --help` for one verb's grammar");
  return hints;
}

// -------------------------------------------------------------- degraded homes

/** No server on this machine: the definitive local state, no round trip possible. */
function notConnectedHome(bin: string | null): string {
  return (
    header(bin, "runs-v2 · not connected") +
    "loops: []\n" +
    `inbox: ${ABSENT} (no server)\n` +
    helpBlock([
      "Set LOOPANY_SERVER_URL to your dev stack (e.g. http://127.0.0.1:3137), or connect this machine with `loopany up --server-url <url> --api-key <dk_…>`",
      "Run `loopany --help` to see every command",
    ])
  );
}

/** The stack is configured but unreachable or hung (incl. the bounded-fetch
 *  timeout on the SessionStart hot path). Never hangs, never empty, exit 0. */
function degradedHome(bin: string | null, server: string, reason: string): string {
  return (
    header(bin, `runs-v2 · ${server} — unreachable right now (${reason})`) +
    `loops: ${ABSENT} (the stack did not answer)\n` +
    helpBlock([
      "Start the dev server for this stack, then run `loopany` again",
      "Run `loopany loop list` once it is reachable to read the roster",
    ])
  );
}

/** The stack answered, and REFUSED. The kernel's own sentence is printed verbatim
 *  (it carries the teaching); the home shape is kept so the output is still a home. */
function refusedHome(bin: string | null, server: string, read: Fetched): string {
  const message = typeof read.body.message === "string" ? read.body.message : `the kernel refused this read (${read.status})`;
  const hint = typeof read.body.hint === "string" && read.body.hint ? read.body.hint : undefined;
  return (
    header(bin, `runs-v2 · ${server}`) +
    `loops: ${ABSENT} (the kernel refused this read)\n` +
    `error: ${cell(message)}\n` +
    `code: ${typeof read.body.code === "string" ? read.body.code : "ERROR"}\n` +
    helpBlock([
      ...(hint ? [hint] : []),
      "The home reads the human surfaces, so it needs a signed-in session — set LOOPANY_SESSION=<session cookie> for the CLI, or sign in on this machine",
      "Run `loopany --help` to see every command",
    ])
  );
}
