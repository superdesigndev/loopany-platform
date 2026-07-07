/**
 * Bare `loopany` OUT of a run — the content-first HOME view (P8/§5.1). The daemon is
 * a text sink: it collects the local facts only IT knows (cwd + home dir for the
 * directory scoping, the PATH shim path, the daemon pid, the server URL) and posts
 * them as `home` context flags to the unified `/api/machine/cli`; the SERVER owns the
 * whole TOON render (`renderHomeText`). The daemon just prints `body.text`.
 *
 * Never empty (P5/P8): when this machine has no stored credential/server the post
 * short-circuits to a DEFINITIVE local "not connected — run `loopany up`" view; on a
 * too-old server (no `home` verb → no rendered `text`) a DEFINITIVE "server too old"
 * home is rendered (no structured-render fallback anymore). The in-run bare `loopany`
 * is handled separately (cli.ts routes it to the callback as `home` on the run cred).
 *
 * Bounded on the hot path (feedback follow-up): batch 6 runs this home view on EVERY
 * SessionStart via the installed hook, so the network round-trip must degrade fast. The
 * home POST goes through `boundedFetch` (a few-second timeout + AbortSignal), so an
 * unreachable-but-not-refused server (a hung TCP connection) fails fast to a DEFINITIVE
 * degraded home (`server unreachable`) instead of stalling session start until the OS
 * timeout. Interactive verbs keep their own fetch budgets.
 *
 * Every external touch (fetch, cwd, homedir, pid, server, output) is an injectable
 * seam so tests need no real process/network/~.loopany.
 */
import os from "node:os";

import { resolveDurableBinPath } from "./bin-shim.js";
import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printText } from "./cli-client.js";
import { resolveServerUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import { verifiedRunningPid } from "./pidfile.js";

/** The SessionStart hot path budget: fail fast to a degraded home rather than stall a
 *  session on a hung server. */
const HOME_TIMEOUT_MS = 4_000;

/** `fetch` bounded to `HOME_TIMEOUT_MS` — the default home transport (tests inject
 *  their own `fetchImpl`). */
const boundedHomeFetch = ((url: string, init?: RequestInit) =>
  boundedFetch(String(url), init ?? {}, HOME_TIMEOUT_MS)) as unknown as typeof fetch;

export interface HomeDeps {
  fetchImpl?: typeof fetch;
  server?: string;
  token?: string;
  cwd?: () => string;
  homedir?: () => string;
  localPid?: () => number | undefined;
  binPath?: () => string | null;
  serverDisplay?: () => string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export async function runHome(injected: HomeDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const cwd = (injected.cwd ?? (() => process.cwd()))();
  const homedir = (injected.homedir ?? os.homedir)();
  const pid = (injected.localPid ?? (() => verifiedRunningPid()))();
  // The durable `loopany` path (our shim OR a real global on PATH) for the home's
  // `bin:` line (P8). Null ⇒ npx-without-global; the SERVER then renders the honest
  // "not on PATH — npm i -g" fallback so the line ALWAYS leads the home (F7).
  const bin = (injected.binPath ?? (() => resolveDurableBinPath()))();
  const serverDisplay = (injected.serverDisplay ?? (() => resolveServerUrl(undefined)))();

  // Context the SERVER can't know — the render is still entirely server-side, we just
  // feed it the local facts. Omit an absent fact rather than send an empty flag.
  const ctx: string[] = ["--cwd", cwd, "--home", homedir];
  if (bin) ctx.push("--bin", bin);
  if (pid !== undefined) ctx.push("--pid", String(pid));
  if (serverDisplay) ctx.push("--server", serverDisplay);

  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchImpl ?? boundedHomeFetch,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  // postCli 404-fallback (a server without /api/machine/cli): the legacy loops list. On
  // a batch-1+ server its GET carries `text` (printed as a degraded home); a truly
  // ancient server yields no `text` → the definitive `tooOldHome` below. Retained here
  // (its own upgrade-window gate) even though the render fallback is gone.
  const legacy: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const r = await postCli(["home", ...ctx], legacy, cliDeps);
  // Not connected: no credential/server on this machine yet — render the DEFINITIVE
  // local state (never empty output), telling the owner exactly how to connect.
  if (r.kind === "not-configured") {
    out(notConnectedHome(bin));
    return 0;
  }
  if (r.kind === "read-error") return out(`error: "cannot read ${r.path}"\ncode: ERROR\n`), 1;
  // Unreachable / hung server (incl. a bounded-fetch timeout on the SessionStart hot
  // path): render a DEFINITIVE degraded home — never hang, never empty, never a raw
  // error line that would surface the ambient hook as a failure.
  if (r.kind === "network-error") {
    out(degradedHome(bin, serverDisplay, r.message));
    return 0;
  }

  // Text-sink primary: print the server's rendered TOON home.
  const code = printText(r.body, r.status, out);
  if (code !== null) return code;

  // A too-old server (no `text` — predates the axi home verb). The home must stay
  // never-empty/never-alarm on the SessionStart hot path, so render a DEFINITIVE
  // "server too old" home (exit 0) rather than the SERVER_TOO_OLD error other verbs
  // print — no structured-render fallback anymore.
  out(tooOldHome(bin, serverDisplay));
  return 0;
}

/** The `bin:` line that leads EVERY home view (P8): the real durable path when known,
 *  else the honest "not on PATH" fallback with the fix. Mirrors the server's
 *  `renderHomeText` so the local and server-rendered homes agree. */
export function binLine(bin: string | null): string {
  return bin ? `bin: ${bin}` : "bin: (not on PATH — run `npm i -g @crewlet/loopany`)";
}

/** The definitive not-connected home rendered locally (no server round-trip possible
 *  — there is no credential/server). Mirrors the server's not-connected shape. */
function notConnectedHome(bin: string | null): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    "machine: not connected — run `loopany up`\n" +
    "help[2]:\n" +
    "  Run `loopany up --server-url <url> --connect-key <dk_…>` to connect this machine\n" +
    "  Run `loopany --help` to see every command\n"
  );
}

/** The definitive DEGRADED home when the server is unreachable or hung (the machine IS
 *  configured, so this isn't the not-connected view). Never empty; exits 0 so the
 *  SessionStart hook never surfaces as a failure. */
function degradedHome(bin: string | null, server: string, reason: string): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    `machine: configured${server ? ` · ${server}` : ""} — server unreachable right now (${reason})\n` +
    "help[1]:\n" +
    "  Run `loopany loops` once the server is reachable to list this machine's loops\n"
  );
}

/** The definitive home when the server predates the axi `home` verb (no rendered
 *  `text`). The machine IS configured, so this isn't the not-connected view; it names
 *  the too-old server + the fix. Never empty; exits 0 so the SessionStart hook never
 *  surfaces as a failure. */
function tooOldHome(bin: string | null, server: string): string {
  return (
    `${binLine(bin)}\n` +
    "description: Run your scheduled Loopany agent loops on this machine with your own coding agent.\n" +
    `machine: configured${server ? ` · ${server}` : ""} — server too old for this CLI; update the Loopany server\n` +
    "help[1]:\n" +
    "  Run `loopany loops` after updating the server to list this machine's loops\n"
  );
}
