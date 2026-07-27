/**
 * The task-object verbs — `loopany create|get|list|search|update|mv|run` — the
 * canonical owner CLI over the task tree (docs/task-tree-plan.md).
 *
 * Division of truth:
 *  - WORK-STATE (status/priority/parent/… + Timeline) lives in the task's
 *    README on THIS machine → these verbs edit the file locally; the daemon's
 *    watcher syncs it up and the server re-derives its index.
 *  - The EXECUTION ENVELOPE (cron/notify/goal/…) lives on the server → those
 *    keys go through the same PATCH /api/machine/loop path `loopany edit`
 *    always used (one validator surface).
 *
 * Every external touch (fs/fetch/cwd/stdout) is an injectable seam (LogDeps
 * pattern, log.ts) so tests never need a network or a real ~/.loopany.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEVICE_FILE, readStored, resolveServerUrl } from "./config.js";
import { fenceFileFlag } from "./filefence.js";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  WORK_STATE_KEYS,
  appendTimeline,
  patchFrontmatter,
  readFrontmatter,
  scaffoldReadme,
  slugify,
  stripTimelineSection,
  titleSimilarity,
} from "./taskfile.js";

// ---- wire shapes (mirror server/taskTree.ts projections) ----

interface TaskRowWire {
  loopId: string;
  slug: string | null;
  title: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  owner: string | null;
  parent: string | null;
  follow_up_date: string | null;
  order: number | null;
  cron: string | null;
  enabled: boolean;
  /** Which machine the row lives on (for the @machine marker). */
  machineId?: string;
  taskFile: string | null;
  breadcrumb?: string[];
  snippet?: string | null;
}

interface TaskTreeNodeWire extends TaskRowWire {
  children: TaskTreeNodeWire[];
  childrenTruncated?: number;
}

export type TaskDeps = {
  cwd?: () => string;
  fetchFn?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  fsImpl?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync">;
  server?: string;
  token?: string;
  /** Attribution for --note timeline entries (defaults to $USER). */
  actor?: string;
  /** Injectable clock for --wait polling + dated entries. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Root for new task folders (default ~/loopany, override LOOPANY_TASKS_DIR). */
  tasksRoot?: string;
};

type Seams = Required<Omit<TaskDeps, "server" | "token">> & { server: string; token: string };

function seams(d: TaskDeps): Seams | null {
  const token = "token" in d ? d.token : (readStored(DEVICE_FILE) ?? process.env.LOOPANY_TOKEN);
  const server = "server" in d ? (d.server ?? "") : resolveServerUrl(undefined);
  if (!token || !server) return null;
  return {
    cwd: d.cwd ?? (() => process.cwd()),
    fetchFn: d.fetchFn ?? fetch,
    out: d.out ?? ((s) => process.stdout.write(s)),
    err: d.err ?? ((s) => process.stderr.write(s)),
    fsImpl: d.fsImpl ?? fs,
    actor: d.actor ?? process.env.USER ?? "owner",
    now: d.now ?? (() => Date.now()),
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    tasksRoot: d.tasksRoot ?? process.env.LOOPANY_TASKS_DIR ?? path.join(os.homedir(), "loopany"),
    server,
    token,
  };
}

const NOT_CONNECTED =
  "loopany: this machine isn't connected yet — run `loopany daemon up --server-url … --api-key …` first\n";

/** Boolean flags across the task verbs (never swallow the next positional). */
const BOOL_FLAGS = new Set([
  "json",
  "dry-run",
  "force",
  "due",
  "recurring",
  "tree",
  "flat",
  "runs",
  "transcript",
  "wait",
  "top",
  "bottom",
  "allow-external-file",
  "here",
  "log",
  "checkout",
]);

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      // `--json` is BOTH the output-mode boolean (list/get) AND create's envelope
      // value. Disambiguate by shape: a following JSON object (or `-` = stdin)
      // is the envelope; anything else keeps the boolean reading.
      const jsonValue = key === "json" && next !== undefined && (next.trimStart().startsWith("{") || next === "-");
      if ((jsonValue || !BOOL_FLAGS.has(key)) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a === "-p" && args[i + 1] !== undefined) {
      flags["priority"] = args[++i]!;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(flags: Record<string, string | boolean>, k: string): string | undefined {
  return typeof flags[k] === "string" ? (flags[k] as string) : undefined;
}

async function api(
  s: Seams,
  pathAndQuery: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await s.fetchFn(`${s.server}${pathAndQuery}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${s.token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

function apiError(s: Seams, data: Record<string, unknown>, status: number, what: string): number {
  if (status === 404 && typeof data.error !== "string") {
    s.err(`loopany: ${what} failed (404) — the server may be too old for task verbs; update it\n`);
    return 1;
  }
  s.err(`loopany: ${typeof data.error === "string" ? data.error : `${what} failed (${status})`}\n`);
  return status === 404 || status === 400 || status === 409 ? 2 : 1;
}

// ---- rendering ----

/** Team-wide display context: rows that live on a DIFFERENT machine than
 *  the requester get an `@machine` marker, so the team view never reads as one
 *  undifferentiated local pile. Server-provided (requester id + name map). */
type ScopeCtx = { requester?: string; machines?: Record<string, string> };

function atMachine(r: TaskRowWire, ctx?: ScopeCtx): string {
  if (!ctx?.requester || !r.machineId || r.machineId === ctx.requester) return "";
  return `  @${ctx.machines?.[r.machineId] ?? r.machineId}`;
}

/** Optional list columns beyond the slim default (id · title · status + the
 *  ⟳/⏰/@machine markers) — extended per row via `list --fields a,b`. */
const LIST_OPTIONAL_FIELDS = ["type", "priority", "assignee"] as const;

function rowLine(r: TaskRowWire, ctx?: ScopeCtx, fields?: Set<string>): string {
  const extra = [
    ...(fields?.has("type") ? [r.type ?? "·"] : []),
    ...(fields?.has("priority") ? [r.priority ?? "·"] : []),
    ...(fields?.has("assignee") ? [(r as { assignee?: string | null }).assignee ?? "·"] : []),
  ];
  const bits = [r.status ?? "·", ...extra].join("  ");
  const sched = r.cron ? `  ⟳ ${r.cron}${r.enabled ? "" : " (paused)"}` : "";
  const due = r.follow_up_date ? `  ⏰ ${r.follow_up_date}` : "";
  return `${r.slug ?? r.loopId}  —  ${r.title}   ${bits}${sched}${due}${atMachine(r, ctx)}`;
}

function renderTree(roots: TaskTreeNodeWire[], out: (s: string) => void, ctx?: ScopeCtx, fields?: Set<string>): void {
  const renderKids = (node: TaskTreeNodeWire, prefix: string): void => {
    node.children.forEach((c, i) => {
      const last = i === node.children.length - 1;
      out(`${prefix}${last ? "└─ " : "├─ "}${rowLine(c, ctx, fields)}\n`);
      renderKids(c, prefix + (last ? "   " : "│  "));
    });
    if (node.childrenTruncated) {
      out(`${prefix}   … ${node.childrenTruncated} more below — loopany list ${node.slug ?? node.loopId} --depth 3\n`);
    }
  };
  roots.forEach((r, idx) => {
    out(`${rowLine(r, ctx, fields)}\n`);
    renderKids(r, "");
    if (idx < roots.length - 1) out("\n");
  });
}

// ---- create ----

export async function runTaskCreate(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const title = positional.join(" ").trim();
  if (!title) {
    s.err('usage: loopany create "<title>" [--cron "0 9 * * *"] [--parent <id>] [--type goal|strategy|experiment|task|idea] [--priority P0-P3] [--status idea|todo] [--body "…"] [--json \'<envelope>\'] [--dry-run] [--force]\n');
    return 2;
  }
  const type = str(flags, "type");
  if (type && !TASK_TYPES.includes(type as never)) {
    s.err(`loopany: type must be one of: ${TASK_TYPES.join(", ")} (got: '${type}')\n`);
    return 2;
  }
  const status = str(flags, "status") ?? "idea";
  if (!["idea", "todo"].includes(status)) {
    s.err(`loopany: create starts a task as idea or todo (got: '${status}') — later transitions via loopany update\n`);
    return 2;
  }
  const priority = str(flags, "priority");
  if (priority && !TASK_PRIORITIES.includes(priority as never)) {
    s.err(`loopany: priority must be one of: ${TASK_PRIORITIES.join(", ")} (got: '${priority}')\n`);
    return 2;
  }
  // Create takes only a HUMAN assignee (an email). Anything else — a registry
  // slug, `<machine>/<runtime>`, a bare handle — is an executor ref or a typo;
  // silently scaffolding it into front matter as a "person" was the old bug.
  // Agent hand-off is deliberately two-step (create, then assign — the
  // assignment is the dispatch edge).
  const assigneeFlag = str(flags, "assignee");
  if (assigneeFlag && !assigneeFlag.includes("@")) {
    s.err(`loopany: create takes only a HUMAN assignee (an email). To hand the task to an agent, create it first, then: loopany update <slug> assignee=${assigneeFlag}\n`);
    return 2;
  }
  let envelope: Record<string, unknown> = {};
  const rawJson = str(flags, "json");
  if (rawJson) {
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      envelope = parsed as Record<string, unknown>;
    } catch (e) {
      s.err(`loopany: --json is not a JSON object: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }

  // --cron sugar: the one-line "create a loop" story. Merges into the envelope;
  // a conflicting cron in --json is an error, never a silent pick (same rule as
  // ambiguous slug resolution). The server stays the real cadence validator —
  // this check only catches obvious shape errors before the folder scaffolds.
  const cronFlag = str(flags, "cron");
  if (cronFlag !== undefined) {
    if (envelope.cron !== undefined && envelope.cron !== cronFlag) {
      s.err(`loopany: --cron '${cronFlag}' conflicts with --json cron '${String(envelope.cron)}' — pass one, not both\n`);
      return 2;
    }
    if (cronFlag.trim().split(/\s+/).length !== 5) {
      s.err(`loopany: --cron needs a 5-field cron expression (e.g. "0 9 * * 1"), got: '${cronFlag}'\n`);
      return 2;
    }
    envelope.cron = cronFlag;
  }

  // Spec content: --spec inline, --spec-file (cwd-fenced), or the legacy --body.
  let spec = str(flags, "spec") ?? str(flags, "body") ?? (typeof envelope.spec === "string" ? envelope.spec : undefined);
  const specFile = str(flags, "spec-file");
  if (specFile !== undefined) {
    const fenced = fenceFileFlag("--spec-file", specFile, s.cwd(), flags["allow-external-file"] === true);
    if (fenced) {
      s.err(fenced);
      return 2;
    }
    try {
      spec = s.fsImpl.readFileSync(specFile, "utf8");
    } catch (e) {
      s.err(`loopany: cannot read ${specFile}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }

  const slug = str(flags, "slug") ?? slugify(title);
  const dir = path.join(s.tasksRoot, slug);
  // The doc is composed here but lives ONLY in the cloud — no local folder is
  // written at create. The folder appears lazily when a run first writes
  // artifacts into the workdir (or the daemon materializes TASK.md).
  const content = scaffoldReadme({
    slug,
    title,
    type,
    status,
    priority,
    parent: str(flags, "parent"),
    owner: str(flags, "owner"),
    // Create takes only the HUMAN assignee (front matter). Executor assignment
    // (`<machine>/<agent>`) is a post-create operation: `loopany update <id> assignee=…`.
    assignee: str(flags, "assignee"),
    body: spec,
  });

  if (flags["force"] !== true && flags["dry-run"] !== true) {
    // Fuzzy dedup against the server's tree (Rule 1: search before create).
    const list = await api(s, "/api/machine/task?op=list&flat=1");
    const rows = (list.data.rows as TaskRowWire[] | undefined) ?? [];
    const near = rows.filter((r) => titleSimilarity(r.title, title) >= 0.6 || r.slug === slug);
    if (near.length) {
      s.err(`loopany: similar task(s) already exist — update one of these instead, or re-run with --force:\n`);
      for (const n of near.slice(0, 5)) s.err(`  ${rowLine(n)}\n`);
      return 2;
    }
  }

  const body = {
    ...envelope,
    name: title,
    slug,
    // Runs execute IN the task's folder unless the envelope points elsewhere —
    // without this the runner falls back to the daemon scratch dir and the
    // task's artifacts would land outside its home. The folder itself is
    // created lazily by the first run/artifact write, never here.
    workdir: typeof envelope.workdir === "string" ? envelope.workdir : dir,
    taskFileContent: content,
    ...(flags["dry-run"] === true ? { dryRun: true } : {}),
  };

  if (flags["dry-run"] === true) {
    const r = await api(s, "/api/machine/loop", { method: "POST", body });
    if (!r.ok) return apiError(s, r.data, r.status, "create dry-run");
    s.out(`would create ${slug} (cloud row, no local files)\n\n${content}\n`);
    if (flags["json"] === true) s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }

  const r = await api(s, "/api/machine/loop", { method: "POST", body });
  if (!r.ok) return apiError(s, r.data, r.status, "create");
  if (flags["json"] === true) {
    s.out(`${JSON.stringify({ ...r.data, slug }, null, 2)}\n`);
    return 0;
  }
  if (r.data.existing === true) s.out(`already exists: ${slug} (${String(r.data.id)})\n`);
  else s.out(`created ${slug} (${type ?? "task"} · ${status} · ${priority ?? "P2"}) — cloud task; artifacts land in ${dir}/ when a run writes them\n`);
  // Server-side warnings (dropped dashboard, off-roster assignee) must reach the
  // operator — the create still succeeded, so stderr, not a failure exit.
  if (typeof r.data.warning === "string") s.err(`warning: ${r.data.warning}\n`);
  return 0;
}

// ---- get ----

export async function runTaskGet(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const id = positional[0];
  if (!id) {
    s.err("usage: loopany get <id|slug> [--runs [--limit N] [--transcript]] [--json]\n");
    return 2;
  }
  const qs = new URLSearchParams({ op: "get", id });
  if (flags["runs"] === true) qs.set("runs", "1");
  if (str(flags, "limit")) qs.set("limit", str(flags, "limit")!);
  if (flags["transcript"] === true) qs.set("transcript", "1");
  if (flags["log"] === true) qs.set("log", "1");
  if (str(flags, "since")) qs.set("since", str(flags, "since")!);
  if (str(flags, "recent")) qs.set("recent", str(flags, "recent")!);
  const r = await api(s, `/api/machine/task?${qs}`);
  if (!r.ok) return apiError(s, r.data, r.status, "get");
  // Working-copy checkout: materialize the doc as `<slug>.md` in the current
  // directory plus a `.base` sidecar recording the content hash — the base a
  // later `loopany update <id> --doc-file <slug>.md` push must present. The
  // sidecar makes the edit→push cycle safe against concurrent server writes.
  if (flags["checkout"] === true) {
    const t = r.data.task as TaskRowWire & { content: string | null; docHash?: string };
    const name = `${t.slug ?? id}.md`;
    const file = `${s.cwd()}/${name}`;
    s.fsImpl.writeFileSync(file, t.content ?? "");
    if (typeof t.docHash === "string") s.fsImpl.writeFileSync(`${file}.base`, `${t.docHash}\n`);
    s.out(`checked out: ${name} (${(t.content ?? "").length} bytes)\nhelp[1]:\n  Edit it, then run \`loopany update ${t.slug ?? id} --doc-file ${name}\` to push\n`);
    return 0;
  }
  if (flags["json"] === true) {
    s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  const task = r.data.task as TaskRowWire & { content: string | null; goal: string | null; notify: string; nextRunAt: string | null };
  const children = (r.data.children as TaskRowWire[]) ?? [];
  s.out(`── ${rowLine(task)}\n`);
  const meta: string[] = [];
  if (task.owner) meta.push(`owner: ${task.owner}`);
  if (task.parent) meta.push(`parent: ${task.parent}`);
  const refs = (task as { refs?: string[] | null }).refs;
  if (refs?.length) meta.push(`refs: ${refs.join(", ")}`);
  if (task.goal) meta.push(`goal: ${task.goal}`);
  if (task.nextRunAt) meta.push(`next: ${task.nextRunAt}`);
  if (meta.length) s.out(`   ${meta.join(" · ")}\n`);
  if (task.taskFile) s.out(`   file: ${task.taskFile}\n`);
  // Compact envelope line (`get` absorbed `show`): the settings that don't
  // already ride the row/meta lines, plus presence hints for the large content
  // fields. `--json` carries the FULL envelope for the edit roundtrip.
  const env = r.data.envelope as Record<string, unknown> | undefined;
  if (env) {
    const present = (v: unknown) => (typeof v === "string" && v.length ? `present (${v.length}B)` : "absent");
    const parts = [
      `notify=${String(env.notify)}`,
      `agent=${String(env.agent)}`,
      ...(env.model ? [`model=${String(env.model)}`] : []),
      ...(env.allowControl === false ? ["allowControl=false"] : []),
      `workflow ${present(env.workflow)}`,
      `ui ${present(env.ui)}`,
    ];
    s.out(`   config: ${parts.join(" · ")}\n`);
  }
  // Doc preview: truncated by default (the doc can be an ops manual) with the
  // total visible and a --full escape hatch; --json always carries it complete.
  // The doc's legacy `## Timeline` section is stripped from DISPLAY — the
  // merged events timeline below is the one record (checkout/push still use
  // the raw bytes, so the base-hash contract is untouched).
  if (task.content) {
    const DOC_PREVIEW = 1000;
    // Prefer the server's split doc (ONE Timeline grammar, docSplit.ts); the
    // local strip is only the old-server fallback.
    const serverDoc = typeof r.data.doc === "string" ? r.data.doc : null;
    const body = (serverDoc ?? stripTimelineSection(task.content)).trim();
    if (flags["full"] === true || body.length <= DOC_PREVIEW) {
      s.out(`\n${body}\n`);
    } else {
      s.out(`\n${body.slice(0, DOC_PREVIEW)}\n… (truncated, ${body.length} chars total — use --full)\n`);
    }
  }
  // The ONE timeline (server-merged: events ∪ legacy doc lines, chronological)
  // — always rendered, so `note`/status changes are visible in plain `get`
  // without knowing about --log. Bounded to the newest entries; --log is the
  // full record plane with types/actors/totals.
  const timeline = r.data.timeline as Array<{ at: string | null; actor: string | null; text: string | null }> | undefined;
  if (timeline?.length) {
    const TL_CAP = 10;
    const shown = timeline.slice(-TL_CAP);
    s.out(`\n── timeline (${timeline.length})\n`);
    for (const e of shown) {
      s.out(`   ${e.at ? e.at.slice(0, 10) : "········"} | ${e.text ?? ""}${e.actor && !e.actor.startsWith("agent:") ? ` (${e.actor})` : ""}\n`);
    }
    if (timeline.length > TL_CAP) s.out(`   … loopany get ${id} --log for the full record\n`);
  }
  // Rollup (recurring parents): children grouped by status — counts always,
  // a few named per open group; done/archived stay a count, never a list.
  const rollup = r.data.rollup as Array<{ status: string; count: number; top?: string[] }> | undefined;
  if (rollup?.length) {
    s.out(`\n── children by status\n`);
    for (const g of rollup) {
      s.out(`   ${g.status}: ${g.count}${g.top?.length ? ` — ${g.top.join(", ")}${g.count > g.top.length ? ", …" : ""}` : ""}\n`);
    }
  }
  // (recentEvents stays in the body for --json consumers; the merged timeline
  // above superseded its render.)
  if (children.length) {
    s.out(`\n── children (${children.length}${r.data.childrenTruncated ? `, +${r.data.childrenTruncated} more` : ""})\n`);
    for (const c of children) s.out(`   ${rowLine(c)}\n`);
    if (r.data.childrenTruncated) s.out(`   … loopany list ${id}\n`);
  }
  // The record plane (--log): bounded newest-first + definitive empty state +
  // the `count: N of M` aggregate so truncation is visible (AXI conventions).
  if (flags["log"] === true) {
    const evs = (r.data.events as Array<Record<string, unknown>> | undefined) ?? [];
    const total = typeof r.data.eventsTotal === "number" ? r.data.eventsTotal : evs.length;
    if (!evs.length) {
      s.out(`\nevents: 0${str(flags, "since") ? ` since ${str(flags, "since")}` : ""} — the absence of events is the answer\n`);
    } else {
      s.out(`\nevents: ${evs.length} of ${total} total\n`);
      for (const e of evs) {
        const summary = typeof e.text === "string" && e.text ? e.text : e.data ? JSON.stringify(e.data) : "";
        s.out(`  ${String(e.at).slice(0, 16)}  ${String(e.type)}  ${String(e.actor)}  ${summary.slice(0, 140)}\n`);
      }
      if (evs.length < total) s.out(`  … Run \`loopany get ${id} --log --recent ${total}\` for all ${total}\n`);
    }
  }
  const runs = r.data.runs as Array<Record<string, unknown>> | undefined;
  if (runs) {
    s.out(`\n── runs (${runs.length})\n`);
    for (const run of runs) {
      const dur = typeof run.durationMs === "number" ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : "";
      s.out(`   ● ${String(run.ts)}  ${String(run.role)}  ${String(run.outcome ?? run.phase)}${dur}${run.message ? `  ${String(run.message)}` : ""}\n`);
      if (flags["transcript"] === true && typeof run.transcript === "string" && run.transcript) s.out(`${run.transcript}\n`);
    }
  }
  return 0;
}

// ---- list ----

export async function runTaskList(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  // `--fields a,b` extends the slim default columns (fail-loud on unknowns).
  let fields: Set<string> | undefined;
  const fieldsFlag = str(flags, "fields");
  if (fieldsFlag !== undefined) {
    const wanted = fieldsFlag.split(",").map((f) => f.trim()).filter(Boolean);
    const unknown = wanted.filter((f) => !(LIST_OPTIONAL_FIELDS as readonly string[]).includes(f));
    if (unknown.length) {
      s.err(`loopany: unknown field(s): ${unknown.join(", ")} — available: ${LIST_OPTIONAL_FIELDS.join(", ")}\n`);
      return 2;
    }
    fields = new Set(wanted);
  }
  const qs = new URLSearchParams({ op: "list" });
  if (positional[0]) qs.set("id", positional[0]);
  for (const k of ["status", "priority", "depth", "team", "assignee"] as const) if (str(flags, k)) qs.set(k, str(flags, k)!);
  for (const k of ["due", "recurring", "tree", "flat", "here"] as const) if (flags[k] === true) qs.set(k, "1");
  const r = await api(s, `/api/machine/task?${qs}`);
  if (!r.ok) return apiError(s, r.data, r.status, "list");
  if (flags["json"] === true) {
    s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  const ctx: ScopeCtx = {
    requester: typeof r.data.requester === "string" ? r.data.requester : undefined,
    machines: (r.data.machines as Record<string, string> | undefined) ?? undefined,
  };
  if (r.data.mode === "tree") {
    const tree = r.data.tree as TaskTreeNodeWire[];
    if (!tree.length) {
      s.out("no tasks yet — loopany create \"<title>\" starts one\n");
      return 0;
    }
    renderTree(tree, s.out, ctx, fields);
  } else {
    const rows = r.data.rows as TaskRowWire[];
    if (!rows.length) {
      s.out("no tasks match\n");
      return 0;
    }
    for (const row of rows) {
      const crumb = row.breadcrumb?.length ? `${row.breadcrumb.join(" › ")} › ` : "";
      s.out(`${crumb}${rowLine(row, ctx, fields)}\n`);
    }
  }
  return 0;
}

// ---- search ----

export async function runTaskSearch(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const q = positional.join(" ").trim();
  if (!q) {
    s.err("usage: loopany search <keywords>\n");
    return 2;
  }
  const r = await api(s, `/api/machine/task?op=search&q=${encodeURIComponent(q)}`);
  if (!r.ok) return apiError(s, r.data, r.status, "search");
  if (flags["json"] === true) {
    s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  const rows = r.data.rows as TaskRowWire[];
  const artifacts = (r.data.artifacts as Array<{ task: string; path: string; title: string | null; snippet: string | null }> | undefined) ?? [];
  if (!rows.length && !artifacts.length) {
    s.out("no matching tasks or artifacts\n");
    return 0;
  }
  for (const row of rows) {
    s.out(`${rowLine(row)}\n`);
    if (row.snippet) s.out(`   ${row.snippet}\n`);
  }
  if (r.data.truncated) s.out(`… ${String(r.data.truncated)} more — narrow the keywords\n`);
  // Artifact hits (F5): the loops' products — where "did a loop already write
  // this up?" actually lives. Grouped after the task hits, one line per file.
  if (artifacts.length) {
    s.out(`\n── artifacts (${artifacts.length}${r.data.artifactsTruncated ? `, +${String(r.data.artifactsTruncated)} more` : ""})\n`);
    for (const a of artifacts) {
      s.out(`   ${a.task} :: ${a.path}${a.title ? `  —  ${a.title}` : ""}\n`);
      if (a.snippet) s.out(`      ${a.snippet}\n`);
    }
  }
  if (r.data.artifactScanTruncated) s.out(`   (artifact scan capped — results may be incomplete; narrow the keywords)\n`);
  return 0;
}

// ---- update ----

/** Envelope keys forwarded to PATCH /api/machine/loop (server = sole validator). */
const ENVELOPE_KEYS = new Set(["cron", "timezone", "tz", "notify", "model", "goal", "name", "enabled", "allowControl", "runAt"]);

export async function runTaskUpdate(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const id = positional[0];
  if (!id) {
    s.err('usage: loopany update <id|slug> [key=value …] [--note "<timeline line>"] [--workflow-file F] [--ui-file F] [--schema-file F] [--dry-run] [--json]\n');
    return 2;
  }

  // key=value pairs from the remaining positionals.
  const workState: Record<string, string | null> = {};
  const envelope: Record<string, unknown> = {};
  for (const kv of positional.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      s.err(`loopany: expected key=value, got '${kv}'\n`);
      return 2;
    }
    const key = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    const value = raw === "null" || raw === "" ? null : raw;
    // `assignee` is TWO-typed, split on what the value IS: an email (`@`) = the
    // HUMAN (front matter); null = clear the human; anything else — registry
    // slug, agent name/id, `<machine>/<runtime>` — = the EXECUTOR (a server-side
    // re-bind operation the server resolves; a miss returns a teaching 400
    // listing your agents). The old split keyed on "/" only, which silently
    // wrote the roster's own advertised slugs into front matter as "humans".
    if (key === "assignee" && typeof value === "string" && !value.includes("@")) {
      envelope["assignee"] = value;
      continue;
    }
    if (key === "status" && value === "review") {
      // Retired spelling — canonicalize on write so new files carry follow-up.
      workState[key] = "follow-up";
    } else if (WORK_STATE_KEYS.has(key)) workState[key] = value;
    else if (ENVELOPE_KEYS.has(key)) {
      const mapped = key === "tz" ? "timezone" : key;
      envelope[mapped] = key === "enabled" || key === "allowControl" ? value === "true" : value;
    } else {
      s.err(
        `loopany: unknown field '${key}' — work-state: ${[...WORK_STATE_KEYS].join(", ")}; envelope: ${[...ENVELOPE_KEYS].join(", ")}\n`,
      );
      return 2;
    }
  }
  // Enum validation with enumerating errors (client-side; the file is ours to write).
  const checks: Array<[string, readonly string[]]> = [
    ["status", TASK_STATUSES],
    ["priority", TASK_PRIORITIES],
    ["type", TASK_TYPES],
  ];
  for (const [key, allowed] of checks) {
    const v = workState[key];
    if (typeof v === "string" && !allowed.includes(v)) {
      s.err(`loopany: ${key} must be one of: ${allowed.join(", ")} (got: '${v}')\n`);
      return 2;
    }
  }

  // Content-file trio → envelope fields, same as `loopany edit`. Paths are
  // cwd-fenced (filefence.ts): a /tmp path shared across runs could silently
  // feed a stale file's content into this task's workflow/ui/schema.
  const allowExternal = flags["allow-external-file"] === true;
  for (const [flagName, field] of [
    ["workflow-file", "workflow"],
    ["ui-file", "ui"],
    ["schema-file", "stateSchema"],
  ] as const) {
    const p = str(flags, flagName);
    if (p !== undefined) {
      const fenced = fenceFileFlag(`--${flagName}`, p, s.cwd(), allowExternal);
      if (fenced) {
        s.err(fenced);
        return 2;
      }
      try {
        const raw = s.fsImpl.readFileSync(p, "utf8");
        envelope[field] = field === "stateSchema" ? JSON.parse(raw) : raw;
      } catch (e) {
        s.err(`loopany: cannot read ${p}: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
    }
  }

  // Doc push: `--doc-file <path>` sends the working copy back with its base hash
  // (the `.base` sidecar `get --checkout` wrote, or an explicit `--doc-base`).
  // An OPERATION with its own server-side guards — sent alone, like assignee.
  const docFile = str(flags, "doc-file");
  if (docFile !== undefined) {
    if (Object.keys(workState).length || Object.keys(envelope).length || str(flags, "note")) {
      s.err("loopany: --doc-file is a doc push — send it alone (field/note changes are separate updates)\n");
      return 2;
    }
    const fenced = fenceFileFlag("--doc-file", docFile, s.cwd(), allowExternal);
    if (fenced) {
      s.err(fenced);
      return 2;
    }
    let doc: string;
    try {
      doc = s.fsImpl.readFileSync(docFile, "utf8");
    } catch (e) {
      s.err(`loopany: cannot read ${docFile}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    let docBase = str(flags, "doc-base");
    if (!docBase) {
      try {
        docBase = s.fsImpl.readFileSync(`${docFile}.base`, "utf8").trim();
      } catch {
        s.err(`loopany: no base hash for ${docFile} — check the doc out first (loopany get ${id} --checkout) or pass --doc-base <hash>\n`);
        return 2;
      }
    }
    const got = await api(s, `/api/machine/task?op=get&id=${encodeURIComponent(id)}`);
    if (!got.ok) return apiError(s, got.data, got.status, "update");
    const t = got.data.task as TaskRowWire;
    const push = await api(s, "/api/machine/loop", { method: "PATCH", body: { id: t.loopId, patch: { doc, docBase }, dryRun: flags["dry-run"] === true } });
    if (!push.ok) {
      // A stale base carries the server-vs-submitted diff — show it, it IS the merge input.
      if (push.status === 409 && typeof push.data.diff === "string") s.err(`${push.data.diff}\n`);
      return apiError(s, push.data, push.status, "doc push");
    }
    // Advance the sidecar so the next edit round pushes from the fresh base.
    if (typeof push.data.docHash === "string" && flags["dry-run"] !== true) {
      s.fsImpl.writeFileSync(`${docFile}.base`, `${push.data.docHash}\n`);
    }
    s.out(`${typeof push.data.text === "string" ? push.data.text : "doc: updated"}\n`);
    return 0;
  }

  const note = str(flags, "note");
  if (!Object.keys(workState).length && !Object.keys(envelope).length && !note) {
    s.err("loopany: nothing to change\n");
    return 2;
  }

  // Resolve the task (need its taskFile for local edits + loop id for the PATCH).
  const got = await api(s, `/api/machine/task?op=get&id=${encodeURIComponent(id)}`);
  if (!got.ok) return apiError(s, got.data, got.status, "update");
  const task = got.data.task as TaskRowWire & { content: string | null };

  // Invariants (hard errors, not prose):
  const currentFm = task.taskFile && s.fsImpl.existsSync(task.taskFile) ? readFrontmatter(s.fsImpl.readFileSync(task.taskFile, "utf8")) : {};
  const effectiveFollowUp = workState["follow_up_date"] ?? currentFm["follow_up_date"];
  if (workState["status"] === "follow-up" && !effectiveFollowUp) {
    s.err("loopany: status=follow-up requires a follow_up_date=<YYYY-MM-DD> (when to check whether it worked) — no silent black holes\n");
    return 2;
  }
  const terminal = workState["status"] === "done" || workState["status"] === "archived";
  if (terminal && task.cron && envelope["enabled"] === undefined) {
    envelope["enabled"] = false; // node is source of truth: a terminal task pauses its schedule
  }

  if (flags["dry-run"] === true) {
    if (Object.keys(envelope).length) {
      const r = await api(s, "/api/machine/loop", { method: "PATCH", body: { id: task.loopId, patch: envelope, dryRun: true } });
      if (!r.ok) return apiError(s, r.data, r.status, "update dry-run");
      s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    }
    if (Object.keys(workState).length || note) {
      s.out(`would edit ${task.taskFile ?? "(no file)"}: ${JSON.stringify({ ...workState, ...(note ? { note } : {}) })}\n`);
    }
    return 0;
  }

  // 1) Work-state + timeline → the FILE (source of truth). The new content also
  // rides the server PATCH below, so the tree index refreshes immediately even
  // when the daemon/watcher isn't running right now.
  if (Object.keys(workState).length || note) {
    const hasLocalFile = !!task.taskFile && s.fsImpl.existsSync(task.taskFile);
    if (hasLocalFile) {
      // Legacy file-era row: the local README exists — edit it (the write also
      // rides the PATCH below so the tree index refreshes immediately).
      let content = s.fsImpl.readFileSync(task.taskFile!, "utf8");
      if (Object.keys(workState).length) content = patchFrontmatter(content, workState);
      if (note) content = appendTimeline(content, note, { actor: s.actor });
      else if (Object.keys(workState).length) {
        const summary = Object.entries(workState)
          .map(([k, v]) => `${k} → ${v ?? "(cleared)"}`)
          .join(", ");
        content = appendTimeline(content, summary, { actor: s.actor });
      }
      s.fsImpl.writeFileSync(task.taskFile!, content);
      envelope["taskFileContent"] = content;
    } else {
      // Cloud-born task (or a row homed on another machine): patch the SERVER
      // copy — the doc is the source of truth, no local file required.
      if (Object.keys(workState).length) {
        const serverContent = (task as { content?: string | null }).content ?? "";
        envelope["taskFileContent"] = patchFrontmatter(serverContent, workState);
      }
      if (note) {
        const noted = await api(s, "/api/machine/cli", { method: "POST", body: { argv: ["note", id, note] } });
        if (!noted.ok) return apiError(s, noted.data, noted.status, "note");
      }
    }
  }

  // 2) Envelope → the server (same PATCH path as `loopany edit`).
  let serverBody: Record<string, unknown> = {};
  if (Object.keys(envelope).length) {
    const r = await api(s, "/api/machine/loop", { method: "PATCH", body: { id: task.loopId, patch: envelope } });
    if (!r.ok) return apiError(s, r.data, r.status, "update");
    serverBody = r.data;
  }

  // taskFileContent is the internal index-refresh push, not a user-named field.
  const applied = [...Object.keys(workState), ...Object.keys(envelope).filter((k) => k !== "taskFileContent"), ...(note ? ["note"] : [])];
  if (flags["json"] === true) {
    s.out(`${JSON.stringify({ ok: true, id: task.loopId, slug: task.slug, applied, ...serverBody }, null, 2)}\n`);
    return 0;
  }
  s.out(`updated ${task.slug ?? task.loopId} (${applied.join(", ")})\n`);
  // Server-side warnings (e.g. an off-roster human assignee) surface on stderr —
  // the update applied, so this is advice, not a failure.
  if (typeof serverBody.warning === "string") s.err(`warning: ${serverBody.warning}\n`);
  // Teaching hint (e.g. "status alone never dispatches") — stdout, it's help.
  if (typeof serverBody.hint === "string") s.out(`hint: ${serverBody.hint}\n`);
  // An executor assignment's outcome must be VISIBLE: whether a run dispatched,
  // and if not, why — silence here would make auto-dispatch feel haunted.
  if (typeof serverBody.assignee === "string") {
    const why = typeof serverBody.note === "string" ? ` (${serverBody.note})` : "";
    s.out(serverBody.dispatched === true ? `→ ${serverBody.assignee} · run dispatched\n` : `→ ${serverBody.assignee} · not dispatched${why}\n`);
  }
  return 0;
}

// ---- mv ----

export async function runTaskMv(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const id = positional[0];
  const before = str(flags, "before");
  const after = str(flags, "after");
  const priority = str(flags, "priority");
  const top = flags["top"] === true;
  const bottom = flags["bottom"] === true;
  if (!id || [before, after, priority, top || undefined, bottom || undefined].filter((x) => x !== undefined).length !== 1) {
    s.err("usage: loopany mv <id|slug> --before <sib> | --after <sib> | --top | --bottom | --priority P0-P3\n");
    return 2;
  }
  if (priority && !TASK_PRIORITIES.includes(priority as never)) {
    s.err(`loopany: priority must be one of: ${TASK_PRIORITIES.join(", ")} (got: '${priority}')\n`);
    return 2;
  }

  const got = await api(s, `/api/machine/task?op=get&id=${encodeURIComponent(id)}`);
  if (!got.ok) return apiError(s, got.data, got.status, "mv");
  const task = got.data.task as TaskRowWire;
  if (!task.taskFile || !s.fsImpl.existsSync(task.taskFile)) {
    s.err(`loopany: task file not found locally (${task.taskFile ?? "unset"})\n`);
    return 2;
  }

  // Sibling band: same parent + same (target) priority, ordered as the server sorts.
  const flat = await api(s, `/api/machine/task?op=list&flat=1`);
  if (!flat.ok) return apiError(s, flat.data, flat.status, "mv");
  const all = (flat.data.rows as TaskRowWire[]) ?? [];
  const bandPriority = priority ?? task.priority;
  const band = all
    .filter((r) => r.loopId !== task.loopId && r.parent === task.parent && (r.priority ?? null) === (bandPriority ?? null))
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  // Fractional order: touch ONE file in the common case (midpoint insert).
  const orderOf = (r: TaskRowWire | undefined): number | null => r?.order ?? null;
  let newOrder: number;
  if (before !== undefined || after !== undefined) {
    const anchorId = (before ?? after)!;
    const idx = band.findIndex((r) => r.slug === anchorId || r.loopId === anchorId);
    if (idx < 0) {
      s.err(`loopany: '${anchorId}' is not a sibling in the same band (same parent + priority)\n`);
      return 2;
    }
    const lo = before !== undefined ? orderOf(band[idx - 1]) : orderOf(band[idx]);
    const hi = before !== undefined ? orderOf(band[idx]) : orderOf(band[idx + 1]);
    const loV = lo ?? (hi ?? 2) - 2;
    const hiV = hi ?? (lo ?? 0) + 2;
    newOrder = (loV + hiV) / 2;
    if (Math.abs(hiV - loV) < 1e-6) {
      s.err("loopany: the order gap collapsed — run `loopany mv --top` on the first sibling to re-space, then retry\n");
      return 2;
    }
  } else if (top) {
    const first = orderOf(band[0]);
    newOrder = first === null ? 1 : first - 1;
  } else {
    const last = orderOf(band[band.length - 1]);
    newOrder = last === null ? 1 : last + 1;
  }

  const patch: Record<string, string | null> = { order: String(newOrder) };
  if (priority) patch.priority = priority;
  const content = patchFrontmatter(s.fsImpl.readFileSync(task.taskFile, "utf8"), patch);
  s.fsImpl.writeFileSync(task.taskFile, content);
  // Push the new content so ordering is visible in the tree immediately.
  const pushed = await api(s, "/api/machine/loop", { method: "PATCH", body: { id: task.loopId, patch: { taskFileContent: content } } });
  if (!pushed.ok) return apiError(s, pushed.data, pushed.status, "mv");
  if (flags["json"] === true) s.out(`${JSON.stringify({ ok: true, id: task.loopId, order: newOrder, ...(priority ? { priority } : {}) })}\n`);
  else s.out(`moved ${task.slug ?? task.loopId}${priority ? ` → ${priority}` : ""} (order ${newOrder})\n`);
  return 0;
}

// ---- run ----

export async function runTaskRun(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  const id = positional[0];
  if (!id) {
    s.err("usage: loopany run <id|slug> [--wait]\n");
    return 2;
  }
  const startedAt = s.now();
  const r = await api(s, "/api/machine/loop/run", { method: "POST", body: { id } });
  if (!r.ok) return apiError(s, r.data, r.status, "run");
  const loopId = String(r.data.id);
  // The server echoes the EXECUTING machine's presence: not-online means no
  // daemon will claim the run right now — it parks as pending until one
  // connects. Say so up front, and never sit in a wait loop nothing can end.
  const host = r.data.machine as { name?: string; presence?: string } | undefined;
  const offline = !!host?.presence && host.presence !== "online";
  if (offline) {
    s.err(`loopany: ${host!.name ?? "the task's machine"} is ${host!.presence} — the run stays queued until its daemon connects (loopany up there, then loopany get ${id} --runs)\n`);
  }
  // One exit block: no --wait, OR --wait against a machine that can't claim —
  // waiting on an offline machine is a loop nothing can end.
  if (flags["wait"] !== true || offline) {
    if (flags["json"] === true) s.out(`${JSON.stringify(r.data)}\n`);
    else s.out(`dispatched ${String(r.data.name ?? loopId)}${offline && flags["wait"] === true ? " (queued — not waiting on an offline machine)" : ` — loopany get ${id} --runs to see the outcome`}\n`);
    return 0;
  }

  // --wait: poll the run log (bounded ~10min, exponential-ish backoff) until a
  // run that STARTED after our dispatch reaches a terminal phase.
  const DEADLINE_MS = 10 * 60_000;
  let delay = 3_000;
  while (s.now() - startedAt < DEADLINE_MS) {
    await s.sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
    const log = await api(s, `/api/machine/log?loopId=${encodeURIComponent(loopId)}&limit=1`);
    const runs = (log.data.runs as Array<Record<string, unknown>> | undefined) ?? [];
    const newest = runs[0];
    if (!newest) continue;
    const ts = Date.parse(String(newest.ts));
    if (Number.isFinite(ts) && ts < startedAt - 60_000) continue; // an older run, not ours
    const phase = String(newest.phase);
    if (phase === "done" || phase === "error" || phase === "canceled") {
      if (flags["json"] === true) s.out(`${JSON.stringify(newest, null, 2)}\n`);
      else {
        s.out(`run ${phase}${newest.message ? `: ${String(newest.message)}` : ""}${newest.error ? ` (${String(newest.error)})` : ""}\n`);
      }
      return phase === "done" ? 0 : 1;
    }
  }
  s.err("loopany: still running after 10min — check later with loopany get " + id + " --runs\n");
  return 1;
}

// ---- review (F7: the cross-loop worklist — notice + decide) ----

/** `loopany review` — everything a run flagged `status: needs-review`, across
 *  every loop you can see, minus what you've already marked reviewed.
 *  `loopany review clear <task> <path>` marks one item reviewed ("I've handled
 *  it" — deliberately NOT "approve": nothing downstream consumes the verdict
 *  yet; the item re-surfaces if the file's content changes). */
export async function runTaskReview(argv: string[], injected: TaskDeps = {}): Promise<number> {
  const s = seams(injected);
  if (!s) return (injected.err ?? ((x: string) => process.stderr.write(x)))(NOT_CONNECTED), 2;
  const { positional, flags } = parseArgs(argv);
  if (positional[0] === "clear") {
    const [, task, path] = positional;
    if (!task || !path) {
      s.err("usage: loopany review clear <task> <path>\n");
      return 2;
    }
    const r = await api(s, "/api/machine/task", { method: "POST", body: { op: "review-clear", id: task, path } });
    if (!r.ok) return apiError(s, r.data, r.status, "review clear");
    s.out(`${typeof r.data.text === "string" ? r.data.text : "reviewed"}\n`);
    return 0;
  }
  if (positional.length) {
    s.err("usage: loopany review [--json]  |  loopany review clear <task> <path>\n");
    return 2;
  }
  const r = await api(s, "/api/machine/task?op=review");
  if (!r.ok) return apiError(s, r.data, r.status, "review");
  if (flags["json"] === true) {
    s.out(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  const items = (r.data.items as Array<{ task: string; path: string; title: string | null; type: string | null; due: string | null; updatedAt: string }> | undefined) ?? [];
  if (!items.length) {
    s.out("review queue: empty — nothing is waiting on you\n");
    return 0;
  }
  s.out(`review queue (${items.length} waiting):\n`);
  for (const i of items) {
    const due = i.due ? `  ⏰ ${i.due}` : "";
    s.out(`  ${i.task} :: ${i.path}${i.title ? `  —  ${i.title}` : ""}${due}\n`);
  }
  s.out(`help[1]:\n  Run \`loopany review clear <task> <path>\` after handling one\n`);
  return 0;
}
