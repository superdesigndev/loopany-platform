/**
 * Convergence S3: materialize every kernel loop as THE production loop.
 *
 * This is the reverse of `loopMigration.ts`, but it is deliberately not a
 * generic bidirectional sync. It is a one-time, insert-only cutover:
 *
 *  - the production row keeps the kernel id verbatim, so watcher/creator/event
 *    references need no rewrite;
 *  - the kernel loop object remains in place for history dual-read until S5;
 *  - the charter is materialized as `<workdir>/loopany-task.md`, which gives the
 *    production daemon a real task file to watch and sync;
 *  - an already-converged id is a no-op. Nothing is updated or overwritten.
 *
 * The database and filesystem cannot share a transaction. The file therefore
 * lands first with exclusive-create semantics. If the DB write fails, a retry
 * recognizes the exact bytes and continues; a different existing file is a
 * loud refusal, never an overwrite.
 */
import fs from "node:fs";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { objects, type KernelObject } from "../db/kernel-schema.js";
import type { KernelExec } from "../db/kernelStore.js";
import { loops, machines, type Loop, type Machine, type NewLoop } from "../db/schema.js";
import { teamIdForUser } from "../db/store.js";
import { appendOrganicEvent } from "./applyTransition.js";

export const CONVERGE_ACTOR_ID = "migration:converge-loops";
export const CONVERGED_TASK_FILE = "loopany-task.md";

export interface ConvergeFileOps {
  stat(path: string): { isDirectory(): boolean };
  read(path: string): string;
  writeExclusive(path: string, content: string): void;
}

const realFiles: ConvergeFileOps = {
  stat: (target) => fs.statSync(target),
  read: (target) => fs.readFileSync(target, "utf8"),
  writeExclusive: (target, content) => fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
};

/** The production task file, with the kernel charter preserved verbatim under
 * the one authoritative `## Spec` heading. */
export function taskFileFromKernelLoop(loop: Pick<KernelObject, "id" | "title" | "body">): string {
  const heading = (loop.title ?? loop.id).replace(/\s+/g, " ").trim() || loop.id;
  const body = loop.body ?? "";
  return `# ${heading}\n\n## Spec\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

export interface ConvergePlan {
  id: string;
  name: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  machineId: string;
  userId: string;
  teamId: string;
  workdir: string;
  taskFile: string;
  taskFileBytes: number;
}

/** Build the exact production-row mapping. `loops.cron` predates on-demand
 * kernel loops and is NOT NULL, so a kernel null is represented by the empty
 * expression. Croner rejects it and the loop remains manual-only, preserving
 * the kernel's absence of cadence without inventing a schedule. */
export function planConvergedLoop(loop: KernelObject, machine: Machine): { row: NewLoop; plan: ConvergePlan; taskFileContent: string } {
  if (loop.kind !== "loop") throw new Error(`${loop.id} is a ${loop.kind}, not a loop`);
  if (!loop.workdir || !path.isAbsolute(loop.workdir)) {
    throw new Error(`${loop.id} has no absolute workdir; its production task file has nowhere honest to live`);
  }
  const teamId = machine.teamId ?? teamIdForUser(machine.userId);
  if (loop.teamId !== teamId) {
    throw new Error(`${loop.id} belongs to ${loop.teamId}, but the stack machine belongs to ${teamId}`);
  }
  const taskFile = path.join(loop.workdir, CONVERGED_TASK_FILE);
  const taskFileContent = taskFileFromKernelLoop(loop);
  const cron = loop.cron ?? "";
  const row: NewLoop = {
    id: loop.id,
    userId: machine.userId,
    teamId,
    machineId: machine.id,
    name: loop.title,
    cron,
    timezone: loop.timezone,
    workdir: loop.workdir,
    taskFile,
    taskFileContent,
    taskFileSyncedAt: loop.updatedAt,
    enabled: loop.status === "active",
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
  return {
    row,
    taskFileContent,
    plan: {
      id: loop.id,
      name: loop.title,
      cron,
      timezone: loop.timezone,
      enabled: loop.status === "active",
      machineId: machine.id,
      userId: machine.userId,
      teamId,
      workdir: loop.workdir,
      taskFile,
      taskFileBytes: Buffer.byteLength(taskFileContent, "utf8"),
    },
  };
}

export interface ConvergeReport {
  dryRun: boolean;
  machineId: string | null;
  scanned: number;
  created: number;
  existing: number;
  filesCreated: number;
  filesReused: number;
  refused: { loopId: string; message: string }[];
  planned: ConvergePlan[];
}

export interface ConvergeOptions {
  dryRun?: boolean;
  teamId?: string;
  files?: ConvergeFileOps;
}

function oneMachine(rows: Machine[]): Machine {
  if (rows.length !== 1) {
    throw new Error(`kernel:converge-loops requires exactly one stack machine; found ${rows.length}`);
  }
  return rows[0]!;
}

function materializeTaskFile(files: ConvergeFileOps, plan: ConvergePlan, content: string): "created" | "reused" {
  const stat = files.stat(plan.workdir);
  if (!stat.isDirectory()) throw new Error(`${plan.workdir} is not a directory`);
  try {
    files.writeExclusive(plan.taskFile, content);
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const existing = files.read(plan.taskFile);
    if (existing !== content) {
      throw new Error(`${plan.taskFile} already exists with different bytes; refusing to overwrite it`);
    }
    return "reused";
  }
}

/** Run the S3 cutover. Each loop is isolated so one malformed workdir cannot
 * hide the rest of the plan, and a rerun safely picks up after a partial pass. */
export async function convergeKernelLoops(options: ConvergeOptions = {}): Promise<ConvergeReport> {
  const dryRun = options.dryRun ?? false;
  const files = options.files ?? realFiles;
  const machine = oneMachine(await db.select().from(machines));
  const kernelRows = await db
    .select()
    .from(objects)
    .where(and(eq(objects.kind, "loop"), ...(options.teamId ? [eq(objects.teamId, options.teamId)] : [])))
    .orderBy(asc(objects.createdAt));

  const report: ConvergeReport = {
    dryRun,
    machineId: machine.id,
    scanned: kernelRows.length,
    created: 0,
    existing: 0,
    filesCreated: 0,
    filesReused: 0,
    refused: [],
    planned: [],
  };

  for (const kernelLoop of kernelRows) {
    try {
      const planned = planConvergedLoop(kernelLoop, machine);
      report.planned.push(planned.plan);
      if (dryRun) continue;

      // An already-converged id is a no-op — but only if the row IS the twin
      // this plan would create. A same-id FOREIGN row counted as "existing"
      // would leave the kernel loop unconverged while its watchers silently
      // resolved against a stranger's team scoping, reported as a clean pass.
      // Id shapes make a natural collision essentially impossible, so a hit
      // here is a real anomaly and must be REFUSED, never absorbed.
      const existing = (
        await db.select({ id: loops.id, teamId: loops.teamId, machineId: loops.machineId }).from(loops).where(eq(loops.id, kernelLoop.id))
      )[0];
      if (existing) {
        if (existing.teamId !== planned.plan.teamId || existing.machineId !== planned.plan.machineId) {
          throw new Error(
            `${kernelLoop.id} already exists as a production loop bound to team ${existing.teamId}/machine ${existing.machineId}, ` +
              `but this plan targets team ${planned.plan.teamId}/machine ${planned.plan.machineId}; ` +
              `refusing to count a foreign row as converged`,
          );
        }
        report.existing += 1;
        continue;
      }

      const file = materializeTaskFile(files, planned.plan, planned.taskFileContent);
      if (file === "created") report.filesCreated += 1;
      else report.filesReused += 1;

      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as KernelExec;
        const inserted = await tx.insert(loops).values(planned.row).onConflictDoNothing().returning({ id: loops.id });
        if (!inserted[0]) throw new Error(`${kernelLoop.id} became occupied while convergence was running`);
        // Organic provenance must use the attempt-rung mint helper. Calling
        // organicEventId(timestamp) here would silently opt this fact out of
        // collision retry and violate the frozen id discipline.
        await appendOrganicEvent(tx, {
          teamId: planned.plan.teamId,
          objectId: kernelLoop.id,
          kind: "loop-converged",
          origin: "organic",
          entrance: "human",
          actorId: CONVERGE_ACTOR_ID,
          payload: {
            machineId: planned.plan.machineId,
            taskFile: planned.plan.taskFile,
            enabled: planned.plan.enabled,
          },
          ts: new Date().toISOString(),
        });
      });
      report.created += 1;
    } catch (error) {
      report.refused.push({
        loopId: kernelLoop.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/** Narrow type used by tests that compare the inserted production row. */
export type ConvergedLoop = Loop;
