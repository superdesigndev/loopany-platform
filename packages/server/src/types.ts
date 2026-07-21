/**
 * Shapes returned by the c0 daemon's loopback API (src/scheduler/api.ts).
 * Kept in sync with `summary()` / `detail()` there. The daemon stays the source
 * of truth; the web app never owns job state, it only renders + proxies writes.
 */

/** JSON-serializable value — server fn returns must be serializable (no `unknown`). */
export type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

/** The indexed front-matter subset of a loop product (all fields optional). See
 *  `server/frontmatter.ts` for the parsing convention. */
export type { ArtifactMeta } from './server/frontmatter'

import type { MachinePresence } from './lib/machinePresence'
export type { MachinePresence } from './lib/machinePresence'
import type { ArtifactMeta } from './server/frontmatter'

/** The coding agent a loop is bound to AND executed with (BYOA on the owner's
 *  machine): `claude-code` → Claude Code, `codex` → `codex exec`, `grok` → Grok.
 *  Non-Claude agents may still have thinner daemon telemetry until a stream
 *  adapter lands; execution itself is real for every value.
 *
 *  Runtime SINGLE SOURCE (anti-drift): every server consumer DERIVES from this
 *  array — the `CodingAgent` type here, the `db/schema.ts` `CodingAgent` type AND
 *  the `loops.agent` column enum, the edit validator (`coerceCodingAgent`), and the
 *  web agent `<select>` (LoopForm). So widening the set is a one-line edit HERE with
 *  no other server change (the daemon's own enum in `packages/daemon/src/create.ts`
 *  is a separate package, widened alongside). */
export const CODING_AGENTS = ['claude-code', 'codex', 'grok'] as const
export type CodingAgent = (typeof CODING_AGENTS)[number]

/** Coerce an unknown value to a known `CodingAgent`, or null when unrecognized.
 *  The ONE agent enum validator, imported by both write surfaces (server
 *  `buildEditUpdate`) and the web select — same anti-drift discipline as
 *  `validateUi/Workflow/Schema`. */
export function coerceCodingAgent(value: unknown): CodingAgent | null {
  return typeof value === 'string' && (CODING_AGENTS as readonly string[]).includes(value) ? (value as CodingAgent) : null
}

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
  /** Claude-reported spend for this run (USD estimate); null for workflow-only
   *  runs, older daemons, or runs that never reached a terminal result. */
  costUsd: number | null
  /** Token-count breakdown reported with the cost (display-only detail). */
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    numTurns?: number
  } | null
  error: string | null
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

/** One Slack channel offered by the add-channel picker (`listSlackChannels`),
 *  from `conversations.list` — enough to render "#name" / "🔒 #name" and warn
 *  when a private channel doesn't have the bot yet. */
export interface SlackChannelSummary {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
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
  /** Daemon package version reported on poll (e.g. "0.8.0"); null for older
   *  daemons / before the first poll. */
  daemonVersion: string | null
  /** Latest published daemon version (cached npm dist-tag `latest`); null when
   *  npm is unreachable. Same for every machine — the web compares it against
   *  `daemonVersion` to show an "update available" hint. */
  latestDaemonVersion: string | null
  /** Plaintext device token (so the UI can re-show the connect command). Under
   *  the auth gate it is serialized ONLY to the machine's owner — null for
   *  everyone else (the token fully impersonates the machine). */
  token: string | null
  /** Loops bound to this machine — must be 0 before it can be deleted. */
  loopCount: number
}

/** One lane on the cross-loop timeline (`listTimeline`). */
export interface TimelineLoop {
  id: string
  name: string
  cron: string
  /** IANA zone the cron fires in (null ⇒ server local). Carried so the UI can
   *  tell the viewer when a loop's own zone differs from theirs. */
  timezone: string | null
  enabled: boolean
  completedAt: string | null
  /** Human cadence derived from the cron ("Daily 05:00", "Every 30 min") — the
   *  lane label. Computed server-side so the client never parses cron. */
  cadence: string
}

/** One mark in a lane: a real run, or a projected future fire. */
export interface TimelineMark {
  loopId: string
  /** ISO start. For a projection this is the computed fire time. */
  ts: string
  /** Real runs carry their row id; projections have none (nothing to link to). */
  runId: string | null
  /** `projected` ⇒ a future cron fire, never persisted. */
  kind: 'run' | 'projected'
  /** Visual state — mirrors `lib/format.ts` dotColor/dotLabel inputs. */
  running: boolean
  canceled: boolean
  role: 'exec' | 'evolve' | 'edit' | string
  outcome: RunOutcome | null
  status: RunStatus | null
  durationMs: number | null
  costUsd: number | null
  message: string | null
  error: string | null
}

/** Payload behind the timeline view: lanes + marks + window totals. */
export interface TimelineData {
  /** Echoed window (ISO), so the client renders exactly what the server scoped. */
  from: string
  to: string
  loops: TimelineLoop[]
  marks: TimelineMark[]
  totals: {
    runCount: number
    costUsd: number
    /** Per-loop spend inside the window; missing key ⇒ no cost reported. */
    byLoop: Record<string, number>
  }
  /** True when the run query hit its safety cap — the UI warns rather than
   *  silently showing a partial window. */
  truncated: boolean
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
  /** Lifetime claude-reported spend across all runs (USD estimate, SUM over the
   *  run rows); null when no run has reported a cost yet. */
  totalCostUsd: number | null
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
  /** Coding agent this loop is bound to and executed with (claude-code | codex |
   *  grok). Editable in the UI (LoopForm agent select); the next run spawns that
   *  agent on the bound machine. */
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
  /** The loop's execution machine + its live presence. `online` gates run/evolve
   *  (a sleeping/offline machine can't execute); `presence` distinguishes a calm
   *  "asleep" (recently seen, likely just idle) from a hard "offline", and
   *  `lastSeen` (ISO) feeds the "last seen 3m ago" hint. */
  machine: { id: string; name: string; online: boolean; presence: MachinePresence; lastSeen: string | null }
  /** The loop's owning team + whether it is the caller's active team. Present only
   *  when the auth gate is on (open mode has a single workspace, so no chip). Lets
   *  the loop header show which team owns the loop and, when a member opens it from
   *  outside their active team, offer a "switch to this team" affordance. */
  team?: { id: string; name: string; isActive: boolean } | null
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
  /** Parsed front-matter subset ({type?,title?,date?}) for a typed markdown
   *  product; null for an untyped / binary / oversize / not-yet-stored file. */
  meta: ArtifactMeta | null
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
  /** Coding agent this loop executes with (claude-code | codex | grok). Editable —
   *  the next run picks up the new agent. */
  agent?: CodingAgent
  exec?: ExecPayload
  owner?: OwnerRef
}

export interface MutationResult {
  ok?: boolean
  id?: string
  error?: string
}

/**
 * A template is a canned loop INTENT, not a flow: metadata only. Clicking its card
 * on the dashboard mints a connect-key and appends `description` to the standard
 * bootstrap snippet — bootstrap.md + create.md then handle cadence, config, and
 * dashboard authoring the same way they do for a blank loop.
 */
export interface TemplateInfo {
  name: string
  label: string
  /** One-line blurb shown on the dashboard card. */
  desc: string
  /** The canned task description (English) appended to the bootstrap snippet. */
  description: string
  /** Optional inline-SVG preview (the template folder's thumb.svg, repo-authored
   *  and trusted) - a mock screenshot of what the loop produces, drawn with the
   *  theme's CSS variables so it follows light/dark for free. */
  thumb?: string
}

/** The team switcher's data: the teams this user may view + the active selection. */
export interface TeamsView {
  teams: { id: string; name: string }[]
  /** The active team id. */
  activeTeamId: string
}
