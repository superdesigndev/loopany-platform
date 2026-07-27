/**
 * `loopany progress <step> --connect-key <key> [--server-url <url>]`
 *
 * The loop-creation skill (references/create.md) invokes this per milestone so the
 * web onboarding wizard's live checklist lights up as the coding agent works. It
 * POSTs the SAME public contract the wizard polls — POST /api/claim/progress
 * `{claim, step}` — so no server change is needed (the server enforces the enum +
 * caps). The claim is the capture snippet's connect-key; the server URL resolves
 * ambiently from this machine's stored config (~/.loopany), set on `loopany up`.
 *
 * BEST-EFFORT by construction: it NEVER throws, NEVER blocks, and always resolves 0.
 * A reporting hiccup (no key, no server, offline, an unknown step) must never affect
 * the agent's real loop-creation work — it just quietly no-ops.
 */
import { flag, resolveServerUrl } from "./config.js";

const PROGRESS_TIMEOUT_MS = 4000;

export interface ProgressDeps {
  fetchImpl?: typeof fetch;
  /** Server-URL resolver (injectable so a test can force the no-server no-op path;
   *  the module-load-time `SERVER_FILE` otherwise picks up this machine's real one). */
  resolveServer?: (flagValue: string | undefined) => string;
}

/** The first positional (non-flag) arg, skipping `--flag value` pairs. */
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

export async function runProgress(args: string[], deps: ProgressDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveServer = deps.resolveServer ?? resolveServerUrl;
  const step = positional(args);
  // `--connect-key` (what the capture snippet + `loopany new` already call it), with
  // `--claim` as an alias (the server contract's field name).
  const claim = flag(args, "connect-key") || flag(args, "claim");
  const server = resolveServer(flag(args, "server-url"));
  // Missing any input → quietly do nothing (best-effort; never fail the agent's work).
  if (!step || !claim || !server) return 0;
  try {
    await fetchImpl(`${server}/api/claim/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, step }),
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    });
  } catch {
    /* best-effort — a reporting failure never blocks creation */
  }
  return 0;
}
