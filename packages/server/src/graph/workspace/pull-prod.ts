/**
 * Graph v1 workspace demo - the READ-ONLY production pull.
 *
 * Reads one team's real fleet out of the production database and writes a LOCAL
 * JSON snapshot. It is the only thing in this repo that touches production, and
 * it is read-only by construction, at three independent layers:
 *
 *   1. the CONNECTION is opened with `-c default_transaction_read_only=on`, so
 *      the whole session refuses writes at the server;
 *   2. every statement runs inside `sql.begin("read only", …)`, which opens
 *      `BEGIN read only`;
 *   3. this file contains no INSERT / UPDATE / DELETE / DDL text at all - the
 *      query list below is the complete set of statements it can issue.
 *
 * Writes go only to the snapshot file. The replay seeder (`seed-real.ts`) reads
 * THAT, never the network - so rebuilding the local demo is repeatable and does
 * not re-hit production.
 *
 * Usage (from the repo root):
 *   pnpm graph:pull                      # team-superdesign, 14 days
 *   pnpm graph:pull -- --team <id> --days 30 --max-runs 600
 *
 * The connection string is read from `LOOPANY_PROD_DB_URL`, else from the
 * `LOOPANY_DB_URL` line of `LOOPANY_PROD_ENV_FILE` (default:
 * `~/Workspace/loopany-admin/.env`). It is never logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";

import { GATE_FRONT_MATTER_TYPES } from "./specs.js";

export const DEFAULT_TEAM = "team-superdesign";
export const DEFAULT_DAYS = 14;
export const DEFAULT_MAX_RUNS = 600;
/** Newest N artifact files per loop. Support Inbox Triage alone has ~120 report
 *  files; the Library stays readable and the drop is reported, never silent. */
export const DEFAULT_MAX_FILES_PER_LOOP = 20;

// ---- the snapshot shape (the replay seeder's only input) ----

export interface ProdLoop {
  id: string;
  name: string;
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  agent: string | null;
  goal: string | null;
  completedAt: string | null;
  completionReason: string | null;
  taskFile: string | null;
  taskFileContent: string | null;
  state: Record<string, unknown> | null;
  machineId: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
}

export interface ProdRun {
  id: string;
  loopId: string;
  phase: string;
  role: string;
  ts: string;
  outcome: string | null;
  status: string | null;
  message: string | null;
  error: string | null;
  durationMs: number | null;
  costUsd: number | null;
  state: Record<string, unknown> | null;
  sessionId: string | null;
}

export interface ProdFile {
  loopId: string;
  path: string;
  /** sha256 of the file's bytes - the content-addressed key its bytes live under
   *  in the artifact store (`gateway/blobstore.ts` `blobKey`). */
  hash: string;
  size: number;
  binary: boolean;
  updatedAt: string;
  /** The indexed front-matter subset the server parsed at byte ingress. */
  meta: { type?: string; title?: string; date?: string } | null;
}

export interface ProdSnapshot {
  /** Stamped by the puller, not by the demo - the snapshot's own provenance. */
  pulledAt: string;
  source: "loopany-production";
  team: { id: string; name: string };
  window: { days: number; maxRuns: number; maxFilesPerLoop: number };
  machines: number;
  loops: ProdLoop[];
  runs: ProdRun[];
  files: ProdFile[];
  /** Everything the pull deliberately left behind, and why. */
  dropped: { what: string; count: number; why: string }[];
}

// ---- credentials ----

/** Resolve the production URL without ever logging it. */
export function resolveProdUrl(readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): string {
  const direct = process.env.LOOPANY_PROD_DB_URL?.trim();
  if (direct) return direct;
  const envFile =
    process.env.LOOPANY_PROD_ENV_FILE?.trim() || path.join(os.homedir(), "Workspace", "loopany-admin", ".env");
  let text: string;
  try {
    text = readFile(envFile);
  } catch {
    throw new Error(
      `no production URL: set LOOPANY_PROD_DB_URL, or point LOOPANY_PROD_ENV_FILE at a file with LOOPANY_DB_URL (tried ${envFile})`,
    );
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("LOOPANY_DB_URL="));
  const value = line?.slice("LOOPANY_DB_URL=".length).trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`no LOOPANY_DB_URL entry in ${envFile}`);
  return value;
}

// ---- the pull ----

export interface PullOptions {
  team?: string;
  days?: number;
  maxRuns?: number;
  maxFilesPerLoop?: number;
  /** ISO instant stamped on the snapshot. Passed in so the caller owns the clock. */
  now: string;
}

export async function pullProdSnapshot(options: PullOptions): Promise<ProdSnapshot> {
  const teamId = options.team ?? DEFAULT_TEAM;
  const days = options.days ?? DEFAULT_DAYS;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxFilesPerLoop = options.maxFilesPerLoop ?? DEFAULT_MAX_FILES_PER_LOOP;
  const since = new Date(Date.parse(options.now) - days * 86_400_000).toISOString();

  const sql = postgres(resolveProdUrl(), {
    max: 2,
    idle_timeout: 10,
    prepare: false, // the prod URL may be a transaction pooler
    // BELT: the whole SESSION is read-only at the server, so nothing this
    // process does - including a future bug - can write to production.
    connection: { options: "-c default_transaction_read_only=on" },
    onnotice: () => {},
  });

  const dropped: ProdSnapshot["dropped"] = [];

  try {
    // BRACES: and every statement additionally runs in a READ ONLY transaction.
    return await sql.begin("read only", async (tx) => {
      const teamRows = await tx<{ id: string; name: string }[]>`
        select id, name from teams where id = ${teamId}
      `;
      const team = teamRows[0];
      if (!team) throw new Error(`no team ${teamId} in production`);

      const loops = await tx<ProdLoop[]>`
        select
          l.id, l.name, l.cron, l.timezone, l.enabled, l.agent, l.goal,
          l.completed_at        as "completedAt",
          l.completion_reason   as "completionReason",
          l.task_file           as "taskFile",
          l.task_file_content   as "taskFileContent",
          l.state, l.machine_id as "machineId",
          l.created_at          as "createdAt",
          l.updated_at          as "updatedAt",
          (select count(*)::int from runs r where r.loop_id = l.id) as "runCount"
        from loops l
        where l.team_id = ${teamId}
        order by l.created_at asc
      `;

      const totalRuns = (
        await tx<{ n: number }[]>`
          select count(*)::int as n from runs r
          join loops l on l.id = r.loop_id
          where l.team_id = ${teamId}
        `
      )[0]!.n;

      const runs = await tx<ProdRun[]>`
        select
          r.id, r.loop_id as "loopId", r.phase, r.role, r.ts, r.outcome, r.status,
          r.message, r.error, r.duration_ms as "durationMs", r.cost_usd as "costUsd",
          r.state, r.session_id as "sessionId"
        from runs r
        join loops l on l.id = r.loop_id
        where l.team_id = ${teamId} and r.ts >= ${since}
        order by r.ts desc
        limit ${maxRuns}
      `;
      if (totalRuns > runs.length) {
        dropped.push({
          what: "runs",
          count: totalRuns - runs.length,
          why: `outside the ${days}-day window or past the ${maxRuns}-run cap (newest kept)`,
        });
      }

      const allFiles = await tx<ProdFile[]>`
        select
          af.loop_id as "loopId", af.path, af.hash, af.size, af.binary,
          af.updated_at as "updatedAt", b.meta
        from artifact_files af
        join loops l on l.id = af.loop_id
        join blobs b on b.hash = af.hash
        where l.team_id = ${teamId} and af.deleted = false
        order by af.updated_at desc
      `;

      const machines = (
        await tx<{ n: number }[]>`
          select count(distinct l.machine_id)::int as n from loops l
          where l.team_id = ${teamId} and l.machine_id is not null
        `
      )[0]!.n;

      // Per-loop cap, newest first, with ONE exemption that matters: a file whose
      // front-matter type means a person owes something is ALWAYS kept. A loop
      // like Support Inbox Triage has ~120 settled reports and a handful of
      // `needs_human` items, and a plain recency cap would discard exactly the
      // rows the inbox exists to show. Truncating the archive is fine;
      // truncating the waiting list is not.
      //
      // Binary files carry no readable product, so they are dropped rather than
      // shown as an empty document.
      const files: ProdFile[] = [];
      const perLoop = new Map<string, number>();
      let binaryDropped = 0;
      let cappedDropped = 0;
      for (const f of allFiles) {
        if (f.binary) {
          binaryDropped++;
          continue;
        }
        const waiting = f.meta?.type ? GATE_FRONT_MATTER_TYPES.has(f.meta.type) : false;
        if (!waiting) {
          const seen = perLoop.get(f.loopId) ?? 0;
          if (seen >= maxFilesPerLoop) {
            cappedDropped++;
            continue;
          }
          perLoop.set(f.loopId, seen + 1);
        }
        files.push(f);
      }
      if (binaryDropped) dropped.push({ what: "artifact files", count: binaryDropped, why: "binary - no readable product" });
      if (cappedDropped) {
        dropped.push({
          what: "artifact files",
          count: cappedDropped,
          why: `past the ${maxFilesPerLoop}-per-loop cap on SETTLED files (newest kept; anything waiting on a human is exempt)`,
        });
      }

      return {
        pulledAt: options.now,
        source: "loopany-production" as const,
        team: { id: team.id, name: team.name },
        window: { days, maxRuns, maxFilesPerLoop },
        machines,
        loops,
        runs,
        files,
        dropped,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Where the snapshot lands: inside the demo's own gitignored data dir.
 *
 * REFUSES to default. `dataDir()` would fall back to `~/.loopany`, which is the
 * live daemon's home on a developer machine - dropping a snapshot of production
 * data in there is exactly the kind of quiet mistake this demo must not make.
 * `pnpm graph:pull` (repo root) sets the variable; a bare package-level call
 * gets this error instead of a surprise write.
 */
export function snapshotPath(): string {
  const dir = process.env.LOOPANY_DATA_DIR?.trim();
  if (!dir) {
    throw new Error(
      "LOOPANY_DATA_DIR is unset - refusing to write a production snapshot into the default " +
        "loopany home. Run `pnpm graph:pull` from the repo root (it points the demo at its own data dir).",
    );
  }
  return path.join(dir, "prod-snapshot.json");
}

export function readSnapshot(file = snapshotPath()): ProdSnapshot {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ProdSnapshot;
}
