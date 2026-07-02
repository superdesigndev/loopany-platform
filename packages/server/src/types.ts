/**
 * Shapes returned by the c0 daemon's loopback API (src/scheduler/api.ts).
 * Kept in sync with `summary()` / `detail()` there. The daemon stays the source
 * of truth; the web app never owns job state, it only renders + proxies writes.
 */

/** JSON-serializable value — server fn returns must be serializable (no `unknown`). */
export type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

/** The coding agent a loop is bound to / recorded as its host. Recording-only:
 *  a `codex` loop is still executed by the daemon via Claude for now. */
export type CodingAgent = 'claude-code' | 'codex'

export type RunOutcome = 'error' | 'silent' | 'exec' | 'agent' | 'direct' | string
export type RunStatus =
  | 'nothing-new'
  | 'new'
  | 'resolved'
  | 'error'
  | 'silent'
  | string

export interface RunSummary {
  /** Run row id — lets the detail view fetch this run's trace directly. */
  id: string
  /** The loop this run belongs to — lets the run-detail view resolve its files. */
  loopId: string
  ts: string
  /** In-flight (phase pending/running) — the timeline renders this block pulsing. */
  running?: boolean
  /** Stopped by the user before it finished (phase canceled). */
  canceled?: boolean
  /** Delivery role — lets the UI tint an in-flight evolve pass (blue) vs a normal run. */
  role?: 'exec' | 'evolve' | string
  outcome: RunOutcome
  status: RunStatus | null
  message: string | null
  durationMs: number | null
  error: string | null
  sample: number | string | null
  state: Record<string, Json> | null
  control: Array<{ command: string; args: Json; result: string; detail?: string }> | null
  sessionId: string | null
  /** Files this run's claude session created/edited (transcript-derived, path rel. to workdir). */
  artifacts: Array<{ path: string; kind: 'created' | 'edited' }> | null
  /** Live "what's it doing" signal while running (slim, not the transcript). Null once done. */
  progress?: { step: number; label: string } | null
}

/** A push channel for the Notifications panel + the loop channel picker. Secrets
 *  (bot token / chat id) are NEVER serialized to the client — only this summary. */
export interface ChannelSummary {
  id: string
  type: 'telegram' | 'slack' | string
  name: string
  /** A redacted hint so the row reads as configured without leaking the secret. */
  hint: string
}

/** A connected machine (a teammate's daemon) for the Machines panel. */
export interface MachineSummary {
  id: string
  name: string
  online: boolean
  lastSeen: string | null
  /** Daemon-reported identity (captured on connect). */
  hostname: string | null
  platform: string | null
  arch: string | null
  /** Plaintext device token (so the UI can re-show the connect command). Under
   *  the auth gate it is serialized ONLY to the machine's owner — null for
   *  everyone else (the token fully impersonates the machine). */
  token: string | null
  /** Loops bound to this machine — must be 0 before it can be deleted. */
  loopCount: number
}

export interface JobSummary {
  id: string
  name: string
  cron: string
  kind: string
  /** True when the job carries an agent-authored generative-UI template (Job.ui). */
  hasUi?: boolean
  enabled: boolean
  notify: 'auto' | 'always' | 'never' | string
  nextRun: string | null
  /** True while the daemon is executing this loop right now (live indicator). */
  running?: boolean
  lastRunTs: string | null
  graduation: string | null
  /** CLOSED-loop setpoint (one-line goal). Null ⇒ OPEN loop (monitor/digest). */
  goal?: string | null
  /** Terminal stamp: when the goal was declared met (ISO). Non-null ⇒ Completed
   *  (drives the dashboard split + the "Completed" badge / Reopen action). */
  completedAt?: string | null
  /** One-line reason recorded at completion. */
  completionReason?: string | null
  /** The newest page of runs (chronological, capped) — the card seeds its
   *  timeline from this and lazy-loads older pages via loadOlderRuns. */
  runs: RunSummary[]
  /** Total runs for this loop. The timeline's "+N" pager and the "N runs" label
   *  reflect this, not just the loaded page length. */
  runCount: number
}

/** Per-round observed metric declared on a job, used to label the trend chart. */
export interface StateField {
  key: string
  label?: string
  unit?: string
}

/** The full Job row as stored by the daemon (fields the UI reads/edits). */
export interface JobFull {
  id: string
  name?: string
  cron: string
  enabled: boolean
  notify: 'auto' | 'always' | 'never' | string
  /** CLOSED-loop setpoint (one-line goal); null/absent ⇒ OPEN loop. */
  goal?: string | null
  /** Terminal stamps (set when the loop's goal is declared met). */
  completedAt?: string | null
  completionReason?: string | null
  taskFile?: string
  workflow?: string
  stateSchema?: StateField[]
  /** Generative-UI template (agent-authored HTML; see LoopView). */
  ui?: string
  /** Push channel this loop notifies through (notification_channels.id). */
  channelId?: string | null
  /** Coding agent this loop is recorded as (claude-code | codex). Read-only in the
   *  UI; a codex loop is still executed via Claude for now (recording-only). */
  agent?: CodingAgent
  owner?: {
    gateway?: string
    accountId?: string
    userId?: string
    displayName?: string
  }
  exec?: {
    executor: string
    workdir: string
    model?: string
    report?: 'viaAgent' | 'direct'
    allowControl?: boolean
    timeoutMs?: number
  }
  createdAt?: string
  updatedAt?: string
}

/** One loop's full detail payload — what the getJobDetail server fn returns
 *  (built by adapters.toJobDetail; the loop + run detail pages render it). */
export interface JobDetail {
  job: JobFull
  summary: JobSummary
  taskFileContent: string | null
  /** When taskFileContent was last synced from the machine (ISO); null ⇒ never. */
  taskFileSyncedAt: string | null
  /** The loop's execution machine + its live online state — gates run/evolve. */
  machine: { id: string; name: string; online: boolean }
  runs: RunSummary[]
}

export interface TranscriptStep {
  kind: 'text' | 'tool' | 'result'
  text?: string
  name?: string
  input?: string
}

// ---- artifacts: the loop's live-synced files (Phase 2) ----

/** One live file in a loop's current artifact set (metadata only; bytes are
 *  fetched lazily via getArtifact / the download route). */
export interface ArtifactSummary {
  /** Normalized, loop-folder-relative path. */
  path: string
  /** Byte size (null when unknown). */
  size: number | null
  /** When this file last synced from the machine (ISO). */
  updatedAt: string
  /** The bytes contain a NUL → download-only (no inline text render). */
  binary: boolean
  /** Over the per-file cap → metadata only (no bytes stored; not downloadable). */
  oversize: boolean
}

/** getArtifact result: a text file's decoded content, a marker for a
 *  binary/oversize file (download via the route instead), or an error. */
export type ArtifactContent =
  | { text: string }
  | { binary: true; size: number | null; oversize: boolean }
  | { error: string }

// ---- per-run diff: what changed vs the previous run (Phase 3) ----

/** One file's change between a run and the previous run. */
export interface RunDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed'
  /** Binary/oversize on either side → no inline diff, just the size delta. */
  binary: boolean
  /** A real text file that exceeds the inline-diff size cap (but is under the
   *  oversize cap) → no inline diff, but it's NOT binary — the UI says "too large
   *  to diff" rather than mislabeling it. */
  tooLarge?: boolean
  /** newSize − oldSize (added ⇒ +newSize, removed ⇒ −oldSize); null when unknown. */
  sizeDelta: number | null
  /** Unified text diff (text files only); absent for binary/oversize/too-large. */
  diff?: string
}

/** getRunDiff result. `hasSnapshot` false ⇒ this run predates the feature
 *  (no recorded manifest) → the UI shows the degrade copy, not an empty diff. */
export interface RunDiffResult {
  hasSnapshot: boolean
  files: RunDiffFile[]
}

export type TranscriptResult =
  | { query?: string; system?: string; steps: TranscriptStep[] }
  | { error: string }

// ---- writes: form / template ----

export interface OwnerRef {
  gateway?: string
  accountId?: string
  userId?: string
  displayName?: string
}

export interface ExecPayload {
  executor: 'claude'
  workdir?: string
  report?: 'viaAgent' | 'direct'
  allowControl?: boolean
  model?: string
}

/** The create/edit payload the form POSTs/PATCHes to the daemon. */
export interface JobPayload {
  name?: string
  cron?: string
  taskFile?: string
  notify?: 'auto' | 'always' | 'never' | string
  /** Set (non-empty) / clear (null|'') the closed-loop goal. Clearing also drops
   *  the completion stamps; the server enforces the lifecycle invariant. */
  goal?: string | null
  workflow?: string
  stateSchema?: StateField[]
  ui?: string
  /** Push channel id (notification_channels.id), or '' / null to clear it. */
  channelId?: string | null
  enabled?: boolean
  exec?: ExecPayload
  owner?: OwnerRef
}

export interface MutationResult {
  ok?: boolean
  id?: string
  error?: string
}

export interface TemplateSlot {
  name: string
  prompt: string
  required?: boolean
  kind?: 'cron' | 'workdir' | string
  default?: string
}

export interface TemplateInfo {
  name: string
  label: string
  desc: string
  tags: string[]
  slots: TemplateSlot[]
}

/** The team switcher's data: the teams this user may view + the active selection. */
export interface TeamsView {
  teams: { id: string; name: string }[]
  /** The active team id, or the `__all__` sentinel for an admin's aggregate view. */
  activeTeamId: string
  isAdmin: boolean
  allTeams: boolean
}
