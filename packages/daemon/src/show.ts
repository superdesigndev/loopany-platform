/**
 * `loopany show [<loop>] [--json] [--full]` OUT of a run — the owner reads a loop's
 * full editable config (F1). Like `loopany log`, it resolves the target loop
 * CLIENT-side (an explicit id/name wins; else the loop whose folder contains the cwd),
 * because the server's `show` dispatch needs an explicit loop id. Then it forwards
 * `show <id> [--json] [--full]` to the unified `/api/machine/cli` on the device
 * credential and prints the server's rendered `text` (the full editable envelope TOON,
 * or — under `--json` — the exact `edit --json` envelope for the read/write roundtrip).
 *
 * The daemon is a text sink here too: the server owns the render. Every external touch
 * is an injectable seam so tests need no real process/network/~.loopany.
 */
import path from "node:path";

import type { CliResponse, LegacyFallback, PostCliDeps } from "./cli-client.js";
import { postCli, printText } from "./cli-client.js";
import { type LoopRow, resolveLoopId } from "./log.js";

export type ShowDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  server?: string;
  token?: string;
};

/** `--k v` pairs, bare boolean `--flag` → true; everything else positional. */
function parseArgs(args: string[]): { positional: string[]; json: boolean; full: boolean } {
  const positional: string[] = [];
  let json = false;
  let full = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--full") full = true;
    else if (!a.startsWith("--")) positional.push(a);
  }
  return { positional, json, full };
}

export async function runShow(argv: string[], injected: ShowDeps = {}): Promise<number> {
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));
  const err = injected.err ?? ((s: string) => void process.stderr.write(s));
  const cwd = injected.cwd ?? (() => process.cwd());
  const flagServer = (() => {
    const i = argv.indexOf("--server-url");
    return i >= 0 ? argv[i + 1] : undefined;
  })();
  const cliDeps: PostCliDeps = {
    fetchImpl: injected.fetchFn,
    serverFlag: flagServer,
    ...("server" in injected ? { server: injected.server } : {}),
    ...("token" in injected ? { deviceToken: injected.token } : {}),
  };

  const { positional, json, full } = parseArgs(argv);
  const notConnected = () =>
    err("loopany: this machine isn't connected yet — start the daemon once with `loopany up`\n");

  // 1. List the machine's loops so the target can be resolved (client-side — the
  //    server's `show` needs an explicit id, just like `log`).
  const legacyLoops: LegacyFallback = async ({ server, token, fetchImpl }): Promise<CliResponse> => {
    const res = await fetchImpl(`${server}/api/machine/loop`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const listed = await postCli(["loops"], legacyLoops, cliDeps);
  if (listed.kind === "not-configured") return notConnected(), 2;
  if (listed.kind === "read-error") return err(`loopany: cannot read ${listed.path}\n`), 1;
  if (listed.kind === "network-error") return err(`loopany: ${listed.message}\n`), 1;
  const listData = listed.body as { loops?: LoopRow[]; error?: string };
  if (listed.status >= 400 || !listData.loops) {
    err(`loopany: ${listData.error || `could not list loops (${listed.status})`}\n`);
    return 1;
  }
  const resolved = resolveLoopId(listData.loops, positional[0], path.resolve(cwd()));
  if ("error" in resolved) return err(`loopany: ${resolved.error}\n`), 2;

  // 2. Forward `show <id> [--json] [--full]` — the server renders the envelope TOON
  //    (or the JSON envelope under --json). Old server (no /api/machine/cli): there is
  //    no device `show`, so degrade with a clear line.
  const showArgv = ["show", resolved.id, ...(json ? ["--json"] : []), ...(full ? ["--full"] : [])];
  const legacyShow: LegacyFallback = async () => ({ status: 501, body: { error: "show needs a newer server — upgrade the Loopany server" } });
  const got = await postCli(showArgv, legacyShow, cliDeps);
  if (got.kind === "not-configured") return notConnected(), 2;
  if (got.kind === "read-error") return err(`loopany: cannot read ${got.path}\n`), 1;
  if (got.kind === "network-error") return err(`loopany: ${got.message}\n`), 1;
  const code = printText(got.body, got.status, out);
  if (code !== null) return code;
  err(`loopany: ${(got.body as { error?: string }).error || `show failed (${got.status})`}\n`);
  return 1;
}
