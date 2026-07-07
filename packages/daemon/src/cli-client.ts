/**
 * The ONE CLI transport client (batch 5 — run-experience redesign §4.4). Both CLI
 * worlds — the in-run callback (`loopany report …`, run token) and the owner's
 * out-of-run verbs (`loopany loops`/`edit`/`log`/`new`, device token) — now converge
 * here: pick whatever credential the environment carries, inline the file flags, and
 * POST `{argv}` to the unified `/api/machine/cli` dispatch.
 *
 * Back-compat (one release): if the server 404s the unified endpoint (an old server
 * that predates batch 4), we fall back to the legacy endpoint for THAT credential —
 * `/agent-api/loop` for a run token (see `legacyRun`), or the caller-supplied device
 * fallback (`/api/machine/loop` / `/api/machine/log`) for the owner verbs.
 */
import fs from "node:fs";

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";

/**
 * In-run file flags: claude writes a large body to a temp file and passes its path;
 * we inline the file's content into the argv so it survives the shell + JSON hop.
 * Lives here (not in callback.ts) so BOTH credential paths get the inlining — a
 * device verb that ever used `--message-file` inlines identically.
 */
const FILE_FLAGS: Record<string, string> = {
  "--message-file": "--message",
  "--state-file": "--state-content",
  "--file": "--file-content",
};

export type InlineResult = { ok: true; argv: string[] } | { ok: false; path: string };

/** Replace each `--*-file <path>` with `--* <file-contents>`. The read is the only
 *  impure bit (injectable for tests); an unreadable path fails the whole call. */
export function inlineFileFlags(
  argv: string[],
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): InlineResult {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    const repl = FILE_FLAGS[out[i]!];
    if (repl) {
      try {
        out[i + 1] = readFile(out[i + 1]!);
        out[i] = repl;
      } catch {
        return { ok: false, path: out[i + 1]! };
      }
    }
  }
  return { ok: true, argv: out };
}

/** A parsed server reply: HTTP status + JSON body (best-effort — a non-JSON body
 *  degrades to `{}`, matching the old per-caller `res.json().catch(() => ({}))`). */
export interface CliResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The legacy endpoint to hit when the unified dispatch 404s. The client passes the
 *  already-inlined argv + resolved credential/server so the fallback only fetches. */
export type LegacyFallback = (ctx: {
  server: string;
  token: string;
  isRun: boolean;
  argv: string[];
  fetchImpl: typeof fetch;
}) => Promise<CliResponse>;

export interface PostCliDeps {
  fetchImpl?: typeof fetch;
  /** Env carrying the run token (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test override for the persisted device token (else readStored(DEVICE_FILE)). */
  deviceToken?: string | undefined;
  /** Fully-resolved server url override (tests) — bypasses resolveServerUrl. */
  server?: string;
  /** A `--server-url` flag value the caller extracted from its argv, if any. */
  serverFlag?: string | undefined;
  /** Injectable file read for `inlineFileFlags` (tests). */
  readFile?: (p: string) => string;
}

export type PostCliResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "not-configured" }
  | { kind: "read-error"; path: string }
  | { kind: "network-error"; message: string };

/**
 * Resolve the credential the way §4.4 mandates: the in-run run token (env) wins,
 * else the persisted device token. `isRun` tells the fallback which legacy endpoint
 * the credential belongs to. Undefined ⇒ neither is available (not connected).
 */
export function resolveCredential(deps: PostCliDeps = {}): { token: string; isRun: boolean } | undefined {
  const env = deps.env ?? process.env;
  const runToken = env.LOOPANY_RUN_TOKEN;
  if (runToken) return { token: runToken, isRun: true };
  const device = "deviceToken" in deps ? deps.deviceToken : readStored(DEVICE_FILE);
  if (device) return { token: device, isRun: false };
  return undefined;
}

/**
 * POST `{argv}` to the unified `/api/machine/cli` with whatever credential the env
 * carries. On a 404 (old server) fall back to `legacy` for that credential. Never
 * throws — a missing credential/server, an unreadable file flag, and a network fault
 * each map to a distinct result so callers render their own message.
 */
export async function postCli(argv: string[], legacy: LegacyFallback, deps: PostCliDeps = {}): Promise<PostCliResult> {
  const cred = resolveCredential(deps);
  const server = "server" in deps ? (deps.server ?? "") : resolveServerUrl(deps.serverFlag);
  if (!cred || !server) return { kind: "not-configured" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  const inlined = inlineFileFlags(argv, deps.readFile);
  if (!inlined.ok) return { kind: "read-error", path: inlined.path };

  try {
    const res = await fetchImpl(`${server}/api/machine/cli`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ argv: inlined.argv }),
    });
    if (res.status === 404) {
      const r = await legacy({ server, token: cred.token, isRun: cred.isRun, argv: inlined.argv, fetchImpl });
      return { kind: "ok", status: r.status, body: r.body };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: "ok", status: res.status, body };
  } catch (err) {
    return { kind: "network-error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The text-sink primary path: print the server's pre-rendered `text` and return its
 * `exitCode`. This is the ONE render every verb path prefers — the server owns the
 * TOON, the daemon is a dumb sink. Returns null when `text` is absent (a server that
 * predates the axi text spine, pre-0.12). Never used for the
 * not-configured/read-error/network-error results (those carry no server body) —
 * callers handle those first.
 */
export function printText(
  body: Record<string, unknown>,
  status: number,
  out: (s: string) => void,
): number | null {
  const text = body.text;
  if (typeof text === "string" && text.length > 0) {
    out(text.endsWith("\n") ? text : text + "\n");
    return typeof body.exitCode === "number" ? body.exitCode : status >= 200 && status < 300 ? 0 : 1;
  }
  return null;
}

/**
 * The text-sink render with the too-old-server guard (Batch 7). Prints the server's
 * `text` (+ returns its `exitCode`); when `text` is ABSENT the server predates the axi
 * text spine (pre-0.12) — this CLI is a pure text sink with no structured render
 * fallback anymore, so print a DEFINITIVE structured error to stdout (P6) rather than
 * silently nothing, and exit 1. The mitigation is on the line: update the server, or
 * pin an older `@crewlet/loopany`.
 */
export function printTextOrTooOld(
  body: Record<string, unknown>,
  status: number,
  out: (s: string) => void,
): number {
  const code = printText(body, status, out);
  if (code !== null) return code;
  out(
    `error: ${JSON.stringify(
      "this Loopany server is too old for this CLI (no rendered `text`) — update the server, or pin an older `@crewlet/loopany`",
    )}\ncode: SERVER_TOO_OLD\n`,
  );
  return 1;
}

/** Run-token legacy fallback: the pre-batch-4 `/agent-api/loop` verb endpoint. The
 *  body shape (`{argv}`) and reply shape (`{text, exitCode}`) match the unified run
 *  branch, so callback rendering is identical whether we hit new or old. */
export const legacyRun: LegacyFallback = async ({ server, token, argv, fetchImpl }) => {
  const res = await fetchImpl(`${server.replace(/\/$/, "")}/agent-api/loop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
};
