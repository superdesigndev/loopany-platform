# Kernel Web UI v1

Status: proposal

## Summary

Kernel Web UI is a minimal team workspace for understanding what agents are
doing, handling work that needs a human, and tracing work through Tasks, Runs,
Artifacts, and Events.

The first version lives in the existing `packages/server` TanStack Start
application. It runs beside the current product UI until it has reached feature
parity and has been validated in real team use. It does not introduce another
web application, another task model, or another synchronization authority.

The interface is deliberately dense and plain. It should feel closer to a TUI
than a conventional SaaS dashboard: strong information hierarchy, few visual
decorations, keyboard navigation, stable URLs, and fast drill-down.

## Goals

The first version must let a team:

1. See work that currently needs a human in Inbox.
2. Browse all Tasks as a tree, board, or list.
3. Clearly distinguish Loops from ordinary Tasks.
4. Browse Documents produced by Tasks and Runs.
5. Inspect a Task's Spec, children, Artifacts, Runs, and Timeline.
6. Inspect a Run and trace it to its coding-agent session.
7. See the team's recent meaningful activity.
8. Leave notes, change status, reassign work, and return work to an agent using
   the existing Kernel command semantics.
9. Stay reasonably fresh without requiring manual reloads.

The expected initial scale is one team with roughly ten to a few dozen Tasks and
Loops, with low-frequency agent activity.

## Non-goals

The first version will not:

- Replace the current product UI immediately.
- Introduce a separate WebSocket synchronization system.
- Stream agent transcripts live.
- Reimplement Kernel decisions in frontend code.
- Expose device credentials to a browser.
- Add Inbox, Loop, Board, Tree, Document Browser, or Timeline as stored entities.
- Provide a general-purpose document editor.
- Guarantee one-click opening of a session on another machine.

## Domain model

The Web UI is a set of projections over the existing Kernel model:

- Inbox is a filtered Task view.
- A Loop is a Task with a cron Trigger.
- Tree and Board are Task projections.
- Documents are Doc Artifacts collected across the team.
- Timeline is a meaningful projection over Events and Runs.
- Task Detail joins a Task with its children, Triggers, Runs, Events, and
  Artifacts.

The UI must use the shared projections in `@loopany/kernel` where they already
exist. It must not recreate tree, inbox, loop, task-detail, or timeline semantics
inside React components.

## Information architecture

The application has four primary destinations:

```text
Inbox
Tasks
Documents
Timeline
```

Task Detail, Document Detail, and Run Detail are object views, not primary
navigation destinations.

### Desktop layout

The default desktop layout has three panes:

```text
+---------------+--------------------------------------+----------------------+
| Navigation    | Current workspace                    | Selected detail      |
|               |                                      |                      |
| Inbox         | Inbox, Tree, Board, Documents,        | Task, Doc, or Run    |
| Tasks         | or Timeline                          |                      |
| Documents     |                                      |                      |
| Timeline      |                                      |                      |
+---------------+--------------------------------------+----------------------+
| Keyboard hints, refresh state, and connection state                         |
+------------------------------------------------------------------------------+
```

Selecting an item opens its summary in the right pane without losing the list
position. Opening the item fully navigates to its stable detail URL.

On narrow screens, the panes become a normal navigation stack:

```text
Navigation -> List -> Detail
```

### Inbox

Inbox is the default destination. It answers one question: what needs this
person now?

Items may be grouped by derived reason, such as:

- Needs decision or review
- Assigned to me
- Follow-up due
- Blocked
- Recently returned by an agent

The exact grouping must be derived from Task state, assignee, due time, Runs,
and recent Events. It must not be stored separately.

Initial actions:

- Leave a note
- Change status
- Reassign
- Return to an agent
- Mark done
- Archive

Approval is not a new object or verb. A human approval is a note plus the
appropriate Task update, normally returning the Task to an agent or completing
it.

### Tasks

Tasks supports three views over the same filters and data:

```text
Tree | Board | List
```

Tree is the default because parent relationships express scope and delegation.
Loops receive a visible `LOOP` marker based only on the presence of a cron
Trigger.

By default, the views show open work and hide `idea`, `done`, and `archived`.
Users can reveal those statuses through filters. View and filter state belong in
the URL so the current view can be refreshed and shared.

Examples:

```text
/t/<teamId>/kernel/tasks?view=tree&status=open
/t/<teamId>/kernel/tasks?view=board&assignee=tim%40example.com
```

### Documents

Documents is a searchable list, not a simulated folder hierarchy. Each row
shows title, key, version, update time, producer, and linked Task where known.

Filters may include:

- Document type
- Linked Task or Loop
- Producer agent or Run
- Updated time
- Text query over title and key

Document bodies are loaded only when a document is opened. Mirrors are shown as
external sources, not as cached Documents.

### Task Detail

Task Detail includes:

- Identity, status, owner, assignee, priority, type, and version
- Goal and Spec
- Trigger and schedule information for a Loop
- Direct children
- Linked Artifacts
- Active Run and recent settled Runs
- Recent meaningful Timeline
- Safe human actions

The default view should show the most useful recent information without forcing
the user through many tabs. Full Runs and Timeline can use dedicated subviews or
progressive pagination.

### Run Detail

Run Detail includes:

- Run identity, cause, state, and timestamps
- Task
- Assignee snapshot
- Machine and agent derived from assignee
- Kernel session ID
- Host coding-agent session ID, when reported
- Return note and result
- Related Events and Artifacts
- A copyable resume or lookup command

For v1, session tracing must always offer copyable session information. A direct
Open in Claude Code or Open in Codex action is added only when the target daemon
supports an authenticated local launcher protocol. A browser cannot reliably
open a session stored on another machine by itself.

### Team Timeline

The default Timeline shows meaningful team activity, using the shared Kernel
timeline projection. It includes task creation and completion, handoffs, human
notes, Artifacts, failures, blocked dispatches, and collapsed Run activity.

Mechanical events such as polling, heartbeats, trigger cursor movement, and
ordinary successful no-op Runs remain hidden by default. An explicit audit view
may reveal them.

## Application placement

Kernel Web UI stays in `packages/server`:

```text
packages/server/src/
  kernel/                  existing Kernel authority and persistence
  kernel-web/
    auth.ts                web session to team and provenance
    queries.ts             bounded web projections
    mutations.ts           session-authorized Kernel commands
    types.ts               web response types
  components/kernel/
    KernelShell.tsx
    InboxView.tsx
    TaskTree.tsx
    TaskBoard.tsx
    TaskList.tsx
    TaskDetail.tsx
    DocumentBrowser.tsx
    DocumentDetail.tsx
    RunDetail.tsx
    TeamTimeline.tsx
```

Initial routes:

```text
/t/<teamId>/kernel
/t/<teamId>/kernel/inbox
/t/<teamId>/kernel/tasks
/t/<teamId>/kernel/tasks/<taskId>
/t/<teamId>/kernel/docs
/t/<teamId>/kernel/docs/<docId>
/t/<teamId>/kernel/runs/<runId>
/t/<teamId>/kernel/timeline
```

The existing `/t/<teamId>` UI remains unchanged during validation. After Kernel
Web UI is ready, the default route can move to the new UI and the old UI can be
temporarily exposed under `/t/<teamId>/legacy` before deletion.

A separate `packages/kernel-web` application is intentionally avoided. It would
duplicate routing, authentication, deployment, and server boundaries without
creating a meaningful ownership boundary.

## Deployment target and migration

The v1 dogfood target is the existing `loopany-kernel-live` Fly application,
using `fly.kernel-live.toml` and its durable volume-backed PGlite database. The
Web UI must not start against `loopany-testing`, production, or a new empty app,
because the Tasks, Runs, Events, machines, and aliases being evaluated already
live in `loopany-kernel-live`.

Today that app has two important properties which must change deliberately:

- It runs in open mode with no browser session gate.
- It is deployed manually from the Kernel branch and has no dedicated GitHub
  Actions workflow.

Before Web UI implementation is considered usable, add a dedicated
`deploy-kernel-live` workflow that deploys an explicit commit to
`loopany-kernel-live` with `fly.kernel-live.toml` and verifies `/api/health`
serves that commit. Keep it manually dispatched during v1 dogfooding so an
unrelated branch push cannot replace the demo environment. Once Kernel lands on
the main branch, the workflow can follow the normal main-branch release policy.

The live app receives these deployment secrets and settings:

```text
LOOPANY_AUTH_MODE=shared-password
LOOPANY_SHARED_LOGIN_PASSWORD=<high-entropy secret>
LOOPANY_ALLOWED_LOGINS=<explicit internal emails or narrow domain>
LOOPANY_AUTH_SECRET=<independent Better Auth secret>
LOOPANY_KERNEL_WEB_TEAM_ID=team-shared
```

`team-shared` is the existing authority scope derived for machines and Kernel
records while the app is in open mode. Enabling login must not create a new
personal-team workspace and strand the existing data. On first successful
shared-password login, the server adds the Better Auth user as a member of this
existing Team. The `/t/team-shared/kernel` route then passes the normal
membership check. No Kernel rows move and no second mapping table is introduced.

Already registered device tokens and machine aliases remain bound to
`team-shared`. They must continue polling after the auth gate is enabled. New
machine enrollment must use the authenticated connect flow rather than open-mode
self-registration. This transition requires an end-to-end deploy test covering
one existing daemon, one login, one workspace read, and one newly connected
machine before the open gate is removed.

## Authentication and authority

The browser must not call `POST /api/kernel/cli` with a device token.

That endpoint is designed for daemons and CLI clients. A `dk_` token represents
a machine and must never be exposed to browser JavaScript. Its `read:true`
response is also intentionally shaped for the CLI and can contain a full
Snapshot and all Event streams.

### Internal v1 login

Kernel Web UI v1 uses an intentionally simple internal login form:

```text
Email
Shared access password
[ Sign in ]
```

The password is one deployment-level secret shared by the internal testing
team. It is not a password stored independently on each user account.

This is implemented as a small Better Auth server plugin with a custom `POST`
endpoint. The endpoint:

1. Normalizes and validates the submitted email.
2. Requires the email to match `LOOPANY_ALLOWED_LOGINS`, including the existing
   exact-email and domain-wildcard rules.
3. Compares the submitted password with the server-only shared secret using a
   timing-safe comparison.
4. Finds the Better Auth user by normalized email, or creates it on first login.
5. Adds the user to the configured existing Kernel Team when not already a
   member.
6. Calls Better Auth's internal session adapter to create a normal database
   session.
7. Returns Better Auth's standard secure, HTTP-only session cookie.

The login endpoint belongs under Better Auth's existing `/api/auth` handler,
for example:

```http
POST /api/auth/kernel-shared-login
Content-Type: application/json

{
  "email": "tim@superdesign.dev",
  "password": "<shared access password>",
  "callbackURL": "/t/team_123/kernel"
}
```

The callback URL must be relative or pass Better Auth's trusted-origin check.
The endpoint returns the same generic authentication error for an unknown email
and a wrong password.

The proposed deployment configuration is explicit:

```text
LOOPANY_AUTH_MODE=shared-password
LOOPANY_SHARED_LOGIN_PASSWORD=<high-entropy secret>
LOOPANY_ALLOWED_LOGINS=tim@superdesign.dev,*@superdesign.dev
LOOPANY_AUTH_SECRET=<independent Better Auth signing secret>
LOOPANY_KERNEL_WEB_TEAM_ID=team-shared
```

`LOOPANY_SHARED_LOGIN_PASSWORD` and `LOOPANY_AUTH_SECRET` serve different
purposes and must never share a value. The first admits a user through this
internal gate. The second signs and protects Better Auth session material.

`shared-password` mode must fail at boot when either secret or the allowlist is
missing. An empty allowlist is not permitted in this mode. This is deliberately
stricter than the current GitHub/open development behavior.

GitHub login may remain available to the legacy UI during migration, but an
explicit auth mode must determine which login surface a deployment presents.
The application must not infer an ambiguous mode from whichever secrets happen
to be present.

After login, Kernel Web UI uses the ordinary Better Auth session exactly like
the current application:

```text
Better Auth session cookie
  -> resolve authenticated user
  -> verify team membership
  -> derive human provenance
  -> read or command the team's Kernel authority
```

Existing `auth.api.getSession()`, `authClient.getSession()`, `useSession()`,
sign-out, session expiry, and route protection remain the session authority.
Kernel Web APIs do not receive or revalidate the shared password after login.

### Security boundary

This login mode is suitable only for internal testing. Anyone who knows the
shared password can impersonate any email admitted by the allowlist. The email
therefore identifies the selected internal user but does not prove ownership of
that mailbox.

Required controls:

- A narrow email allowlist, never open signup
- A high-entropy shared secret stored only in deployment secrets
- HTTPS and secure, HTTP-only, same-site session cookies
- Per-IP and per-email rate limiting on the login endpoint
- Generic failures that do not reveal whether an email exists
- No logging of submitted passwords or raw request bodies
- Shared-password rotation without invalidating Better Auth's signing secret
- Normal Better Auth session revocation and expiry

This mechanism must be replaced by verified email, SSO, or another
identity-proving method before opening the service to untrusted users. The
replacement changes only how a Better Auth session is created. Team membership
and all Kernel Web authorization remain unchanged.

### Canonical human address

Kernel person assignment is a plain email string, and Inbox matching is exact.
V1 therefore defines one canonical human address without adding an identity
mapping entity:

```text
canonical person address = lowercase(trim(Better Auth user.email))
```

The shared-password login form, Team member list, Inbox `me`, owner defaults,
assignee picker, and human provenance all use that exact value. The workspace
response includes the canonical email, and UI writes never substitute display
names or GitHub privacy addresses.

Agent-authored assignments must use an email from the Team member list. The UI
should offer members as choices instead of asking a human to retype an address.
The CLI and Agent skill should eventually expose the same Team identities, but
the Web v1 contract requires only that existing Tasks assigned to the logged-in
canonical email appear in Inbox.

An existing Better Auth user with the same normalized email is reused during
login. This prevents GitHub and shared-password login from creating two users
for one person.

### Shared command authority

`@loopany/kernel` decides domain validity and records provenance. It does not
authorize an entrance, and provenance must not be treated as authority. The
current run-credential restrictions already live at the server Gateway seam.

Before adding the Web mutation route, extract one shared server policy module,
for example `packages/server/src/kernel/authority.ts`:

```ts
type KernelAuthority = "device" | "human-session" | "agent-run";

authorizeKernelRequest(authority, request, context):
  | { ok: true }
  | { ok: false; status: 403 | 409; code: string; message: string };
```

The existing `/api/kernel/cli` Gateway and the new Web Gateway both call this
function before `decide()`. The run-specific own-run and terminal-lease checks
move behind the same policy entry instead of remaining a second ad hoc list.

Initial policy:

| Authority | Allowed mutation surface |
| --- | --- |
| `human-session` | `create`, `update`, `note`, `doc-put`, `doc-append`, `mirror-add`, `run` |
| `agent-run` | Existing cross-Task agent subset plus `run-finish` for its own active Run |
| `device` | Existing CLI and host surface, including `tick` and `run-claim` |

`human-session` cannot issue `tick`, `run-claim`, or `run-finish`. Reads are
separately team-scoped. `delete` remains a Kernel refusal which teaches archive
as the terminal action.

This policy is a server authority boundary, not a new Kernel entity and not a
branch inside the pure domain `decide()` function. Local file drivers can keep
their own trusted host boundary, while every server-hosted entrance shares one
authorization chokepoint.

For writes, the server derives provenance rather than trusting it from the
request:

```json
{
  "entrance": "human",
  "actorId": "tim@example.com",
  "sessionId": "<web-session-id>"
}
```

Every write continues through:

```text
decide(command) -> applyChangesetForTeam(teamId, changeset)
```

The Web UI never writes Kernel tables directly.

## Read API

The Web API has three read levels: workspace summary, object detail, and bounded
history.

### Workspace summary

```http
GET /api/kernel/web/workspace?teamId=<teamId>
```

The response contains only what the live workspace needs:

```ts
interface KernelWorkspaceResponse {
  team: { id: string; name: string };
  me: { id: string; email: string | null };
  tasks: TaskSummary[];
  triggers: TriggerSummary[];
  activeRuns: RunSummary[];
  recentRuns: RunSummary[];
  documents: DocumentSummary[];
  inbox: InboxItem[];
  recentTimeline: TimelineItem[];
  machinePresence: Record<string, string>;
  generatedAt: string;
}
```

Task summaries carry the current object version:

```ts
interface TaskSummary {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  assignee: string | null;
  priority: string | null;
  type: string | null;
  parent: string | null;
  version: number;
  updatedAt: string;
  isLoop: boolean;
}
```

Document summaries contain metadata only. Bodies and unbounded Event histories
must not be included in this response.

### Object detail

```http
GET /api/kernel/web/tasks/<taskId>?teamId=<teamId>
GET /api/kernel/web/docs/<docId>?teamId=<teamId>
GET /api/kernel/web/runs/<runId>?teamId=<teamId>
```

Each endpoint:

- Verifies the authenticated user's team access.
- Returns `404` for an object outside the authorized team.
- Returns a bounded initial history page.
- Does not expose credentials or internal lease data.

### Bounded history

```http
GET /api/kernel/web/timeline?teamId=<teamId>&limit=50
GET /api/kernel/web/tasks/<taskId>/timeline?teamId=<teamId>&limit=50
GET /api/kernel/web/tasks/<taskId>/runs?teamId=<teamId>&limit=20
```

The default timeline uses the meaningful projection. An authorized diagnostic
view may request `all=true`.

V1 returns a bounded newest-first window. Older-history pagination can be added
after dogfooding proves it is needed. When added, it must use deterministic
`(timestamp, id)` ordering and must not create a stored cursor entity.

## Write API

The first version uses one mutation endpoint:

```http
POST /api/kernel/web/command
Content-Type: application/json
```

Example:

```json
{
  "teamId": "team_123",
  "command": {
    "op": "update",
    "id": "approve-api-migration",
    "patch": {
      "status": "todo",
      "assignee": "stonex-mbp/claude"
    },
    "note": "Approved. Proceed with deployment.",
    "ifVersion": 11
  }
}
```

The endpoint verifies session and team scope, derives human provenance, passes
the command to the shared Kernel decision path, and returns the same typed
refusal or conflict semantics used elsewhere.

All updates that edit an existing object should carry `ifVersion`. A stale
version returns `409 Conflict`. The UI keeps the user's draft, reloads current
state, and explains that the Task changed during review.

The endpoint calls the shared `human-session` authority policy. Host-only and
run-only operations remain unavailable even if a client submits their raw
command shapes.

## Synchronization model

### v1 decision

The first version uses simple polling:

- Poll the workspace every 5 seconds while the page is visible.
- Stop periodic polling while the page is hidden.
- Refresh immediately when the page becomes visible or regains focus.
- Refresh immediately after a successful mutation.
- Allow manual refresh with `R` and a visible refresh control.
- Preserve the last successful view during transient failures.

Five seconds is appropriate for the expected scale and interaction model. Agent
work changes on a seconds-to-hours timescale, and human decisions do not require
chat-like delivery latency.

### Detail refresh

While a Task or active Run detail is open, refresh that bounded detail response
on the same 5-second interval. This is intentionally simple for a team with a few
dozen Tasks. The request still excludes unbounded history and unrelated Document
bodies.

Document bodies load when opened and refresh after an edit or manual refresh.
Terminal Run Detail may stop polling once its bounded response is settled. The
Timeline page refreshes its newest bounded window every 5 seconds while visible.

V1 deliberately has no per-Task activity revision, team revision, conditional
ETag contract, or incremental changes feed. The recurring workspace response is
small and bounded. If measurements later show meaningful cost, ETag can be added
without changing the response body, and SSE can later invalidate the same reads.

### Failure and recovery

Polling must treat failures as connectivity state, not as empty data:

- Keep rendering the last successful response.
- Show the last successful refresh time.
- Show a quiet reconnecting state after the first failure.
- Back off repeated failures, for example 5, 10, then 30 seconds.
- Refresh immediately when the browser reports that it is online again.
- Never clear Inbox or Task lists because a request failed.

### Why not WebSocket or SSE in v1

WebSocket would add connection authentication, reconnect behavior, deployment
proxy concerns, and another message protocol without removing the need for
normal reads and recovery.

If polling later becomes insufficient, add Server-Sent Events only as an
invalidation signal:

```text
team changed event -> refetch the existing workspace or detail endpoint
```

SSE should not carry an alternative copy of Task state. HTTP queries remain the
single read path, preventing drift between realtime messages and ordinary page
loads.

The existing daemon long-poll and Dispatcher should not be reused for Web UI
refresh. They coordinate machine execution delivery, not team data changes.

## Query and response boundaries

The Web server should build bounded projections close to the database and reuse
pure `@loopany/kernel` views. React components receive presentation-ready DTOs
and do not interpret raw Event streams independently.

The workspace response must not include:

- Full Document bodies
- Full Task Event histories
- Full Run histories
- Credentials or lease records
- Agent transcripts
- Internal polling or heartbeat records

This boundary keeps the 5-second request cheap as the team's history grows.

For the initial expected scale, it is acceptable for the server to read a team's
small Kernel Snapshot and derive workspace views in process. Event and Run
history queries must already be bounded. If teams grow materially, the API shape
can remain unchanged while the store moves to indexed summary queries.

## Interaction and visual rules

The UI is intentionally minimal:

- Flat surfaces with one-pixel separators
- No decorative cards, shadows, or gradients
- High information density
- Text and symbols carry meaning without relying only on color
- Stable selection during refresh
- Keyboard navigation for all common browsing actions
- A bottom bar showing available shortcuts and refresh state
- `/` for search, `j` and `k` for movement, Enter to open, Escape to go back,
  `R` to refresh, and `?` for help

The interface need not imitate a terminal's colors. TUI means interaction
discipline and information density, not green text on a black background.

## Delivery plan

### Phase 1: read-only workspace

- Dedicated manual deployment workflow for `loopany-kernel-live`
- Shared-password Better Auth plugin and `team-shared` membership migration
- Shared server-side Kernel authority policy
- Kernel shell and team-aware routes
- Session-authorized workspace endpoint
- Inbox
- Task Tree and List
- Task Detail
- Five-second polling
- Loading, stale, reconnecting, empty, and error states

### Phase 2: traceability

- Run Detail
- Agent session identifiers and copyable resume commands
- Documents and Document Detail
- Team Timeline
- Bounded Task Timeline and Run history

### Phase 3: human actions

- Note
- Status change
- Reassignment and handback
- Done and archive
- CAS conflict recovery
- Immediate post-mutation invalidation

### Phase 4: additional views and hardening

- Board view
- Search and richer filters
- URL-persisted view state
- Accessibility and keyboard audit
- Performance measurements against larger seeded teams
- Optional daemon-assisted session launcher design

## Acceptance criteria

The v1 is ready for team dogfooding when:

1. A signed-in user can only read and modify Kernel records in an authorized
   team.
2. The internal login rejects emails outside the configured allowlist and
   creates a standard Better Auth session for an admitted email.
3. No browser response exposes the shared login password, Better Auth secret,
   device token, run credential, or lease secret.
4. Inbox, Tree, Loop markers, Task Detail, and Timeline agree with the CLI
   projections for the same state.
5. New Runs and human handoffs appear without a full page reload within roughly
   five seconds while the page is visible.
6. Background tabs do not continue fixed-rate polling.
7. Opening Documents or long histories does not enlarge the recurring workspace
   response.
8. A stale human edit produces an understandable conflict instead of overwriting
   newer Agent work.
9. A temporary network failure preserves the last known workspace.
10. Every Run with an available coding-agent session ID exposes a copyable trace
   or resume command.
11. The old UI remains reachable until the Kernel UI replacement decision is
    made explicitly.
12. Existing `team-shared` Tasks and registered daemons remain visible and
    operational after the login gate is enabled.

## Decisions recorded

| Question | v1 decision |
| --- | --- |
| Application location | Existing `packages/server` application |
| Dogfood deployment | Existing `loopany-kernel-live` app and durable database |
| Deployment workflow | Dedicated manual workflow with commit health verification |
| Old UI replacement | Parallel first, switch only after validation |
| Frontend stack | Existing TanStack Start and React |
| Internal v1 login | Email plus deployment-level shared password |
| Session authority | Standard Better Auth database session and secure cookie |
| Browser authorization | Better Auth user plus team membership |
| Login provisioning | Custom Better Auth endpoint finds or creates an allowlisted user and joins `team-shared` |
| Canonical human address | Normalized Better Auth email, with no mapping entity |
| Server command authority | One shared Gateway policy for device, human session, and agent Run |
| Kernel semantics | Shared `@loopany/kernel` decisions and projections |
| Refresh mechanism | Visible-page polling every 5 seconds |
| Cache validation | None in v1; measure before adding ETag |
| Initial payload | Bounded workspace projection without bodies or full history |
| Details | Lazy-loaded per object |
| History | Bounded newest-first windows; older paging deferred |
| Mutations | One session-authorized Kernel command endpoint with CAS |
| WebSocket or SSE | Neither in v1; optional SSE invalidation later |
