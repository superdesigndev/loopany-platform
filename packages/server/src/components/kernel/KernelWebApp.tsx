import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient, useSession } from "../../lib/auth-client";
import { BOARD_STATUSES, hiddenTaskCount, visibleTaskTree } from "./taskLayouts";

type Obj = Record<string, any>;
type View = "inbox" | "tasks" | "documents" | "timeline";
type TaskLayout = "tree" | "board";
type Selection = { kind: "task" | "doc" | "run"; id: string };
type LoadedDetail = Selection & { value: Obj };

const fmt = (iso?: string) => iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "-";
const agent = (assignee?: string | null) => assignee?.includes("/") ? assignee.split("/").pop() : null;

export function KernelWebApp({ teamId }: { teamId: string }) {
  const { data: session, isPending } = useSession();
  const [view, setView] = useState<View>("inbox");
  const [data, setData] = useState<Obj | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/kernel/web/workspace?teamId=${encodeURIComponent(teamId)}`);
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setData(await res.json()); setRefreshed(new Date()); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [teamId]);

  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    const requested = selected;
    const plural = selected.kind === "task" ? "tasks" : selected.kind === "doc" ? "docs" : "runs";
    const res = await fetch(`/api/kernel/web/${plural}/${encodeURIComponent(selected.id)}?teamId=${encodeURIComponent(teamId)}`);
    if (res.ok) setDetail({ ...requested, value: await res.json() });
  }, [selected, teamId]);

  useEffect(() => {
    if (!session) return;
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", visible); };
  }, [session, load]);
  useEffect(() => { if (session) void loadDetail(); }, [session, loadDetail, data?.generatedAt]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key.toLowerCase() === "r") void load();
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [load]);

  if (isPending) return <main className="kw-login">Loading session...</main>;
  if (!session) return <KernelLogin />;

  const select = (kind: "task" | "doc" | "run", id: string) => { setDetail(null); setSelected({ kind, id }); };
  const selectedDetail = selected && detail?.kind === selected.kind && detail.id === selected.id ? detail.value : null;
  return <div className="kw-root">
    <header className="kw-head">
      <strong>LOOPANY KERNEL</strong><span>{data?.team?.name ?? teamId}</span><span className="kw-muted">{session.user.email}</span>
      <span className="kw-spacer" />
      <span>{data?.activeRuns?.length ?? 0} running</span>
      <button onClick={() => void load()}>R Refresh</button>
      <button onClick={() => void authClient.signOut()}>Sign out</button>
    </header>
    <div className="kw-grid">
      <nav className="kw-nav">
        {(["inbox", "tasks", "documents", "timeline"] as View[]).map((v) =>
          <button key={v} className={view === v ? "active" : ""} onClick={() => { setView(v); setSelected(null); }}>
            {v[0]!.toUpperCase() + v.slice(1)}{v === "inbox" && data ? `  ${data.inbox.length}` : ""}
          </button>)}
        <div className="kw-nav-foot">Tasks {data?.tasks?.length ?? 0}<br />Loops {data?.triggers?.filter((t: Obj) => t.kind === "cron").length ?? 0}<br />Docs {data?.documents?.length ?? 0}</div>
      </nav>
      <main className="kw-main">
        {!data ? <Empty text={error || "Loading workspace..."} /> : view === "inbox" ? <Inbox data={data} select={select} />
          : view === "tasks" ? <Tasks data={data} select={select} />
          : view === "documents" ? <Documents data={data} select={select} />
          : <Timeline items={data.recentTimeline} select={select} />}
      </main>
      <aside className="kw-detail">{selected ? <Detail kind={selected.kind} detail={selectedDetail} select={select} teamId={teamId} reload={load} /> : <Empty text="Select an item to inspect" />}</aside>
    </div>
    <footer className="kw-foot"><span>R refresh · Esc close detail</span><span className={error ? "kw-error" : ""}>{error || `updated ${refreshed ? fmt(refreshed.toISOString()) : "-"}`}</span></footer>
    <Style />
  </div>;
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
    {hidden > 0 && <button className="kw-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? "Hide" : "Show"} idea + archived ({hidden})</button>}
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

function Detail({ kind, detail, select, teamId, reload }: { kind: string; detail: Obj | null; select: Function; teamId: string; reload: Function }) {
  if (!detail) return <Empty text="Loading detail..." />;
  if (kind === "doc") return <div><h2>{detail.doc.title ?? detail.doc.key}</h2><div className="kw-meta">DOC · v{detail.doc.version} · {fmt(detail.doc.updatedAt)}</div><pre className="kw-body">{detail.doc.body}</pre>{detail.linkedTasks.map((t: Obj) => <button key={t.id} onClick={() => select("task", t.id)}>Task: {t.title}</button>)}</div>;
  if (kind === "run") { const r = detail.run; const profile = agent(r.assignee); const command = r.agentSessionId ? (profile === "codex" ? `codex resume ${r.agentSessionId}` : `claude --resume ${r.agentSessionId}`) : null; return <div><h2>{r.id}</h2><div className="kw-meta">RUN · {r.state} · {profile ?? "agent unknown"}</div><dl><dt>Task</dt><dd><button onClick={() => select("task", r.taskId)}>{r.taskId}</button></dd><dt>Cause</dt><dd>{r.cause}</dd><dt>Assignee</dt><dd>{r.assignee ?? "-"}</dd><dt>Started</dt><dd>{fmt(r.createdAt)}</dd><dt>Agent session</dt><dd>{r.agentSessionId ?? "not recorded"}</dd></dl>{command && <button onClick={() => navigator.clipboard.writeText(command)}>Copy: {command}</button>}<pre className="kw-body">{r.note ?? "No return note yet"}</pre></div>; }
  const t = detail.task; return <div><div className="kw-titleline"><h2>{t.title}</h2>{detail.activeRun && <button onClick={() => select("run", detail.activeRun.id)}>RUNNING</button>}</div><div className="kw-meta">{t.id} · v{t.version}</div><dl><dt>Status</dt><dd>{t.status}</dd><dt>Owner</dt><dd>{t.owner ?? "-"}</dd><dt>Assignee</dt><dd>{t.assignee ?? "-"}</dd><dt>Workdir</dt><dd>{t.workdir ?? "-"}</dd><dt>Goal</dt><dd>{t.goal ?? "-"}</dd></dl><TaskActions task={t} teamId={teamId} reload={reload} /><h3>Spec</h3><pre className="kw-body">{t.body || "No spec"}</pre><h3>Children</h3>{detail.children.map((c: Obj) => <button key={c.id} onClick={() => select("task", c.id)}>{c.title}</button>)}<h3>Artifacts</h3>{detail.artifacts.map((a: Obj) => <button key={a.artifact.id} onClick={() => select(a.artifact.archetype === "doc" ? "doc" : "task", a.artifact.id)}>{a.artifact.title ?? a.artifact.id}</button>)}<h3>Recent</h3>{detail.recent.map((x: Obj) => <div className="kw-event" key={x.eventIds.join(":")}>{fmt(x.at)} · {x.summary}</div>)}<h3>Runs</h3>{detail.runs.slice(0, 10).map((r: Obj) => <button key={r.id} onClick={() => select("run", r.id)}>{r.state} · {fmt(r.createdAt)} · {agent(r.assignee) ?? "agent"}</button>)}</div>;
}

function TaskActions({ task, teamId, reload }: { task: Obj; teamId: string; reload: Function }) {
  const [note, setNote] = useState("");
  async function send(command: Obj) { const res = await fetch(`/api/kernel/web/command?teamId=${encodeURIComponent(teamId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) }); if (res.ok) { setNote(""); await reload(); } }
  return <div className="kw-actions"><textarea placeholder="Leave a decision or note" value={note} onChange={(e) => setNote(e.target.value)} /><button disabled={!note.trim()} onClick={() => void send({ op: "note", id: task.id, note })}>Add note</button>{["todo", "in-progress", "done", "archived"].map((status) => <button key={status} onClick={() => void send({ op: "update", id: task.id, patch: { status }, note: note || `Human set ${status}`, ifVersion: task.version })}>{status}</button>)}</div>;
}

function isLoop(data: Obj, id: string) { return data.triggers.some((t: Obj) => t.taskId === id && t.kind === "cron"); }
function BoardCard({ task, loop, onClick }: { task: Obj; loop: boolean; onClick: () => void }) { return <button className="kw-card" onClick={onClick}><span className="kw-card-top"><strong>{task.title}</strong>{loop && <code>LOOP</code>}</span><small>{task.assignee ?? "unassigned"}</small>{task.priority && <span className="kw-card-priority">{task.priority}</span>}</button>; }
function Section({ title, sub, children, action, flush = false }: { title: string; sub: string; children: React.ReactNode; action?: React.ReactNode; flush?: boolean }) { return <section><div className="kw-section-head"><div><h1>{title}</h1><p className="kw-muted">{sub}</p></div>{action}</div><div className={flush ? "kw-list kw-list-flush" : "kw-list"}>{children}</div></section>; }
function Row({ title, meta, badge, indent = 0, onClick }: { title: string; meta: string; badge?: string; indent?: number; onClick: () => void }) { return <button className="kw-row" style={{ paddingLeft: 12 + indent * 22 }} onClick={onClick}>{indent > 0 && <span className="kw-tree">└</span>}<span><strong>{title}</strong><small>{meta}</small></span>{badge && <code>{badge}</code>}</button>; }
function Empty({ text }: { text: string }) { return <div className="kw-empty">{text}</div>; }

function Style() { return <style>{`
*{box-sizing:border-box}.kw-root,.kw-login{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#171717;background:#fafafa;min-height:100vh;font-size:13px}button,input,textarea{font:inherit}.kw-head{height:44px;border-bottom:1px solid #bbb;display:flex;align-items:center;gap:20px;padding:0 12px}.kw-head button,.kw-detail button,.kw-actions button{border:1px solid #aaa;background:#fff;padding:5px 8px;cursor:pointer}.kw-spacer{flex:1}.kw-muted,.kw-meta{color:#666}.kw-grid{display:grid;grid-template-columns:160px minmax(360px,1fr) minmax(320px,42%);height:calc(100vh - 72px)}.kw-nav,.kw-main,.kw-detail{overflow:auto}.kw-nav{border-right:1px solid #bbb;padding:10px}.kw-nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:9px}.kw-nav button.active{background:#171717;color:#fff}.kw-nav-foot{position:absolute;bottom:38px;line-height:1.8;color:#666;padding:8px}.kw-main{padding:18px;border-right:1px solid #bbb}.kw-detail{padding:18px}.kw-foot{height:28px;border-top:1px solid #bbb;display:flex;align-items:center;justify-content:space-between;padding:0 12px}.kw-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.kw-section-head h1,.kw-section-head p{margin-top:0}.kw-task-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.kw-switch{display:flex}.kw-switch button,.kw-hidden-toggle{border:1px solid #aaa;background:#fff;padding:5px 8px;cursor:pointer}.kw-switch button+button{border-left:0}.kw-switch button.active{background:#171717;color:#fff}.kw-hidden-toggle{color:#555}.kw-list{border-top:1px solid #bbb;margin-top:18px}.kw-list-flush{border-top:0}.kw-row{display:flex;width:100%;align-items:center;gap:8px;text-align:left;border:0;border-bottom:1px solid #ddd;background:transparent;padding:11px 12px;cursor:pointer}.kw-row:hover,.kw-card:hover{background:#eee}.kw-row>span:not(.kw-tree){display:flex;flex-direction:column;gap:4px;min-width:0}.kw-row strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kw-row small{color:#666}.kw-row code{margin-left:auto;border:1px solid #aaa;padding:2px 4px;font-size:10px}.kw-tree{color:#999}.kw-board{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:0;border:1px solid #aaa;overflow-x:auto}.kw-column{min-width:190px;border-right:1px solid #aaa}.kw-column:last-child{border-right:0}.kw-column>header{height:36px;border-bottom:1px solid #aaa;display:flex;align-items:center;justify-content:space-between;padding:0 9px;text-transform:uppercase;font-size:11px}.kw-column>header span{color:#666}.kw-card{position:relative;display:block;width:100%;min-height:76px;text-align:left;border:0;border-bottom:1px solid #ccc;background:#fff;padding:10px;cursor:pointer}.kw-card-top{display:flex;align-items:flex-start;gap:6px}.kw-card-top strong{flex:1;line-height:1.35}.kw-card code{font-size:9px;border:1px solid #777;padding:1px 3px}.kw-card small{display:block;color:#666;margin-top:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kw-card-priority{position:absolute;right:9px;bottom:9px;font-size:10px}.kw-empty{padding:28px;color:#777;text-align:center}.kw-detail h2{font-size:18px;margin:0 0 6px}.kw-detail h3{font-size:12px;text-transform:uppercase;margin:24px 0 8px}.kw-detail dl{display:grid;grid-template-columns:90px 1fr;gap:7px;margin:18px 0}.kw-detail dt{color:#666}.kw-detail dd{margin:0;overflow-wrap:anywhere}.kw-body{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;border-top:1px solid #ccc;border-bottom:1px solid #ccc;padding:12px 0}.kw-detail>div>button{display:block;margin:5px 0;text-align:left}.kw-titleline{display:flex;justify-content:space-between}.kw-event{border-bottom:1px solid #ddd;padding:7px 0}.kw-actions{border:1px solid #bbb;padding:8px;margin:16px 0;display:flex;gap:5px;flex-wrap:wrap}.kw-actions textarea{width:100%;min-height:50px;border:1px solid #aaa;padding:6px}.kw-error{color:#b42318}.kw-login{display:grid;place-items:center}.kw-login form{width:340px;border:1px solid #999;padding:24px;background:#fff}.kw-login form>strong{font-size:18px}.kw-login label{display:block;margin:16px 0 5px}.kw-login input{display:block;width:100%;border:1px solid #888;padding:9px;margin-top:5px}.kw-login button{width:100%;background:#171717;color:#fff;border:0;padding:10px}@media(max-width:900px){.kw-grid{grid-template-columns:120px 1fr}.kw-detail{position:fixed;inset:44px 0 28px 120px;background:#fafafa;border-left:1px solid #bbb}.kw-detail:has(.kw-empty){display:none}.kw-section-head{display:block}.kw-task-controls{justify-content:flex-start}.kw-board{grid-template-columns:repeat(4,190px)}}`}</style>; }
