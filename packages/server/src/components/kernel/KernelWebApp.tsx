import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient } from "../../lib/auth-client";
import { NotificationSettings } from "../NotificationsModal";
import { AssigneePicker, type AssigneeOption } from "./AssigneePicker";
import { BOARD_STATUSES, hiddenTaskCount, resumeCommand, visibleTaskTree } from "./taskLayouts";

type Obj = Record<string, any>;
type View = "inbox" | "tasks" | "documents" | "timeline" | "settings";
type SettingsView = "team" | "machines" | "notifications";
type TaskLayout = "tree" | "board";
type Selection = { kind: "task" | "doc" | "run"; id: string };
type LoadedDetail = Selection & { value: Obj };

const fmt = (iso?: string) => iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "-";
const agent = (assignee?: string | null) => (assignee?.includes("/") ? assignee.split("/").pop() : null) ?? null;

function knownAgents(data: Obj | null): string[] {
  if (!data) return [];
  if (Array.isArray(data.agentAddresses)) return data.agentAddresses.map((item: Obj) => item.address);
  // Compatibility with a server that predates Machine capability reporting.
  const addresses = [
    ...data.tasks.map((task: Obj) => task.assignee),
    ...data.activeRuns.map((run: Obj) => run.assignee),
    ...data.recentRuns.map((run: Obj) => run.assignee),
  ];
  return [...new Set(addresses.filter((value): value is string => typeof value === "string" && value.includes("/")))].sort();
}

function assigneeOptions(data: Obj | null): AssigneeOption[] {
  if (!data) return [];
  const people = (data.members ?? []).map((person: Obj) => ({
    value: `person:${person.id}`,
    label: person.email,
    detail: person.role,
    kind: "person" as const,
  }));
  const agents = (data.agentAddresses ?? []).map((entry: Obj) => ({
    value: entry.address,
    label: entry.address,
    detail: entry.availability,
    kind: "agent" as const,
  }));
  return [...people, ...agents];
}

function assigneeLabel(value: string | null, options: readonly AssigneeOption[]): string {
  if (!value) return "-";
  const option = options.find((item) => item.value === value);
  return option ? `${option.label} (${value})` : value;
}

export function KernelWebApp({ teamSlug }: { teamSlug: string }) {
  // Auth is driven by the API, not a client session: a 401 means sign in. This
  // keeps open mode (gate off, no session at all) working without a login wall.
  const [unauthorized, setUnauthorized] = useState(false);
  const [view, setView] = useState<View>("inbox");
  const [data, setData] = useState<Obj | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState<Date | null>(null);
  const agents = useMemo(() => knownAgents(data), [data]);
  const assignees = useMemo(() => assigneeOptions(data), [data]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/kernel/web/workspace?teamSlug=${encodeURIComponent(teamSlug)}`);
      if (res.status === 401) { setUnauthorized(true); return; }
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setUnauthorized(false);
      setData(await res.json()); setRefreshed(new Date()); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [teamSlug]);

  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    const requested = selected;
    const plural = selected.kind === "task" ? "tasks" : selected.kind === "doc" ? "docs" : "runs";
    const res = await fetch(`/api/kernel/web/${plural}/${encodeURIComponent(selected.id)}?teamSlug=${encodeURIComponent(teamSlug)}`);
    if (res.ok) setDetail({ ...requested, value: await res.json() });
  }, [selected, teamSlug]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  useEffect(() => { void loadDetail(); }, [loadDetail, data?.generatedAt]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key.toLowerCase() === "r") void load();
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [load]);

  if (unauthorized) return <KernelLogin />;

  const select = (kind: "task" | "doc" | "run", id: string) => { setDetail(null); setSelected({ kind, id }); };
  const selectedDetail = selected && detail?.kind === selected.kind && detail.id === selected.id ? detail.value : null;
  return <div className="kw-root">
    <header className="kw-head">
      <strong>LOOPANY KERNEL</strong><span>{data?.team?.name ?? teamSlug}</span><span className="kw-muted">{data?.me?.email ?? ""}</span>
      <span className="kw-spacer" />
      <span>{data?.activeRuns?.length ?? 0} running</span>
      <button onClick={() => void load()}>R Refresh</button>
      {data?.me?.email && <button onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button>}
    </header>
    <div className={`kw-grid${view === "settings" ? " kw-grid-settings" : ""}`}>
      <nav className="kw-nav">
        <div>{(["inbox", "tasks", "documents", "timeline"] as View[]).map((v) =>
          <button key={v} className={view === v ? "active" : ""} onClick={() => { setView(v); setSelected(null); }}>
            {v[0]!.toUpperCase() + v.slice(1)}{v === "inbox" && data ? `  ${data.inbox.length}` : ""}
          </button>)}</div>
        <div className="kw-nav-bottom">
          <div className="kw-nav-foot">Tasks {data?.tasks?.length ?? 0}<br />Loops {data?.triggers?.filter((t: Obj) => t.kind === "cron").length ?? 0}<br />Docs {data?.documents?.length ?? 0}</div>
          <button className={view === "settings" ? "active" : ""} onClick={() => { setView("settings"); setSelected(null); }}>Settings</button>
        </div>
      </nav>
      <main className="kw-main">
        {!data ? <Empty text={error || "Loading workspace..."} /> : view === "inbox" ? <Inbox data={data} select={select} />
          : view === "tasks" ? <Tasks data={data} select={select} />
          : view === "documents" ? <Documents data={data} select={select} />
          : view === "timeline" ? <Timeline items={data.recentTimeline} select={select} />
          : <Settings data={data} teamId={data?.team?.id} agents={agents} />}
      </main>
      {view !== "settings" && <aside className="kw-detail">{selected ? <Detail kind={selected.kind} detail={selectedDetail} select={select} teamSlug={teamSlug} reload={load} assignees={assignees} /> : <Empty text="Select an item to inspect" />}</aside>}
    </div>
    <footer className="kw-foot"><span>R refresh · Esc close detail</span><span className={error ? "kw-error" : ""}>{error || `updated ${refreshed ? fmt(refreshed.toISOString()) : "-"}`}</span></footer>
    <Style />
  </div>;
}

function Settings({ data, teamId, agents }: { data: Obj; teamId?: string; agents: string[] }) {
  const [section, setSection] = useState<SettingsView>("team");
  return <Section title="Settings" sub="Manage this Team, your Machines, and personal preferences" flush>
    <div className="kw-settings">
      <nav aria-label="Settings sections">{(["team", "machines", "notifications"] as SettingsView[]).map((item) => <button key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{item[0]!.toUpperCase() + item.slice(1)}</button>)}</nav>
      <section>
        {section === "team" ? <TeamDirectory data={data} agents={agents} /> : section === "machines" && teamId ? <AccountMachines teamId={teamId} /> : section === "machines" ? <Empty text="Team unavailable." /> : <><div className="kw-settings-page-head"><h2>Notifications</h2><p className="kw-muted">Your personal destinations across every Team. The newest one receives new Task assignments.</p></div><NotificationSettings /></>}
      </section>
    </div>
  </Section>;
}

function KernelLogin() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    const res = await fetch("/api/auth/kernel-shared-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!res.ok) { setError("Invalid email or password"); return; }
    window.location.reload();
  }
  return <main className="kw-login"><form onSubmit={submit}><strong>LOOPANY KERNEL</strong><p>Team task workspace</p><label>Email<input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Access password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>{error && <p className="kw-error">{error}</p>}<button>Sign in</button></form><Style /></main>;
}

function Inbox({ data, select }: { data: Obj; select: Function }) {
  return <Section title={`Inbox · ${data.me.email}`} sub="Tasks waiting for your decision or action">
    {data.inbox.length ? data.inbox.map((x: Obj) => <Row key={x.task.id} title={x.task.title} meta={`${x.reason} · ${x.task.status}`} badge={isLoop(data, x.task.id) ? "LOOP" : undefined} onClick={() => select("task", x.task.id)} />) : <Empty text="Inbox is clear" />}
  </Section>;
}

function Tasks({ data, select }: { data: Obj; select: Function }) {
  const storageKey = `loopany-kernel:task-layout:${data.team.id}`;
  const [layout, setLayout] = useState<TaskLayout>(() => {
    if (typeof window === "undefined") return "tree";
    return window.localStorage.getItem(storageKey) === "board" ? "board" : "tree";
  });
  const [showHidden, setShowHidden] = useState(false);
  const chooseLayout = (next: TaskLayout) => {
    setLayout(next);
    window.localStorage.setItem(storageKey, next);
  };
  const render = (nodes: Obj[], depth = 0): React.ReactNode => nodes.map((n) => <div key={n.task.id}><Row title={n.task.title} meta={`${n.task.status} · ${n.task.assignee ?? "unassigned"}`} badge={isLoop(data, n.task.id) ? "LOOP" : undefined} indent={depth} onClick={() => select("task", n.task.id)} />{render(n.children, depth + 1)}</div>);
  const hidden = hiddenTaskCount(data.tasks);
  const controls = <div className="kw-task-controls" aria-label="Task layout">
    <div className="kw-switch">
      {(["tree", "board"] as TaskLayout[]).map((item) => <button key={item} className={layout === item ? "active" : ""} aria-pressed={layout === item} onClick={() => chooseLayout(item)}>{item[0]!.toUpperCase() + item.slice(1)}</button>)}
    </div>
    {hidden > 0 && <button className="kw-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? "Hide" : "Show"} done + idea + archived ({hidden})</button>}
  </div>;
  if (layout === "board") {
    const statuses = showHidden ? ["idea", ...BOARD_STATUSES, "archived"] : BOARD_STATUSES;
    return <Section title="Task Board" sub="Work grouped by current state. Loops are marked at the card edge." action={controls} flush>
      <div className="kw-board">{statuses.map((status) => {
        const tasks = data.tasks.filter((task: Obj) => task.status === status);
        return <section className="kw-column" key={status}><header><strong>{status}</strong><span>{tasks.length}</span></header><div>{tasks.length ? tasks.map((task: Obj) => <BoardCard key={task.id} task={task} loop={isLoop(data, task.id)} onClick={() => select("task", task.id)} />) : <Empty text="No tasks" />}</div></section>;
      })}</div>
    </Section>;
  }
  return <Section title="Task Tree" sub="Parent defines scope. Hidden parents do not hide active children." action={controls}>{render(visibleTaskTree(data.tree, showHidden))}</Section>;
}

function Documents({ data, select }: { data: Obj; select: Function }) {
  return <Section title="Documents" sub="Team artifacts, newest updates first">{[...data.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((d: Obj) => <Row key={d.id} title={d.title ?? d.key} meta={`${d.key} · v${d.version} · ${fmt(d.updatedAt)}`} badge="DOC" onClick={() => select("doc", d.id)} />)}</Section>;
}

function Timeline({ items, select }: { items: Obj[]; select: Function }) {
  return <Section title="Team Timeline" sub="Recent meaningful activity">{items.map((x) => <Row key={x.eventIds.join(":")} title={x.summary} meta={`${fmt(x.at)} · ${x.actor}${x.agent ? ` · ${x.agent}` : ""}${x.agentSessionId ? ` · session ${x.agentSessionId}` : ""}`} badge={x.kind} onClick={() => select(x.runId ? "run" : "task", x.runId ?? x.objectId)} />)}</Section>;
}

function TeamDirectory({ data, agents }: { data: Obj; agents: string[] }) {
  const people = data.members ?? [];
  const machines = data.machines ?? [];
  const setupCommand = `lk setup /${data.team.slug} --server ${typeof window === "undefined" ? "https://your-loopany-server" : window.location.origin}`;
  return <Section title={data.team.name} sub="Canonical people, enrolled machines, and agent execution addresses">
    <div className="kw-directory">
      <DirectoryGroup title="People" count={people.length} description="Members who can work inside this Team.">
        {people.length ? people.map((person: Obj) => <div className="kw-directory-row" key={person.id}><span className="kw-avatar" aria-hidden="true">{person.email[0]?.toUpperCase()}</span><span className="kw-directory-copy"><strong>{person.email}</strong><small>person:{person.id}</small></span><code className="kw-pill">{person.role}</code></div>) : <Empty text="No members" />}
      </DirectoryGroup>
      <DirectoryGroup title="Machines" count={machines.length} description="Computers currently authorized to execute work for this Team.">
        {machines.length ? machines.map((machine: Obj) => <MachineRow key={machine.id} machine={machine} />) : <Empty text="No machines enrolled" />}
      </DirectoryGroup>
      <DirectoryGroup title="Agents" count={agents.length} description="Execution addresses reported by connected Machines.">
        {agents.length ? agents.map((address) => { const entry = data.agentAddresses?.find((item: Obj) => item.address === address); return <div className="kw-directory-row" key={address}><span className="kw-agent-mark" aria-hidden="true">›_</span><span className="kw-directory-copy"><strong>{address}</strong><small>{entry ? `${entry.availability}${entry.lastSucceededAt ? ` · last succeeded ${fmt(entry.lastSucceededAt)}` : ""}` : "Historical execution address"}</small></span><code className={`kw-pill ${entry?.availability === "available" ? "kw-pill-online" : ""}`}>{entry?.availability?.toUpperCase() ?? "OBSERVED"}</code></div>; }) : <Empty text="No agent addresses reported yet" />}
      </DirectoryGroup>
      <div className="kw-setup"><div><span className="kw-eyebrow">CONNECT A COMPUTER</span><h2>Set up this Team</h2><p>Sign in, start the Machine runtime, and authorize this Team in one command.</p></div><CopyCommand command={setupCommand} /></div>
    </div>
  </Section>;
}

function AccountMachines({ teamId }: { teamId: string }) {
  const [value, setValue] = useState<Obj | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/machines");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body.error ?? `HTTP ${response.status}`); return; }
    setValue(body); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function binding(machineId: string, enabled: boolean) {
    const response = await fetch(`/api/machines/${encodeURIComponent(machineId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: enabled ? "enable-binding" : "disable-binding", teamId }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body.error ?? `HTTP ${response.status}`); return; }
    await load();
  }
  return <Section title="My Machines" sub="Physical computers you own. Team access is an explicit, revocable binding.">
    {error && <p className="kw-error">{error}</p>}
    {!value ? <Empty text="Loading machines..." /> : value.machines.length ? <div className="kw-machine-grid">{value.machines.map((machine: Obj) => {
      const active = machine.bindings.find((item: Obj) => item.teamId === teamId)?.enabled === true;
      const personal = value.personalTeamId === teamId;
      return <article className="kw-machine-card" key={machine.id}><header><span className={`kw-status ${machine.online ? "online" : ""}`} aria-hidden="true" /><div><span className="kw-eyebrow">{machine.online ? "ONLINE" : "OFFLINE"}</span><h2>{machine.name}</h2></div></header><dl><dt>Platform</dt><dd>{machine.platform ?? "Unknown"}</dd><dt>Agents</dt><dd>{machine.agentProfiles === null ? "Not reported by this daemon" : machine.agentProfiles.length ? machine.agentProfiles.join(", ") : "None detected"}</dd><dt>Machine ID</dt><dd><code>{machine.id}</code></dd><dt>This Team</dt><dd>{personal ? "Personal Team" : active ? "Authorized" : "Not authorized"}</dd></dl><footer>{personal ? <span className="kw-binding-note">Always available to your Personal Team</span> : <button className={active ? "kw-danger-button" : "kw-primary-button"} onClick={() => void binding(machine.id, !active)}>{active ? "Remove Team access" : "Authorize for this Team"}</button>}</footer></article>;
    })}</div> : <Empty text={`No Machine yet. Run lk setup ${value.teams.find((team: Obj) => team.id === teamId)?.path ?? "/<workspace>"}.`} />}
  </Section>;
}

function DirectoryGroup({ title, count, description, children }: { title: string; count: number; description: string; children: React.ReactNode }) {
  return <section className="kw-directory-group"><header><div><h2>{title}</h2><p>{description}</p></div><span>{String(count).padStart(2, "0")}</span></header><div>{children}</div></section>;
}

function MachineRow({ machine }: { machine: Obj }) {
  return <div className="kw-directory-row"><span className={`kw-status ${machine.online ? "online" : ""}`} aria-hidden="true" /><span className="kw-directory-copy"><strong>{machine.alias ?? machine.name}</strong><small>{machine.name} · {machine.platform ?? "unknown platform"}</small><small>{machine.agentProfiles === null ? "Agent capabilities not reported" : machine.agentProfiles?.length ? `Agents: ${machine.agentProfiles.join(", ")}` : "No executable agents detected"}</small><small>Owned by person:{machine.enrolledBy}</small></span><span className="kw-row-tags"><code className={`kw-pill ${machine.online ? "kw-pill-online" : ""}`}>{machine.online ? "ONLINE" : "OFFLINE"}</code>{machine.mine && <code className="kw-pill">YOURS</code>}</span></div>;
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <div className="kw-command"><code>{command}</code><button onClick={() => void copy()} aria-label="Copy setup command">{copied ? "Copied" : "Copy"}</button></div>;
}

function Detail({ kind, detail, select, teamSlug, reload, assignees }: { kind: string; detail: Obj | null; select: Function; teamSlug: string; reload: Function; assignees: AssigneeOption[] }) {
  if (!detail) return <Empty text="Loading detail..." />;
  if (kind === "doc") return <div><h2>{detail.doc.title ?? detail.doc.key}</h2><div className="kw-meta">DOC · v{detail.doc.version} · {fmt(detail.doc.updatedAt)}</div><pre className="kw-body">{detail.doc.body}</pre>{detail.linkedTasks.map((t: Obj) => <button key={t.id} onClick={() => select("task", t.id)}>Task: {t.title}</button>)}</div>;
  if (kind === "run") { const r = detail.run; const profile = agent(r.assignee); const command = r.agentSessionId ? resumeCommand(profile, r.agentSessionId, detail.task?.workdir) : null; return <div><h2>{r.id}</h2><div className="kw-meta">RUN · {r.state} · {profile ?? "agent unknown"}</div><dl><dt>Task</dt><dd><button onClick={() => select("task", r.taskId)}>{r.taskId}</button></dd><dt>Cause</dt><dd>{r.cause}</dd><dt>Assignee</dt><dd>{r.assignee ?? "-"}</dd><dt>Workdir</dt><dd>{detail.task?.workdir ?? "-"}</dd><dt>Started</dt><dd>{fmt(r.createdAt)}</dd><dt>Workflow</dt><dd>{r.workflow ? `${r.workflow.format} · ${r.workflow.outcome}` : "not configured"}</dd><dt>Agent session</dt><dd>{r.agentSessionId ?? "not recorded"}</dd></dl>{command && <button onClick={() => navigator.clipboard.writeText(command)}>Copy: {command}</button>}<pre className="kw-body">{r.note ?? "No return note yet"}</pre><h3>Artifacts touched</h3>{detail.artifacts.length ? detail.artifacts.map((item: Obj) => item.artifact.archetype === "doc" ? <button key={item.artifact.id} onClick={() => select("doc", item.artifact.id)}>doc · {item.artifact.title ?? item.artifact.key} · {item.actions.join(" + ")}</button> : <div className="kw-event" key={item.artifact.id}>mirror · {item.artifact.coords} · {item.actions.join(" + ")}</div>) : <Empty text="No artifacts recorded for this run" />}</div>; }
  const t = detail.task; return <div><div className="kw-titleline"><h2>{t.title}</h2>{detail.activeRun && <button onClick={() => select("run", detail.activeRun.id)}>RUNNING</button>}</div><div className="kw-meta">{t.id} · v{t.version}</div><dl><dt>Status</dt><dd>{t.status}</dd><dt>Owner</dt><dd>{t.owner ?? "-"}</dd><dt>Assignee</dt><dd>{assigneeLabel(t.assignee, assignees)}</dd><dt>Workdir</dt><dd>{t.workdir ?? "-"}</dd><dt>Goal</dt><dd>{t.goal ?? "-"}</dd><dt>Workflow</dt><dd>{t.workflow?.format ?? "-"}</dd></dl><TaskActions key={t.id} task={t} teamSlug={teamSlug} reload={reload} assignees={assignees} /><h3>Spec</h3><pre className="kw-body">{t.body || "No spec"}</pre><h3>Children</h3>{detail.children.map((c: Obj) => <button key={c.id} onClick={() => select("task", c.id)}>{c.title}</button>)}<h3>Artifacts</h3>{detail.artifacts.map((a: Obj) => <button key={a.artifact.id} onClick={() => select(a.artifact.archetype === "doc" ? "doc" : "task", a.artifact.id)}>{a.artifact.title ?? a.artifact.id}</button>)}<h3>Recent</h3>{detail.recent.map((x: Obj) => <div className="kw-event" key={x.eventIds.join(":")}>{fmt(x.at)} · {x.summary}</div>)}<h3>Runs</h3>{detail.runs.slice(0, 10).map((r: Obj) => <button key={r.id} onClick={() => select("run", r.id)}>{r.state} · {r.workflow ? `workflow ${r.workflow.outcome} · ` : ""}{fmt(r.createdAt)} · {agent(r.assignee) ?? "agent"}</button>)}</div>;
}

function TaskActions({ task, teamSlug, reload, assignees }: { task: Obj; teamSlug: string; reload: Function; assignees: AssigneeOption[] }) {
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(assignees.some((option) => option.value === task.assignee) ? task.assignee : "");
  const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setStatus(task.status), [task.status]);
  useEffect(() => { if (assignee && !assignees.some((option) => option.value === assignee)) setAssignee(""); }, [assignees, assignee]);
  async function send(command: Obj) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/kernel/web/command?teamSlug=${encodeURIComponent(teamSlug)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.refusal?.message ?? body.error ?? `HTTP ${res.status}`); return; }
      setNote(""); await reload();
    } finally { setBusy(false); }
  }
  return <div className="kw-actions">
    <div className="kw-action-row"><label><strong>Set status</strong><span>Update this task without dispatching an agent.</span></label><select value={status} disabled={busy} onChange={(e) => setStatus(e.target.value)}>{["idea", "todo", "in-progress", "done", "archived"].map((value) => <option key={value}>{value}</option>)}</select><button disabled={busy || status === task.status} onClick={() => void send({ op: "update", id: task.id, patch: { status }, note: `Human set ${status}`, ifVersion: task.version })}>Apply</button></div>
    <div className="kw-action-handoff"><label htmlFor={`handoff-${task.id}`}><strong>Hand off</strong><span>{assignee.startsWith("person:") ? "This sends the Task to the person's Inbox." : "Choosing an Agent sets the Task to todo and starts an assignment Run."}</span></label><textarea id={`handoff-${task.id}`} placeholder="What should they decide or do next?" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /><div className="kw-action-row"><AssigneePicker value={assignee} options={assignees} disabled={busy} onChange={setAssignee} /><button className="kw-primary" disabled={busy || !note.trim() || !assignee} onClick={() => void send({ op: "update", id: task.id, patch: { assignee, status: "todo" }, note: note.trim(), ifVersion: task.version })}>{busy ? "Sending..." : "Hand off"}</button></div>
    </div>
    {error && <div className="kw-error">{error}</div>}
  </div>;
}

function isLoop(data: Obj, id: string) { return data.triggers.some((t: Obj) => t.taskId === id && t.kind === "cron"); }
function BoardCard({ task, loop, onClick }: { task: Obj; loop: boolean; onClick: () => void }) { return <button className="kw-card" onClick={onClick}><span className="kw-card-top"><strong>{task.title}</strong>{loop && <code>LOOP</code>}</span><small>{task.assignee ?? "unassigned"}</small>{task.priority && <span className="kw-card-priority">{task.priority}</span>}</button>; }
function Section({ title, sub, children, action, flush = false }: { title: string; sub: string; children: React.ReactNode; action?: React.ReactNode; flush?: boolean }) { return <section><div className="kw-section-head"><div><h1>{title}</h1><p className="kw-muted">{sub}</p></div>{action}</div><div className={flush ? "kw-list kw-list-flush" : "kw-list"}>{children}</div></section>; }
function Row({ title, meta, badge, indent = 0, onClick }: { title: string; meta: string; badge?: string; indent?: number; onClick: () => void }) { return <button className="kw-row" style={{ paddingLeft: 12 + indent * 22 }} onClick={onClick}>{indent > 0 && <span className="kw-tree">└</span>}<span><strong>{title}</strong><small>{meta}</small></span>{badge && <code>{badge}</code>}</button>; }
function Empty({ text }: { text: string }) { return <div className="kw-empty">{text}</div>; }

function Style() { return <style>{`
.kw-grid.kw-grid-settings{grid-template-columns:160px minmax(0,1fr)}.kw-grid-settings .kw-main{border-right:0}@media(max-width:900px){.kw-grid.kw-grid-settings{grid-template-columns:120px 1fr}}
*{box-sizing:border-box}.kw-root,.kw-login{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#171717;background:#fafafa;min-height:100vh;font-size:13px}button,input,textarea,select{font:inherit}.kw-head{height:44px;border-bottom:1px solid #bbb;display:flex;align-items:center;gap:20px;padding:0 104px 0 12px}.kw-head button,.kw-detail button,.kw-actions button{border:1px solid #aaa;background:#fff;padding:5px 8px;cursor:pointer}.kw-spacer{flex:1}.kw-muted,.kw-meta{color:#666}.kw-grid{display:grid;grid-template-columns:160px minmax(360px,1fr) minmax(320px,42%);height:calc(100vh - 72px)}.kw-nav,.kw-main,.kw-detail{overflow:auto}.kw-nav{border-right:1px solid #bbb;padding:10px;display:flex;flex-direction:column;justify-content:space-between}.kw-nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:9px}.kw-nav button.active{background:#171717;color:#fff}.kw-nav-bottom{display:flex;flex-direction:column;gap:6px}.kw-nav-foot{line-height:1.8;color:#666;padding:8px}.kw-main{padding:18px;border-right:1px solid #bbb}.kw-detail{padding:18px}.kw-foot{height:28px;border-top:1px solid #bbb;display:flex;align-items:center;justify-content:space-between;padding:0 12px}.kw-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.kw-section-head h1,.kw-section-head p{margin-top:0}.kw-settings{display:grid;grid-template-columns:150px minmax(0,1fr);border:1px solid #bbb;min-height:360px}.kw-settings>nav{border-right:1px solid #bbb;padding:10px}.kw-settings>nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:9px}.kw-settings>nav button.active{background:#171717;color:#fff}.kw-settings>section{padding:18px}.kw-settings>section h2{margin:0 0 6px;font-size:16px}.kw-task-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.kw-switch{display:flex}.kw-switch button,.kw-hidden-toggle{border:1px solid #aaa;background:#fff;padding:5px 8px;cursor:pointer}.kw-switch button+button{border-left:0}.kw-switch button.active{background:#171717;color:#fff}.kw-hidden-toggle{color:#555}.kw-list{border-top:1px solid #bbb;margin-top:18px}.kw-list-flush{border-top:0}.kw-row{display:flex;width:100%;align-items:center;gap:8px;text-align:left;border:0;border-bottom:1px solid #ddd;background:transparent;padding:11px 12px;cursor:pointer}.kw-row:hover,.kw-card:hover{background:#eee}.kw-row>span:not(.kw-tree){display:flex;flex-direction:column;gap:4px;min-width:0}.kw-row strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kw-row small{color:#666}.kw-row code{margin-left:auto;border:1px solid #aaa;padding:2px 4px;font-size:10px}.kw-tree{color:#999}.kw-board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:0;border:1px solid #aaa;overflow-x:auto}.kw-column{min-width:190px;border-right:1px solid #aaa}.kw-column:last-child{border-right:0}.kw-column>header{height:36px;border-bottom:1px solid #aaa;display:flex;align-items:center;justify-content:space-between;padding:0 9px;text-transform:uppercase;font-size:11px}.kw-column>header span{color:#666}.kw-card{position:relative;display:block;width:100%;min-height:76px;text-align:left;border:0;border-bottom:1px solid #ccc;background:#fff;padding:10px;cursor:pointer}.kw-card-top{display:flex;align-items:flex-start;gap:6px}.kw-card-top strong{flex:1;line-height:1.35}.kw-card code{font-size:9px;border:1px solid #777;padding:1px 3px}.kw-card small{display:block;color:#666;margin-top:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kw-card-priority{position:absolute;right:9px;bottom:9px;font-size:10px}.kw-empty{padding:28px;color:#777;text-align:center}.kw-detail h2{font-size:18px;margin:0 0 6px}.kw-detail h3{font-size:12px;text-transform:uppercase;margin:24px 0 8px}.kw-detail dl{display:grid;grid-template-columns:90px 1fr;gap:7px;margin:18px 0}.kw-detail dt{color:#666}.kw-detail dd{margin:0;overflow-wrap:anywhere}.kw-body{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;border-top:1px solid #ccc;border-bottom:1px solid #ccc;padding:12px 0}.kw-detail>div>button{display:block;margin:5px 0;text-align:left}.kw-titleline{display:flex;justify-content:space-between}.kw-event{border-bottom:1px solid #ddd;padding:7px 0}.kw-actions{border:1px solid #aaa;margin:16px 0}.kw-action-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:7px;align-items:center;padding:9px}.kw-action-row label,.kw-action-handoff>label{display:flex;flex-direction:column;gap:3px}.kw-action-row label span,.kw-action-handoff label span{color:#666;font-size:11px;line-height:1.4}.kw-action-row select,.kw-action-row input,.kw-action-handoff textarea{border:1px solid #aaa;background:#fff;padding:6px}.kw-action-handoff{border-top:1px solid #bbb;padding:9px}.kw-action-handoff textarea{display:block;width:100%;min-height:64px;margin-top:8px}.kw-action-handoff .kw-action-row{padding:7px 0 0;grid-template-columns:minmax(0,1fr) auto}.kw-actions button.kw-primary{background:#171717;color:#fff;border-color:#171717}.kw-actions button:disabled{cursor:not-allowed;color:#999;background:#eee;border-color:#ccc}.kw-actions>.kw-error{padding:0 9px 9px}.kw-error{color:#b42318}.kw-login{display:grid;place-items:center}.kw-login form{width:340px;border:1px solid #999;padding:24px;background:#fff}.kw-login form>strong{font-size:18px}.kw-login label{display:block;margin:16px 0 5px}.kw-login input{display:block;width:100%;border:1px solid #888;padding:9px;margin-top:5px}.kw-login button{width:100%;background:#171717;color:#fff;border:0;padding:10px}.kw-directory{display:grid;gap:18px}.kw-directory-group{border:1px solid #c8c8c8;background:#fff}.kw-directory-group>header{display:flex;align-items:flex-start;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #d5d5d5;background:#f3f3f1}.kw-directory-group>header h2{font-size:14px;margin:0 0 4px}.kw-directory-group>header p{font-size:11px;color:#666;margin:0;line-height:1.45}.kw-directory-group>header>span{font-size:20px;line-height:1;color:#999}.kw-directory-row{display:flex;align-items:center;gap:11px;padding:13px 14px;border-bottom:1px solid #e2e2e2;min-width:0}.kw-directory-row:last-child{border-bottom:0}.kw-directory-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.kw-directory-copy strong{overflow:hidden;text-overflow:ellipsis}.kw-directory-copy small{color:#6a6a6a;overflow-wrap:anywhere}.kw-avatar,.kw-agent-mark{display:grid;place-items:center;width:32px;height:32px;flex:none;border:1px solid #aaa;background:#f7f7f5;font-weight:700}.kw-agent-mark{font-size:11px;color:#555}.kw-pill{border:1px solid #aaa;padding:3px 5px;font-size:9px;white-space:nowrap;background:#fafafa}.kw-pill-online{border-color:#16734a;color:#11613e;background:#edf8f2}.kw-row-tags{display:flex;gap:5px;align-items:center}.kw-status{width:10px;height:10px;flex:none;border-radius:50%;background:#aaa;box-shadow:0 0 0 4px #eee}.kw-status.online{background:#168857;box-shadow:0 0 0 4px #dff4e8}.kw-setup{border:1px solid #9d9d9d;background:#ecece8;padding:16px;display:grid;gap:14px}.kw-setup h2{margin:4px 0 5px;font-size:16px}.kw-setup p{margin:0;color:#5b5b5b;line-height:1.5}.kw-eyebrow{font-size:9px;letter-spacing:.12em;color:#666;font-weight:700}.kw-command{display:flex;min-width:0;border:1px solid #171717;background:#171717;color:#f7f7f2}.kw-command code{padding:11px 12px;overflow:auto;white-space:nowrap;flex:1}.kw-command button{border:0;border-left:1px solid #555;background:#292929;color:#fff;padding:0 14px;cursor:pointer}.kw-command button:hover{background:#3b3b3b}.kw-machine-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px;padding-top:18px}.kw-machine-card{border:1px solid #aaa;background:#fff;min-width:0}.kw-machine-card>header{display:flex;gap:13px;align-items:center;padding:16px;border-bottom:1px solid #d2d2d2;background:#f3f3f1}.kw-machine-card>header h2{font-size:15px;margin:4px 0 0;overflow-wrap:anywhere}.kw-machine-card dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:9px 12px;padding:15px;margin:0}.kw-machine-card dt{color:#777}.kw-machine-card dd{margin:0;overflow-wrap:anywhere}.kw-machine-card dd code{font-size:10px}.kw-machine-card>footer{min-height:48px;border-top:1px solid #ddd;padding:10px 15px;display:flex;align-items:center}.kw-machine-card button{width:100%;padding:7px 9px;cursor:pointer}.kw-primary-button{border:1px solid #171717;background:#171717;color:#fff}.kw-danger-button{border:1px solid #9b3a32;background:#fff;color:#8a2922}.kw-binding-note{font-size:11px;color:#666}.kw-directory button:focus-visible,.kw-machine-card button:focus-visible{outline:2px solid #166a9c;outline-offset:2px}@media(max-width:900px){.kw-grid{grid-template-columns:120px 1fr}.kw-detail{position:fixed;inset:44px 0 28px 120px;background:#fafafa;border-left:1px solid #bbb}.kw-detail:has(.kw-empty){display:none}.kw-section-head{display:block}.kw-settings{grid-template-columns:1fr}.kw-settings>nav{border-right:0;border-bottom:1px solid #bbb}.kw-task-controls{justify-content:flex-start}.kw-board{grid-template-columns:repeat(4,190px)}.kw-action-row{grid-template-columns:1fr auto}.kw-action-row label{grid-column:1/-1}.kw-machine-grid{grid-template-columns:1fr}}@media(max-width:600px){.kw-command{display:block}.kw-command button{width:100%;padding:9px;border-left:0;border-top:1px solid #555}.kw-directory-row{align-items:flex-start}.kw-row-tags{flex-direction:column;align-items:flex-end}}`}</style>; }
