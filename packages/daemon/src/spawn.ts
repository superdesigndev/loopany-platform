/**
 * Shared subprocess runner: spawn, collect stdout/stderr, honor an AbortSignal
 * (SIGTERM→SIGKILL), enforce a wall-clock timeout. Ported from c0's handoff
 * spawn.ts. Task text goes via argv; stdin is unused.
 */
import { spawn } from "node:child_process";
import type { CodingAgent } from "./create.js";

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const KILL_GRACE_MS = 5_000;
const STREAM_DRAIN_MS = 1_000;
/** When a streaming consumer (onStdout) handles output live, we only retain a
 *  bounded tail for the error-fallback path — stream-json --verbose can be MBs. */
const STDOUT_TAIL_CAP = 64_000;

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with each stdout chunk as it arrives (for live/streamed parsing). */
  onStdout?: (chunk: string) => void;
}

export function runProcess(command: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // POSIX: run the child in its OWN process group so the timeout/abort kill can
    // signal the whole tree — a SIGKILLed workflow's mcporter stdio grandchildren
    // must not survive the workflow. win32 has no process groups: plain child.kill.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    /** Signal the child's process group (posix), falling back to the child alone. */
    const signalTree = (sig: NodeJS.Signals) => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          /* group already gone / detach failed — fall through to the direct child */
        }
      }
      child.kill(sig);
    };

    const terminate = () => {
      signalTree("SIGTERM");
      killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
    };

    const onAbort = () => terminate();
    if (opts.signal) {
      if (opts.signal.aborted) terminate();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (opts.onStdout) {
        opts.onStdout(s); // consumer parses live; keep only a bounded tail for errors
        stdout = (stdout + s).slice(-STDOUT_TAIL_CAP);
      } else {
        stdout += s;
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    let settled = false;
    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal: sig, stdout, stderr, timedOut });
    };
    child.on("close", (code, sig) => settle(code, sig));
    child.on("exit", (code, sig) => {
      setTimeout(() => settle(code, sig), STREAM_DRAIN_MS).unref();
    });
  });
}

/** Base env keys every allowlisted child gets — what a process needs to RUN
 *  (paths, locale, proxy/CA config), never the rest of the user's shell. */
const BASE_ALLOW = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TZ",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "XDG_CONFIG_HOME",
];

/** Build an allowlisted child env: the base set plus extra exact keys and prefix
 *  families. The shared helper behind execEnv() AND the workflow subprocess env
 *  (server-supplied workflow JS must never inherit the user's full shell). */
export function allowlistEnv(extra: { keys?: string[]; prefixes?: string[] } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...BASE_ALLOW, ...(extra.keys ?? [])]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const prefix of extra.prefixes ?? []) {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith(prefix)) env[k] = process.env[k];
    }
  }
  return env;
}

/** Allowlisted env for the coding-agent subprocess — never inherit unrelated
 *  secrets. Per-agent credential sets stay tight (no full parent env dump):
 *   - claude-code: ANTHROPIC_* + CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR
 *     (proxy/gateway users + relocated config so transcripts stay findable)
 *   - grok: XAI_API_KEY (+ optional GROK_HOME / XAI_API_BASE_URL); OAuth in
 *     `~/.grok` is free via HOME (BASE_ALLOW)
 *   - codex: OPENAI_API_KEY / CODEX_API_KEY (+ optional CODEX_HOME); OAuth /
 *     session files under `~/.codex` are free via HOME
 * Keys ride ONLY their agent's path so a claude run never inherits an unrelated
 * xAI/OpenAI secret. `agent` defaults to claude-code so existing callers are unchanged. */
export function execEnv(agent: CodingAgent = "claude-code"): NodeJS.ProcessEnv {
  if (agent === "grok") {
    return allowlistEnv({
      keys: ["XAI_API_KEY", "GROK_HOME", "XAI_API_BASE_URL"],
    });
  }
  if (agent === "codex") {
    return allowlistEnv({
      keys: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"],
    });
  }
  return allowlistEnv({
    keys: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
    prefixes: ["ANTHROPIC_"],
  });
}
