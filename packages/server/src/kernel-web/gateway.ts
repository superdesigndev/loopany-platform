import {
  type Command,
  type Provenance,
  decide,
  inboxView,
  taskDetailView,
  timelineView,
  treeView,
  runArtifactsView,
} from "@loopany/kernel";

import { currentUser, requestScope } from "../auth.js";
import * as store from "../db/store.js";
import { authorizeKernelRequest } from "../kernel/authority.js";
import { notifyKernelChangeset } from "../kernel/notify.js";
import { normalizePersonFields, personAddress } from "../kernel/person.js";
import { agentDirectory } from "../kernel/agentDirectory.js";
import { applyChangesetForTeam, readEvents, readSnapshot } from "../kernel/store.js";

export class KernelWebError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Open mode (gate off) is the anonymous shared workspace, mirroring requestScope;
 *  gated mode requires a signed-in member of exactly this team. Team mismatch is a
 *  flat 404 (enumeration-safe), checked before the sign-in 401. */
async function access(teamId: string): Promise<{ user: Awaited<ReturnType<typeof currentUser>>; email: string | null }> {
  const scope = await requestScope(teamId);
  if (scope.teamId !== teamId) throw new KernelWebError(404, "Not found");
  if (!scope.enforce) return { user: null, email: null };
  const user = await currentUser();
  if (!user?.email) throw new KernelWebError(401, "Sign in required");
  if (!scope.userId) throw new KernelWebError(404, "Not found");
  return { user, email: user.email.trim().toLowerCase() };
}

export async function workspace(teamId: string) {
  const { user, email } = await access(teamId);
  const [snapshot, events, team, members, machines, aliases] = await Promise.all([
    readSnapshot(teamId), readEvents(teamId), store.getTeam(teamId), store.listTeamMembers(teamId),
    store.listMachinesForTeam(teamId), store.listTeamAliases(teamId),
  ]);
  const tasks = Object.values(snapshot.objects).filter((o) => o.archetype === "task");
  const documents = Object.values(snapshot.objects).filter((o) => o.archetype === "doc");
  const activeRuns = snapshot.runs.filter((r) => ["pending", "claimed", "running"].includes(r.state));
  const recentRuns = [...snapshot.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  const visibleMachines = machines.filter((machine) => !machine.revokedAt);
  return {
    team: { id: teamId, name: team?.name ?? teamId, slug: team?.slug ?? teamId },
    me: { id: user?.id ?? null, email },
    members: members.map((m) => ({
      id: m.userId,
      email: m.email?.trim().toLowerCase() ?? null,
      name: m.displayName,
      role: m.role,
    })),
    machines: visibleMachines.map((machine) => ({
      id: machine.id, name: machine.name, hostname: machine.hostname, platform: machine.platform,
      online: machine.online, lastSeen: machine.lastSeen, enrolledBy: machine.enrolledBy,
      alias: aliases.find((item) => item.machineId === machine.id)?.alias ?? null,
      mine: machine.enrolledBy != null && machine.enrolledBy === user?.id,
      agentProfiles: machine.agentProfiles,
    })),
    agentAddresses: agentDirectory(visibleMachines, aliases, snapshot.runs),
    tasks,
    tree: treeView(snapshot),
    triggers: snapshot.triggers,
    activeRuns,
    recentRuns,
    documents,
    inbox: inboxView(snapshot, user?.id ? personAddress(user.id) : "", new Date().toISOString()),
    recentTimeline: timelineView(snapshot, events, { limit: 30 }),
    generatedAt: new Date().toISOString(),
  };
}

export async function memberDetail(teamId: string, id: string) {
  await access(teamId);
  const [snapshot, members, machines] = await Promise.all([
    readSnapshot(teamId), store.listTeamMembers(teamId), store.listMachinesForTeam(teamId),
  ]);
  const member = members.find((item) => item.userId === id);
  if (!member) throw new KernelWebError(404, "Member not found");
  const address = personAddress(id);
  return {
    member: { id, email: member.email?.trim().toLowerCase() ?? null, name: member.displayName, role: member.role },
    tasks: Object.values(snapshot.objects).filter((item) => item.archetype === "task" && item.assignee === address && !["done", "archived"].includes(item.status)),
    machines: machines.filter((machine) => machine.enrolledBy === id && !machine.revokedAt),
  };
}

export async function taskDetail(teamId: string, id: string) {
  await access(teamId);
  const [snapshot, events] = await Promise.all([readSnapshot(teamId), readEvents(teamId)]);
  const recentWindow = taskDetailView(snapshot, id, events, { recentLimit: 51 });
  const detail = recentWindow ? { ...recentWindow, recent: recentWindow.recent.slice(0, 50), recentHasMore: recentWindow.recent.length > 50 } : null;
  if (!detail) throw new KernelWebError(404, "Task not found");
  return { ...detail, runs: snapshot.runs.filter((r) => r.taskId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

export async function docDetail(teamId: string, id: string) {
  await access(teamId);
  const snapshot = await readSnapshot(teamId);
  const doc = snapshot.objects[id];
  if (doc?.archetype !== "doc") throw new KernelWebError(404, "Document not found");
  const linkedTasks = Object.values(snapshot.objects).filter(
    (o) => o.archetype === "task" && (o.tracks === id || o.refs.includes(id)),
  );
  return { doc, linkedTasks };
}

export async function runDetail(teamId: string, id: string) {
  await access(teamId);
  const [snapshot, events] = await Promise.all([readSnapshot(teamId), readEvents(teamId)]);
  const run = snapshot.runs.find((r) => r.id === id);
  if (!run) throw new KernelWebError(404, "Run not found");
  // Only the run's OWN writes (actorId = runId); a note merely mentioning the id is not this run's event.
  return {
    run,
    task: snapshot.objects[run.taskId] ?? null,
    events: events.filter((e) => e.provenance.entrance === "agent-run" && e.provenance.actorId === id),
    artifacts: runArtifactsView(snapshot, events, id),
  };
}

export async function timeline(teamId: string, all = false) {
  await access(teamId);
  const [snapshot, events] = await Promise.all([readSnapshot(teamId), readEvents(teamId)]);
  return timelineView(snapshot, events, { all, limit: 100 });
}

export async function command(teamId: string, raw: unknown) {
  const { user } = await access(teamId);
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KernelWebError(400, "body must be { command: { op, ... } }");
  }
  const request = { command: raw };
  const forbidden = authorizeKernelRequest("human-session", request);
  if (forbidden) throw new KernelWebError(forbidden.status, forbidden.message);
  const actor: Provenance = { entrance: "human", actorId: user?.id ? personAddress(user.id) : "anonymous", ...(user?.sessionId ? { sessionId: user.sessionId } : {}) };
  const normalized = await normalizePersonFields(teamId, raw);
  if ("error" in normalized) return { status: 422, body: { ok: false, refusal: { code: "INVALID_PERSON", message: normalized.error }, notices: [] } };
  const decision = decide(normalized as Command, await readSnapshot(teamId), actor, new Date().toISOString());
  if (!decision.ok) return { status: 422, body: { ok: false, refusal: decision.refusal, notices: [] } };
  const applied = await applyChangesetForTeam(teamId, decision.changeset);
  if (!applied.ok) return { status: 409, body: { ok: false, conflict: applied.conflict, notices: decision.notices } };
  await notifyKernelChangeset(teamId, decision.changeset);
  return { status: 200, body: { ok: true, notices: decision.notices, result: decision.result } };
}
