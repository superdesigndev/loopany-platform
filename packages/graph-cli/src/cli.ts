/**
 * `graph` - the CLI half of the seven-verb operation surface (captain decision 15).
 *
 * This binary is a PURE TEXT SINK, and that is the whole design: it resolves the
 * run's identity from the environment, inlines any file its verb needs, POSTs
 * argv, prints `text`, exits with `exitCode`. It parses no flags, knows no verbs,
 * and renders nothing.
 *
 * That is not laziness - it is the only way the three surfaces decision 16 names
 * (this CLI, the HTTP verb endpoints, the workspace UI) can be guaranteed to say
 * the same thing about the same operation. A CLI that formatted its own output
 * would be a second renderer to keep in step, and the first time they disagreed
 * an agent would be reading one story while a person read another.
 *
 * ── what it DOES decide ─────────────────────────────────────────────────────
 *
 * Three things, all of them local by necessity:
 *
 *   IDENTITY   `LOOPANY_RUN_ID` + `LOOPANY_RUN_TOKEN` + `LOOPANY_GRAPH_SERVER_URL`,
 *              handed to the run by the machine agent. Missing ⇒ a definitive
 *              message naming what is absent, never a stack trace.
 *   FILES      `artifact push <file>` and `wait answer --evidence <file>` name
 *              paths, and the server has no disk. So the bytes are read HERE and
 *              travel in the body - which also keeps the server honestly unable
 *              to read a machine's filesystem.
 *   FAILURE    a server that cannot be reached prints one line and exits 1. An
 *              agent needs to know its call did not land; a stack trace tells it
 *              the same thing in thirty lines it will then reason about.
 */
import { readFile } from "node:fs/promises";

/** Bytes an artifact may carry over the wire. Matches the server's own cap, so a
 *  file that will be refused is refused HERE, before the upload. */
export const ARTIFACT_CAP = 512 * 1024;

export interface Env {
  runId?: string;
  token?: string;
  serverUrl?: string;
}

export interface CliDeps {
  env: Env;
  /** Injected so every probe drives the real argv path without a network or a
   *  filesystem - the same seam discipline the machine agent uses. */
  post: (url: string, body: unknown, token: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  readFile: (path: string) => Promise<string>;
  write: (text: string) => void;
  writeErr: (text: string) => void;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    ...(source.LOOPANY_RUN_ID?.trim() ? { runId: source.LOOPANY_RUN_ID.trim() } : {}),
    ...(source.LOOPANY_RUN_TOKEN?.trim() ? { token: source.LOOPANY_RUN_TOKEN.trim() } : {}),
    ...(source.LOOPANY_GRAPH_SERVER_URL?.trim()
      ? { serverUrl: source.LOOPANY_GRAPH_SERVER_URL.trim().replace(/\/+$/, "") }
      : {}),
  };
}

/**
 * Which argument of which verb is a FILE PATH that must be inlined.
 *
 * Two, and both for the same reason: the server never touches a disk, so a verb
 * that names a file has its bytes read here. `--evidence` is deliberately
 * forgiving - a value that is not a readable file is treated as the evidence
 * text itself, because "I saw zero occurrences" is a perfectly good answer and
 * making a watcher write it to a file first would be ceremony.
 */
async function inlineFiles(argv: string[], deps: CliDeps): Promise<{ ok: true; argv: string[] } | { ok: false; why: string }> {
  const verb = `${argv[0] ?? ""} ${argv[1] ?? ""}`.trim();
  const out = [...argv];

  if (verb === "artifact push") {
    const path = out.slice(2).find((a) => !a.startsWith("--") && !isFlagValue(out, a));
    if (!path) return { ok: false, why: "graph artifact push needs a file to push" };
    let body: string;
    try {
      body = await deps.readFile(path);
    } catch (err) {
      return { ok: false, why: `cannot read ${path}: ${errText(err)}` };
    }
    if (body.length > ARTIFACT_CAP) {
      return { ok: false, why: `${path} is ${body.length} bytes, over the ${ARTIFACT_CAP} cap` };
    }
    out.push("--body", body);
  }

  if (verb === "wait answer") {
    const at = out.indexOf("--evidence");
    const value = at === -1 ? undefined : out[at + 1];
    if (value && !value.startsWith("--")) {
      // A path if it reads, prose otherwise. Never an error either way.
      try {
        out[at + 1] = await deps.readFile(value);
      } catch {
        /* not a file - the value IS the evidence */
      }
    }
  }

  return { ok: true, argv: out };
}

/** Is this token the VALUE of a preceding flag rather than a positional? */
function isFlagValue(argv: string[], token: string): boolean {
  const at = argv.indexOf(token);
  return at > 0 && argv[at - 1]!.startsWith("--") && !argv[at - 1]!.includes("=");
}

/**
 * Run one `graph` invocation.
 *
 * Returns the exit code; never throws. Every failure mode - no identity, an
 * unreadable file, an unreachable server, a refusal from the graph - prints one
 * definitive block and returns a non-zero code.
 */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const { env } = deps;
  if (!env.runId || !env.token || !env.serverUrl) {
    const missing = [
      !env.runId ? "LOOPANY_RUN_ID" : null,
      !env.token ? "LOOPANY_RUN_TOKEN" : null,
      !env.serverUrl ? "LOOPANY_GRAPH_SERVER_URL" : null,
    ].filter(Boolean);
    deps.write(
      [
        `error: "graph needs a run identity and this environment has none (${missing.join(", ")} unset)"`,
        "code: UNCONFIGURED",
        "help[1]:",
        "  This command only works inside a dispatched run. The machine agent sets these.",
      ].join("\n") + "\n",
    );
    return 2;
  }

  const inlined = await inlineFiles(argv, deps);
  if (!inlined.ok) {
    deps.write([`error: ${JSON.stringify(inlined.why)}`, "code: VALIDATION_ERROR"].join("\n") + "\n");
    return 2;
  }

  let response: { status: number; body: Record<string, unknown> };
  try {
    response = await deps.post(`${env.serverUrl}/api/agent/cli`, { runId: env.runId, argv: inlined.argv }, env.token);
  } catch (err) {
    deps.write(
      [
        `error: ${JSON.stringify(`cannot reach the workspace at ${env.serverUrl}: ${errText(err)}`)}`,
        "code: UNREACHABLE",
      ].join("\n") + "\n",
    );
    return 1;
  }

  const text = typeof response.body.text === "string" ? response.body.text : undefined;
  if (text === undefined) {
    // A server that answers without `text` is not one this binary speaks to. Say
    // so definitively rather than printing nothing, which an agent would read as
    // success.
    deps.write(
      [
        `error: ${JSON.stringify(`the workspace answered ${response.status} with no text - it is too old for this CLI`)}`,
        "code: SERVER_TOO_OLD",
      ].join("\n") + "\n",
    );
    return 1;
  }

  deps.write(text.endsWith("\n") ? text : `${text}\n`);
  const code = response.body.exitCode;
  return typeof code === "number" ? code : response.status >= 400 ? 1 : 0;
}

export function defaultDeps(): CliDeps {
  return {
    env: readEnv(),
    post: async (url, body, token) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body: parsed };
    },
    readFile: (path) => readFile(path, "utf8"),
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}
