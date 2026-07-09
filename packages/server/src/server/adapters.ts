/**
 * Map the new relational rows (Loop + Run) onto the shapes the UI already
 * renders (JobSummary / JobDetail / RunSummary / JobFull), so the dashboard
 * components stay unchanged while the data now comes from the in-process store.
 */
import { Cron } from "croner";

import * as store from "../db/store.js";
import type { ArtifactFileWithMeta } from "../db/store.js";
import type { Loop, Run } from "../db/schema.js";
import type { ArtifactSummary, JobDetail, JobFull, JobSummary, RunSummary } from "../types.js";
import { machinePresence } from "../lib/machinePresence.js";

const SUMMARY_RUNS = 18;

function nextRun(loop: Loop): string | null {
  if (loop.nextRunAt) return loop.nextRunAt;
  try {
    const probe = new Cron(loop.cron, { paused: true, ...(loop.timezone ? { timezone: loop.timezone } : {}) });
    const n = probe.nextRun()?.toISOString() ?? null;
    probe.stop();
    return n;
  } catch {
    return null;
  }
}

export function toRunSummary(r: Run): RunSummary {
  return {
    id: r.id,
    loopId: r.loopId,
    ts: r.ts,
    running: r.phase === "pending" || r.phase === "running",
    canceled: r.phase === "canceled",
    role: r.role,
    outcome: r.outcome ?? "silent",
    status: r.status ?? null,
    message: r.message ?? null,
    durationMs: r.durationMs ?? null,
    costUsd: r.costUsd ?? null,
    usage: r.usage ?? null,
    error: r.error ?? null,
    state: (r.state as RunSummary["state"]) ?? null,
    control: (r.control as RunSummary["control"]) ?? null,
    sessionId: r.sessionId ?? null,
    artifacts: r.artifacts ?? null,
    progress: (r.progress as RunSummary["progress"]) ?? null,
  };
}

/** One live artifact_files row (with its blob meta joined) → the compact UI shape
 *  (metadata only; the bytes are fetched lazily by getArtifact / the download
 *  route, mirroring getTranscript). The front-matter `meta` rides along so the
 *  Files list + calendar can surface type/title/date without a byte fetch. */
export function toArtifactSummary(row: ArtifactFileWithMeta): ArtifactSummary {
  return {
    path: row.path,
    size: row.size ?? null,
    updatedAt: row.updatedAt,
    binary: row.binary,
    oversize: row.oversize,
    meta: row.meta ?? null,
  };
}

export async function toJobSummary(loop: Loop): Promise<JobSummary> {
  const runs = (await store.listRuns(loop.id, SUMMARY_RUNS)).map(toRunSummary);
  return {
    id: loop.id,
    name: loop.name ?? loop.id,
    cron: loop.cron,
    kind: loop.workflow ? "workflow" : `exec:${loop.agent}`,
    hasUi: !!loop.ui,
    enabled: loop.enabled,
    notify: loop.notify,
    nextRun: nextRun(loop),
    running: await store.hasOpenRun(loop.id),
    lastRunTs: runs.length ? runs[runs.length - 1]!.ts : null,
    graduation: null, // shadow/graduation is post-v1
    goal: loop.goal ?? null,
    completedAt: loop.completedAt ?? null,
    completionReason: loop.completionReason ?? null,
    runs,
    runCount: await store.countRuns(loop.id),
    totalCostUsd: await store.sumRunCost(loop.id),
  };
}

function toJobFull(loop: Loop): JobFull {
  return {
    id: loop.id,
    name: loop.name ?? undefined,
    cron: loop.cron,
    enabled: loop.enabled,
    notify: loop.notify,
    goal: loop.goal ?? null,
    completedAt: loop.completedAt ?? null,
    completionReason: loop.completionReason ?? null,
    taskFile: loop.taskFile ?? undefined,
    workflow: loop.workflow ?? undefined,
    stateSchema: loop.stateSchema ?? undefined,
    ui: loop.ui ?? undefined,
    channelId: loop.channelId ?? null,
    agent: loop.agent,
    exec: {
      // The coding agent this loop executes with (claude-code | codex | grok).
      // The daemon branches spawn + credentials on this value.
      executor: loop.agent,
      workdir: loop.workdir ?? "",
      model: loop.model ?? undefined,
      allowControl: loop.allowControl,
    },
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
}

export async function toJobDetail(loop: Loop): Promise<JobDetail> {
  const fullRuns = (await store.listRuns(loop.id, 100)).map(toRunSummary).reverse(); // newest first
  const m = await store.getMachine(loop.machineId);
  const presence = machinePresence(m?.online, m?.lastSeen);
  return {
    job: toJobFull(loop),
    summary: await toJobSummary(loop),
    taskFileContent: loop.taskFileContent ?? null, // synced from the machine on each run report
    taskFileSyncedAt: loop.taskFileSyncedAt ?? null,
    // `online` gates run/evolve (only a live daemon can execute); `presence`
    // drives the calm asleep-vs-offline dashboard copy.
    machine: { id: loop.machineId, name: m?.name || "", online: presence === "online", presence, lastSeen: m?.lastSeen ?? null },
    runs: fullRuns,
  };
}
