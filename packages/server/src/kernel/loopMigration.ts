/**
 * The production-loop migration: every existing `loops` row becomes ONE `objects`
 * row with `kind='loop'` (design §2, spec §5.5).
 *
 * The task side of the rewrite is brand new, so this is the ONLY migration path
 * and it is mechanical.
 *
 * THREE PROPERTIES, all load-bearing:
 *
 *  1. **NEVER DESTRUCTIVE.** The `loops` table is not read-modified, not
 *     truncated, not touched at all — this is a COPY. Until a later unit cuts the
 *     runtime over, `loops` remains the source of truth and the `objects` row is
 *     a shadow. Rolling this back is `DELETE FROM objects WHERE kind='loop'`.
 *  2. **IDEMPOTENT.** Insert-only, through the kernel's create path, so the
 *     primary key swallows a re-run and the `object-created` event's derived id
 *     swallows its own. Running it ten times produces the same rows as running it
 *     once. It deliberately does NOT update an already-migrated row: an update
 *     would overwrite whatever the kernel side has since done to it, which is the
 *     destructive case wearing a helpful hat.
 *  3. **DRY-RUN.** `dryRun: true` computes every planned row and writes nothing,
 *     so the diff is reviewable before it lands.
 *
 * The column mapping is spec §5.5's table verbatim; `charterFromTaskFile` below
 * is the one judgment call in it and is pure + directly unit-tested.
 */
import { asc } from "drizzle-orm";

import { db } from "../db/index.js";
import type { KernelExec } from "../db/kernelStore.js";
import { loops, type Loop } from "../db/schema.js";
import { createObjectIn, type CreateObjectInput } from "./applyTransition.js";
import type { Actor } from "./types.js";

/**
 * The actor stamped on every migrated row's `object-created` event.
 *
 * PROVENANCE NOTE: design §2's entrance set is `clock|answer|human|agent` and has
 * no value for "an operator ran a one-off import". `human` is the honest pick —
 * a person runs this script — and the actor id names the MIGRATION rather than
 * impersonating the loop's owner, so the event log never claims a user did
 * something they did not.
 */
export const MIGRATION_ACTOR: Actor = { entrance: "human", actorId: "migration:loops-to-objects" };

/** Loop columns that map onto a dedicated `objects` column (spec §5.5). */
const MAPPED_COLUMNS = new Set<keyof Loop>([
  "id",
  "teamId",
  "name",
  "cron",
  "timezone",
  "nextRunAt",
  "enabled",
  "createdAt",
  "updatedAt",
]);

/**
 * Loop columns deliberately NOT carried into `payload`. `taskFileContent` is the
 * only one: it can be large, the charter is derived from it into `body`, and the
 * untouched `loops` row remains its source of truth.
 */
const PAYLOAD_EXCLUDED = new Set<keyof Loop>(["taskFileContent"]);

/**
 * A loop's BODY IS ITS CHARTER (design §4), and its standing brief lives in the
 * task file's `## Spec` section (the shipping product's convention). So: take the
 * `## Spec` section when there is one, and the whole file when there is not —
 * spec §5.5's "task file `## Spec` / prompt → body", read literally.
 *
 * Pure, bounded, never throws. A loop with no synced task file migrates with a
 * null body, which is honest: the charter has not been observed yet.
 */
export function charterFromTaskFile(content: string | null | undefined): string | null {
  if (!content) return null;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^##\s+spec\s*$/i.test(l.trim()));
  if (start === -1) {
    const whole = content.trim();
    return whole === "" ? null : whole;
  }
  // Until the next heading at the same level or higher (`#` or `##`).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join("\n").trim();
  return section === "" ? null : section;
}

/**
 * `enabled` / `completedAt` → the loop's operational status (spec §5.5).
 *
 * A production CLOSED loop (`completedAt != null`) maps to `retired`: the rewrite
 * has no closed-loop preset (design §13 defers it), and its `goal` text rides
 * along in `payload.goal` so nothing is lost.
 */
export function statusForLoop(loop: Pick<Loop, "enabled" | "completedAt">): "active" | "paused" | "retired" {
  if (loop.completedAt) return "retired";
  return loop.enabled ? "active" : "paused";
}

/**
 * Everything §5.5 calls "everything else". Null/undefined values are dropped so
 * two runs over the same row build the identical payload (and so the jsonb stays
 * readable — an absent key already means "unset").
 */
export function payloadForLoop(loop: Loop): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(loop)) {
    const key = k as keyof Loop;
    if (MAPPED_COLUMNS.has(key) || PAYLOAD_EXCLUDED.has(key)) continue;
    if (v === null || v === undefined) continue;
    payload[k] = v;
  }
  return Object.keys(payload).length ? payload : null;
}

/**
 * A loop's team. `loops.teamId` is nullable for pre-team rows, which the shipping
 * code backfills as `team-<userId>` — the same fallback is applied here so a
 * migrated row is never team-less (`objects.team_id` is NOT NULL, and team is the
 * scope everything is listed and authorized by).
 */
export function teamForLoop(loop: Pick<Loop, "teamId" | "userId">): string {
  return loop.teamId ?? `team-${loop.userId}`;
}

/** The planned `objects` row for one loop — what a dry run reports. */
export interface PlannedObject {
  id: string;
  teamId: string;
  status: "active" | "paused" | "retired";
  title: string | null;
  cron: string | null;
  timezone: string | null;
  nextFire: string | null;
  bodyBytes: number;
  payloadKeys: string[];
}

/** Build the kernel create input for one loop. Pure — no I/O, no clock. */
export function plan(loop: Loop): { input: CreateObjectInput; planned: PlannedObject } {
  const body = charterFromTaskFile(loop.taskFileContent);
  const payload = payloadForLoop(loop);
  const status = statusForLoop(loop);
  const teamId = teamForLoop(loop);
  const input: CreateObjectInput = {
    // The id is kept VERBATIM (spec §5.5) so run history and artifact paths keep
    // resolving. Production loop ids are already `loop-` prefixed, so this
    // satisfies the kind-prefix rule with no rewriting.
    id: loop.id,
    teamId,
    kind: "loop",
    status,
    actor: MIGRATION_ACTOR,
    // The imported row keeps the loop's own timestamps — a migration must not
    // restamp history as "created today".
    now: loop.createdAt,
    title: loop.name ?? null,
    cron: loop.cron ?? null,
    timezone: loop.timezone ?? null,
    // A paused/retired loop is NOT armed: the cursor is what makes a cadence
    // live, and importing one for a stopped loop would arm it (design §5).
    nextFire: status === "active" ? (loop.nextRunAt ?? null) : null,
    body,
    payload,
  };
  return {
    input,
    planned: {
      id: loop.id,
      teamId,
      status,
      title: loop.name ?? null,
      cron: loop.cron ?? null,
      timezone: loop.timezone ?? null,
      nextFire: input.nextFire ?? null,
      bodyBytes: body ? Buffer.byteLength(body, "utf8") : 0,
      payloadKeys: payload ? Object.keys(payload).sort() : [],
    },
  };
}

export interface MigrationReport {
  dryRun: boolean;
  /** Loop rows examined. */
  scanned: number;
  /** `objects` rows this run inserted. */
  created: number;
  /** Loops that already had an `objects` row — the idempotent no-op. */
  existing: number;
  /** Loops the kernel refused, with the reason. Non-empty is a loud failure, not
   *  a silent skip: the caller decides, and the CLI exits non-zero. */
  refused: { loopId: string; code: string; message: string }[];
  /** The planned rows (always computed, so a real run reports what it did too). */
  planned: PlannedObject[];
}

export interface MigrateOptions {
  dryRun?: boolean;
  /** Restrict to one team (an operator staging the cutover team by team). */
  teamId?: string;
}

/**
 * Run the migration. Each loop is its own transaction: one bad row cannot roll
 * back the whole fleet, and a re-run picks up exactly where the last one stopped
 * (which is what idempotence buys).
 */
export async function migrateLoopsToObjects(options: MigrateOptions = {}): Promise<MigrationReport> {
  const dryRun = options.dryRun ?? false;
  const rows = await db.select().from(loops).orderBy(asc(loops.createdAt));
  const scoped = options.teamId ? rows.filter((l) => teamForLoop(l) === options.teamId) : rows;

  const report: MigrationReport = { dryRun, scanned: scoped.length, created: 0, existing: 0, refused: [], planned: [] };

  for (const loop of scoped) {
    const { input, planned } = plan(loop);
    report.planned.push(planned);
    if (dryRun) continue;

    const result = await db.transaction(async (tx) => createObjectIn(tx as unknown as KernelExec, input));
    if (!result.ok) {
      report.refused.push({ loopId: loop.id, code: result.code, message: result.message });
      continue;
    }
    if (result.created) report.created += 1;
    else report.existing += 1;
  }

  return report;
}
