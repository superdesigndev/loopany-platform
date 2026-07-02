/**
 * Map the new relational rows (Loop + Run) onto the shapes the UI already
 * renders (JobSummary / JobDetail / RunSummary / JobFull), so the dashboard
 * components stay unchanged while the data now comes from the in-process store.
 */
import { Cron } from "croner";

import * as store from "../db/store.js";
import type { ArtifactFile, Loop, Run } from "../db/schema.js";
import type { ArtifactSummary, JobDetail, JobFull, JobSummary, RunSummary } from "../types.js";

const SUMMARY_RUNS = 18;
/** Mirrors gateway's ONLINE_TTL_MS — a machine is "online" only if it polled recently. */
const MACHINE_ONLINE_TTL_MS = 30_000;

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
    error: r.error ?? null,
    sample: r.sample ?? null,
    state: (r.state as RunSummary["state"]) ?? null,
    control: (r.control as RunSummary["control"]) ?? null,
    sessionId: r.sessionId ?? null,
    artifacts: r.artifacts ?? null,
    progress: (r.progress as RunSummary["progress"]) ?? null,
  };
}

/** One live artifact_files row → the compact UI shape (metadata only; the bytes
 *  are fetched lazily by getArtifact / the download route, mirroring getTranscript). */
export function toArtifactSummary(row: ArtifactFile): ArtifactSummary {
  return {
    path: row.path,
    size: row.size ?? null,
    updatedAt: row.updatedAt,
    binary: row.binary,
    oversize: row.oversize,
  };
}

export function toJobSummary(loop: Loop): JobSummary {
  const runs = store.listRuns(loop.id, SUMMARY_RUNS).map(toRunSummary);
  return {
    id: loop.id,
    name: loop.name ?? loop.id,
    cron: loop.cron,
    kind: loop.workflow ? "workflow" : `exec:${loop.agent}`,
    hasUi: !!loop.ui,
    enabled: loop.enabled,
    notify: loop.notify,
    nextRun: nextRun(loop),
    running: store.hasOpenRun(loop.id),
    lastRunTs: runs.length ? runs[runs.length - 1]!.ts : null,
    graduation: null, // shadow/graduation is post-v1
    goal: loop.goal ?? null,
    completedAt: loop.completedAt ?? null,
    completionReason: loop.completionReason ?? null,
    runs,
    runCount: store.countRuns(loop.id),
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
      // The recorded coding agent (claude-code | codex), no longer hardcoded.
      // Recording-only: a `codex` loop is still executed by the daemon via Claude.
      executor: loop.agent,
      workdir: loop.workdir ?? "",
      model: loop.model ?? undefined,
      allowControl: loop.allowControl,
    },
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
  };
}

export function toJobDetail(loop: Loop): JobDetail {
  const fullRuns = store.listRuns(loop.id, 100).map(toRunSummary).reverse(); // newest first
  const m = store.getMachine(loop.machineId);
  const online =
    !!m?.online && !!m.lastSeen && Date.now() - Date.parse(m.lastSeen) < MACHINE_ONLINE_TTL_MS;
  return {
    job: toJobFull(loop),
    summary: toJobSummary(loop),
    taskFileContent: loop.taskFileContent ?? null, // synced from the machine on each run report
    taskFileSyncedAt: loop.taskFileSyncedAt ?? null,
    machine: { id: loop.machineId, name: m?.name || "", online },
    runs: fullRuns,
  };
}
