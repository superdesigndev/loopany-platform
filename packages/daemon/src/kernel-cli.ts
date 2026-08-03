import fs from "node:fs";

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";

export interface KernelCliDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  server?: string;
  token?: string;
  readFile?: (path: string) => string;
  readStdin?: () => string;
  out?: (text: string) => void;
}

interface Reply { status: number; body?: Record<string, unknown>; text?: string }

export async function runKernelCli(argv: string[], deps: KernelCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const [noun, verb, id] = argv;
  if (argv.includes("--help") || argv.includes("-h")) { out(helpText(noun, verb)); return 0; }
  const server = (deps.server ?? resolveServerUrl(undefined)).replace(/\/$/, "");
  const token = deps.token ?? env.LOOPANY_TOKEN ?? readStored(DEVICE_FILE);
  if (!server) return localError(out, "Loopany server is not configured", "ERROR", "run `loopany up` first", 1);
  const flags = parseArgs(argv.slice(noun === "inbox" || noun === "answer" ? 1 : 2));
  const contextHeaders: Record<string, string> = {};
  if (token && noun !== "inbox" && noun !== "answer") contextHeaders.Authorization = `Bearer ${token}`;
  if (env.LOOPANY_RUN_ID) contextHeaders["X-Loopany-Run"] = env.LOOPANY_RUN_ID;
  if (env.LOOPANY_SESSION) contextHeaders.Cookie = env.LOOPANY_SESSION.includes("=") ? env.LOOPANY_SESSION : `better-auth.session_token=${env.LOOPANY_SESSION}`;

  let request: { path: string; method?: string; headers?: Record<string, string>; body?: string } | undefined;
  let action = "";
  if (noun === "task" && verb === "list") {
    const allowed = new Set(["open", "closed", "due", "unwatched", "watcher", "creator", "since"]);
    const bad = firstUnknown(flags, allowed); if (bad) return unknownFlag(out, bad);
    if (flags.open && flags.closed) return localError(out, "--open and --closed cannot be combined", "VALIDATION_ERROR", "choose one status", 2);
    if (flags.unwatched && flags.watcher) return localError(out, "--unwatched and --watcher cannot be combined", "VALIDATION_ERROR", "choose the unclaimed pool or one explicit loop", 2);
    const q = new URLSearchParams(); q.set("status", flags.closed ? "closed" : "open");
    if (flags.due) q.set("due", "true"); if (flags.unwatched) q.set("watcher", "none");
    for (const k of ["watcher", "creator", "since"]) if (typeof flags[k] === "string") q.set(k, flags[k]);
    request = { path: `/api/tasks?${q}` }; action = "listed";
  } else if ((noun === "task" || noun === "doc") && verb === "show") {
    if (!id) return usage(out, `${noun} show requires an id`, `loopany ${noun} show ${noun}-<id>`);
    const bad = firstUnknown(flags, new Set(["file", "full"])); if (bad) return unknownFlag(out, bad);
    request = { path: `/api/${noun}s/${encodeURIComponent(id)}`, headers: flags.file ? { Accept: "text/markdown" } : undefined }; action = flags.full ? "show-full" : "show";
  } else if ((noun === "task" || noun === "doc") && verb === "create") {
    const allowed = new Set(noun === "task" ? ["file", "needs-human", "watcher", "follow-up"] : ["file"]);
    const bad = firstUnknown(flags, allowed); if (bad) return unknownFlag(out, bad);
    if (typeof flags.file !== "string") return usage(out, `${noun} create requires --file`, `loopany ${noun} create --file <path>`);
    const raw = readArtifact(flags.file, deps, out); if (typeof raw === "number") return raw;
    const mapping: Record<string, string> = noun === "task" ? { "needs-human": "needs_human", watcher: "watcher", "follow-up": "follow_up" } : {};
    const shaped = addArtifactFlags(raw, flags, mapping); if (!shaped.ok) return localError(out, shaped.message, "FLAG_FILE_CONFLICT", shaped.hint, 2);
    request = { path: `/api/${noun}s`, method: "POST", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: shaped.text }; action = "created";
  } else if (noun === "task" && verb === "update") {
    if (!id) return usage(out, "task update requires an id", "loopany task update task-<id> --follow-up +3d");
    const allowed = new Set(["file", "follow-up", "watcher", "needs-human", "payload-merge"]); const bad = firstUnknown(flags, allowed); if (bad) return unknownFlag(out, bad);
    const changeFlags = ["follow-up", "watcher", "needs-human", "payload-merge"].filter((k) => flags[k] !== undefined);
    if (!flags.file && !changeFlags.length) return usage(out, "task update requires at least one field", "loopany task update task-<id> --follow-up +3d");
    if (typeof flags.file === "string") {
      const raw = readArtifact(flags.file, deps, out); if (typeof raw === "number") return raw;
      if (flags["payload-merge"] !== undefined) return localError(out, "--payload-merge cannot be combined with --file", "FLAG_FILE_CONFLICT", "replace payload: in the file or use --payload-merge without --file", 2);
      const shaped = addArtifactFlags(raw, flags, { "follow-up": "follow_up", watcher: "watcher", "needs-human": "needs_human" });
      if (!shaped.ok) return localError(out, shaped.message, "FLAG_FILE_CONFLICT", shaped.hint, 2);
      request = { path: `/api/tasks/${encodeURIComponent(id)}`, method: "PATCH", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: shaped.text };
    } else {
      const patch: Record<string, unknown> = {};
      if (flags["follow-up"] !== undefined) patch.followUp = nullToken(flags["follow-up"]);
      if (flags.watcher !== undefined) patch.watcher = nullToken(flags.watcher);
      if (flags["needs-human"] !== undefined) patch.needsHuman = nullToken(flags["needs-human"]);
      if (flags["payload-merge"] !== undefined) {
        try { const p: unknown = JSON.parse(String(flags["payload-merge"])); if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(); patch.payloadMerge = p; }
        catch { return localError(out, "--payload-merge is not a JSON object", "VALIDATION_ERROR", "pass one inline JSON object; null deletes a top-level key", 2); }
      }
      request = { path: `/api/tasks/${encodeURIComponent(id)}`, method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) };
    }
    action = "updated";
  } else if (noun === "task" && verb === "close") {
    if (!id || typeof flags.note !== "string") return usage(out, "task close requires an id and --note", "loopany task close task-<id> --note \"…\"");
    const bad = firstUnknown(flags, new Set(["note"])); if (bad) return unknownFlag(out, bad);
    request = { path: `/api/tasks/${encodeURIComponent(id)}/close`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: flags.note }) }; action = "closed";
  } else if (noun === "doc" && verb === "update") {
    if (!id || typeof flags.file !== "string") return usage(out, "doc update requires an id and --file", "loopany doc update doc-<id> --file <path>");
    const bad = firstUnknown(flags, new Set(["file"])); if (bad) return unknownFlag(out, bad);
    const raw = readArtifact(flags.file, deps, out); if (typeof raw === "number") return raw;
    request = { path: `/api/docs/${encodeURIComponent(id)}`, method: "PATCH", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: raw }; action = "updated";
  } else if (noun === "loop" && verb === "evolve") {
    if (!id || typeof flags.file !== "string") return usage(out, "loop evolve requires an id and --file", "loopany loop evolve loop-<id> --file <path>");
    const bad = firstUnknown(flags, new Set(["file"])); if (bad) return unknownFlag(out, bad);
    const raw = readArtifact(flags.file, deps, out); if (typeof raw === "number") return raw;
    request = { path: `/api/loops/${encodeURIComponent(id)}/evolve`, method: "POST", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: raw }; action = "evolved";
  } else if (noun === "loop" && verb === "update") {
    if (!id || typeof flags.cron !== "string" || typeof flags.approval !== "string") return usage(out, "loop update requires --cron and --approval", "loopany loop update loop-<id> --cron \"0 * * * *\" --approval ev-<id>");
    const bad = firstUnknown(flags, new Set(["cron", "approval"])); if (bad) return unknownFlag(out, bad);
    request = { path: `/api/loops/${encodeURIComponent(id)}`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron: flags.cron, approval: flags.approval }) }; action = "updated";
  } else if (noun === "inbox") {
    if (argv.length !== 1) return usage(out, "inbox takes no arguments", "loopany inbox");
    request = { path: "/api/inbox" }; action = "inbox";
  } else if (noun === "answer") {
    const taskId = argv[1], answer = argv[2]; if (!taskId || answer === undefined || argv.length !== 3) return usage(out, "answer requires a task id and one text argument", "loopany answer task-<id> \"…\"");
    request = { path: `/api/tasks/${encodeURIComponent(taskId)}/verdict`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) }; action = "answered";
  } else return usage(out, `unknown command ${argv.join(" ")}`, "loopany task list");

  let reply: Reply;
  try {
    const response = await (deps.fetchImpl ?? fetch)(server + request.path, { method: request.method ?? "GET", headers: { ...contextHeaders, ...request.headers }, body: request.body });
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/markdown")) reply = { status: response.status, text: await response.text() };
    else reply = { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  } catch (error) { return localError(out, error instanceof Error ? error.message : String(error), "ERROR", "retry with backoff; the server could not be reached", 1); }
  if (reply.status < 200 || reply.status >= 300) return renderRefusal(out, reply.status, reply.body ?? {});
  if (reply.text !== undefined) { out(reply.text); return 0; }
  out(renderSuccess(action, reply.body ?? {})); return 0;
}

function renderSuccess(action: string, body: Record<string, unknown>): string {
  if (action === "listed") {
    const tasks = Array.isArray(body.tasks) ? body.tasks as Record<string, unknown>[] : [];
    return `count: ${tasks.length}\n${tasks.length ? `tasks[${tasks.length}]{id,title,status,follow_up,watcher,question}:\n${tasks.map((t) => `  ${cell(t.id)},${cell(t.title)},${cell(t.status)},${cell(t.followUpAt)},${cell(t.watcher)},${cell(t.pendingQuestion)}`).join("\n")}` : "tasks: []"}\nhelp[1]:\n  Run \`loopany task show <id>\` before changing it\n`;
  }
  if (action === "inbox") {
    const items = Array.isArray(body.items) ? body.items as { task?: Record<string, unknown>; reasons?: string[] }[] : [];
    return `count: ${items.length}\ninbox[${items.length}]{id,reason,title,question,follow_up,watcher}:\n${items.map((i) => `  ${cell(i.task?.id)},${cell(i.reasons?.join("+"))},${cell(i.task?.title)},${cell(i.task?.pendingQuestion)},${cell(i.task?.followUpAt)},${cell(i.task?.watcher)}`).join("\n")}\nhelp[1]:\n  Run \`loopany answer <task-id> \"…\"\` for a question\n`;
  }
  const object = (body.task ?? body.doc ?? body.loop) as Record<string, unknown> | undefined;
  const id = object?.id ?? ((body.run as Record<string, unknown> | undefined)?.id ?? "—");
  if ((action === "show" || action === "show-full") && object) {
    let text = detail(object, false, action === "show-full");
    const history = Array.isArray(body.events) ? body.events as Record<string, unknown>[] : [];
    text += history.length
      ? `events[${history.length}]{id,kind,entrance,ts,note}:\n${history.map((event) => `  ${cell(event.id)},${cell(event.kind)},${cell(event.entrance)},${cell(event.ts)},${cell(event.note)}`).join("\n")}\n`
      : "events: []\n";
    return `${text}help[1]:\n  Use \`--file\` to read the canonical artifact\n`;
  }
  const replay = body.created === false ? " (idempotent: existing object returned)" : body.changed === false ? " (no change)" : "";
  let text = `ok: ${action} ${id}${replay}\n`;
  if (body.contentDiffers) text += `warning: ${JSON.stringify((body.notice as Record<string, unknown> | undefined)?.message ?? "submitted content differs from the stored object; nothing was written")}\ndiffers[${(body.differingFields as unknown[] | undefined)?.length ?? 0}]: ${(body.differingFields as unknown[] | undefined)?.join(", ") ?? "—"}\n`;
  else if (body.notice && typeof body.notice === "object") text += `warning: ${JSON.stringify((body.notice as Record<string, unknown>).message)}\n`;
  if (object) text += detail(object, false); if (body.event !== undefined) text += `event: ${cell(body.event)}\n`;
  text += `help[1]:\n  Run \`loopany ${object?.kind ?? "task"} show ${id}\` to inspect the current object\n`;
  return text;
}

function detail(object: Record<string, unknown>, help = true, full = false): string {
  const kind = String(object.kind ?? "object"); const keys = ["id", "title", "status", "format", "followUpAt", "watcher", "pendingQuestion", "cron", "nextFire", "key", "createdByRun", "createdByLoop", "createdAt", "updatedAt", "closedAt"];
  let out = `${kind}:\n`; for (const key of keys) if (Object.hasOwn(object, key)) out += `  ${snake(key)}: ${cell(object[key])}\n`;
  if (object.payload && typeof object.payload === "object") out += `payload: ${JSON.stringify(object.payload)}\n`;
  if (typeof object.body === "string") out += `body: ${cell(!full && object.body.length > 1200 ? `${object.body.slice(0, 1200)}… (truncated, ${object.body.length} chars total — use --full to see complete body)` : object.body)}\n`;
  if (help) out += `help[1]:\n  Use \`--file\` to read the canonical artifact\n`; return out;
}

function renderRefusal(out: (s: string) => void, status: number, body: Record<string, unknown>): number {
  const code = typeof body.code === "string" ? body.code : status === 404 ? "NOT_FOUND" : "ERROR";
  let text = `error: ${JSON.stringify(typeof body.message === "string" ? body.message : `request failed (${status})`)}\ncode: ${code}\n`;
  const issue = Array.isArray(body.issues) ? body.issues[0] as Record<string, unknown> | undefined : undefined;
  if (issue?.got !== undefined) text += `wrote: ${cell(issue.got)}\n`; if (issue?.expected !== undefined) text += `expected: ${cell(issue.expected)}\n`;
  text += `help[1]:\n  ${typeof body.hint === "string" ? body.hint : "read the refusal and retry with the legal form"}\n`; out(text);
  return status === 404 ? 3 : status === 401 || status === 429 || status >= 500 ? 1 : 2;
}
function localError(out: (s: string) => void, message: string, code: string, hint: string, exit: number) { out(`error: ${JSON.stringify(message)}\ncode: ${code}\nhelp[1]:\n  ${hint}\n`); return exit; }
function usage(out: (s: string) => void, message: string, expected: string) { out(`error: ${JSON.stringify(message)}\ncode: VALIDATION_ERROR\nexpected: ${expected}\nhelp[1]:\n  Follow the syntax above; unknown or missing inputs are never ignored\n`); return 2; }
function unknownFlag(out: (s: string) => void, flag: string) { return localError(out, `unknown flag --${flag}`, "VALIDATION_ERROR", "run the command with --help to see its grammar", 2); }
function parseArgs(args: string[]) { const out: Record<string, string | boolean> = {}; for (let i = 0; i < args.length; i++) { const a = args[i]!; if (!a.startsWith("--")) continue; const key = a.slice(2); const next = args[i + 1]; if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true; } return out; }
function firstUnknown(flags: Record<string, unknown>, allowed: Set<string>) { return Object.keys(flags).find((key) => !allowed.has(key)); }
function readArtifact(path: string, deps: KernelCliDeps, out: (s: string) => void): string | number { try { return path === "-" ? (deps.readStdin?.() ?? fs.readFileSync(0, "utf8")) : (deps.readFile?.(path) ?? fs.readFileSync(path, "utf8")); } catch { return localError(out, `cannot read --file ${path}`, "ERROR", "write the artifact file first, then retry", 1); } }
function addArtifactFlags(raw: string, flags: Record<string, string | boolean>, mapping: Record<string, string>): { ok: true; text: string } | { ok: false; message: string; hint: string } { const conflict = findArtifactConflict(raw, flags, mapping); if (conflict) return { ok: false, message: `--${conflict.flag} conflicts with ${conflict.key}: in --file`, hint: "put the value in one place only" }; const additions = Object.entries(mapping).filter(([flag]) => typeof flags[flag] === "string").map(([flag, key]) => `${key}: ${JSON.stringify(nullToken(flags[flag]))}`); if (!additions.length) return { ok: true, text: raw }; const close = raw.indexOf("\n---", 4); if (close < 0) return { ok: true, text: raw }; return { ok: true, text: `${raw.slice(0, close)}\n${additions.join("\n")}${raw.slice(close)}` }; }
function findArtifactConflict(raw: string, flags: Record<string, string | boolean>, mapping: Record<string, string>) { const headEnd = raw.indexOf("\n---", 4); const head = headEnd >= 0 ? raw.slice(0, headEnd) : raw; for (const [flag, key] of Object.entries(mapping)) if (flags[flag] !== undefined && new RegExp(`^${key}:`, "m").test(head)) return { flag, key }; }
function nullToken(value: unknown) { return value === "null" ? null : value; }
function cell(value: unknown): string { if (value === null || value === undefined || value === "") return "—"; const s = typeof value === "string" ? value.replace(/\n/g, "\\n") : JSON.stringify(value); return /[\s,:\"]/.test(s) ? JSON.stringify(s) : s; }
function snake(value: string) { return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function helpText(noun: string | undefined, verb: string | undefined): string {
  const command = [noun, verb].filter(Boolean).join(" ");
  const usage: Record<string, string> = {
    "task list": "loopany task list [--open|--closed] [--due] [--unwatched] [--watcher <loop-id>] [--creator <loop-id>] [--since 14d]",
    "task show": "loopany task show <id> [--file] [--full]",
    "task create": "loopany task create --file <path> [--needs-human <question>] [--watcher <loop-id>] [--follow-up +3d]",
    "task update": "loopany task update <id> [--follow-up +3d] [--watcher <loop-id>] [--needs-human <question>] [--payload-merge <json>] [--file <path>]",
    "task close": "loopany task close <id> --note <text>",
    "doc show": "loopany doc show <id> [--file] [--full]", "doc create": "loopany doc create --file <path>", "doc update": "loopany doc update <id> --file <path>",
    "loop evolve": "loopany loop evolve <loop-id> --file <path>", "loop update": "loopany loop update <loop-id> --cron <expr> --approval <event-id>",
    inbox: "loopany inbox", answer: "loopany answer <task-id> <text>",
  };
  const syntax = usage[command] ?? usage[noun ?? ""] ?? "loopany task list";
  return `usage: ${syntax}\nnotes:\n  --file - reads stdin; run context comes only from LOOPANY_RUN_ID\n  unknown fields are refused at the server's single artifact seam\nexamples:\n  loopany task list --open --unwatched\n`;
}
