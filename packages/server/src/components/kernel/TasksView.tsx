import { useMemo, useState } from "react";
import { isLoop, isSelected, type Obj, type Select, type Selection, type TaskLayout } from "./model";
import { Empty, Row, Section } from "./primitives";
import { button, cx, selectableCard } from "./styles";
import { DEFAULT_TASK_STATUSES, filterTaskTree, taskMatchesFilters, TASK_STATUSES } from "./taskLayouts";
import { AssigneeRef } from "./IdentityRefs";

type TaskSearch = { q?: string; owner?: string; status?: string };

export function TasksView({ data, selection, select, search = {}, setSearch = () => {} }: { data: Obj; selection: Selection | null; select: Select; search?: TaskSearch; setSearch?: (next: TaskSearch) => void }) {
  const storageKey = `loopany-kernel:task-layout:${data.team.id}`;
  const [layout, setLayout] = useState<TaskLayout>(() => {
    if (typeof window === "undefined") return "tree";
    return window.localStorage.getItem(storageKey) === "board" ? "board" : "tree";
  });
  const query = search.q ?? "";
  const owner = search.owner ?? null;
  const statuses = useMemo(() => {
    if (!search.status) return [...DEFAULT_TASK_STATUSES];
    if (search.status === "none") return [];
    const selected = search.status.split(",").filter((value) => TASK_STATUSES.includes(value as typeof TASK_STATUSES[number]));
    return selected.length ? selected : [...DEFAULT_TASK_STATUSES];
  }, [search.status]);
  const collapsedKey = `loopany-kernel:task-collapsed:${data.team.id}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(window.localStorage.getItem(collapsedKey) ?? "[]")); } catch { return new Set(); }
  });
  const setFilter = setSearch;
  const filteredTree = useMemo(() => filterTaskTree(data.tree, { query, owner, statuses }), [data.tree, query, owner, statuses]);
  const toggleCollapsed = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    window.localStorage.setItem(collapsedKey, JSON.stringify([...next]));
    return next;
  });
  const chooseLayout = (next: TaskLayout) => {
    setLayout(next);
    window.localStorage.setItem(storageKey, next);
  };
  const controls = <TaskControls
    layout={layout}
    onLayout={chooseLayout}
    data={data}
    query={query}
    owner={owner}
    statuses={statuses}
    onFilter={setFilter}
    onCollapseAll={() => {
      const ids = data.tasks.map((task: Obj) => task.id);
      setCollapsed(new Set(ids));
      window.localStorage.setItem(collapsedKey, JSON.stringify(ids));
    }}
    onExpandAll={() => { setCollapsed(new Set()); window.localStorage.setItem(collapsedKey, "[]"); }}
  />;

  if (layout === "board") {
    const boardStatuses = TASK_STATUSES.filter((status) => statuses.includes(status));
    return <Section title="Task Board" sub="Work grouped by current state. Loops are marked at the card edge." action={controls} flush>
      <div className="grid overflow-x-auto border border-[#aaa]" style={{ gridTemplateColumns: `repeat(${Math.max(boardStatuses.length, 1)}, minmax(190px, 1fr))` }}>
        {boardStatuses.map((status) => <BoardColumn key={status} data={{ ...data, tasks: data.tasks.filter((task: Obj) => taskMatchesFilters(task as { id: string; title: string; status: string; owner?: string | null }, { query, owner, statuses })) }} status={status} selection={selection} select={select} />)}
      </div>
    </Section>;
  }
  return <Section title="Task Tree" sub="Parent defines scope. Matching children retain their ancestor context." action={controls}>
    {filteredTree.length ? <TaskTree data={data} nodes={filteredTree} selection={selection} select={select} collapsed={collapsed} toggleCollapsed={toggleCollapsed} forceOpen={Boolean(query || owner || search.status)} /> : <Empty text="No matching tasks" />}
  </Section>;
}

function TaskControls({ layout, onLayout, data, query, owner, statuses, onFilter, onCollapseAll, onExpandAll }: { layout: TaskLayout; onLayout: (next: TaskLayout) => void; data: Obj; query: string; owner: string | null; statuses: string[]; onFilter: (next: { q?: string; owner?: string; status?: string }) => void; onCollapseAll: () => void; onExpandAll: () => void }) {
  const owners = data.members ?? [];
  return <div className="flex max-w-[720px] flex-wrap items-center justify-end gap-2 max-[900px]:mt-3 max-[900px]:justify-start" aria-label="Task filters">
    <input aria-label="Search tasks" className="h-8 min-w-[170px] border border-[#aaa] bg-transparent px-2" placeholder="Search tasks..." value={query} onChange={(event) => onFilter({ q: event.target.value || undefined })} />
    <select aria-label="Filter by owner" className="h-8 border border-[#aaa] bg-transparent px-2" value={owner ?? ""} onChange={(event) => onFilter({ owner: event.target.value || undefined })}>
      <option value="">Anyone</option><option value="unowned">Unowned</option>
      {owners.map((person: Obj) => <option key={person.id} value={`person:${person.id}`}>{person.id === data.me?.id ? "Me - " : ""}{person.name || person.email}</option>)}
    </select>
    <details className="relative">
      <summary className={cx(button(), "h-8 cursor-pointer list-none")}>Status: {statuses.length === DEFAULT_TASK_STATUSES.length && statuses.every((value) => DEFAULT_TASK_STATUSES.includes(value as typeof DEFAULT_TASK_STATUSES[number])) ? "Open" : statuses.length === TASK_STATUSES.length ? "All" : statuses.length}</summary>
      <div className="absolute right-0 z-10 mt-1 min-w-[180px] border border-[#999] bg-[#fafafa] p-2 shadow-[3px_3px_0_#bbb]">
        {TASK_STATUSES.map((status) => <label key={status} className="flex cursor-pointer items-center gap-2 py-1"><input type="checkbox" checked={statuses.includes(status)} onChange={() => {
          const next = statuses.includes(status) ? statuses.filter((item) => item !== status) : [...statuses, status];
          onFilter({ status: next.length ? next.join(",") : "none" });
        }} />{status}</label>)}
        <div className="mt-2 flex gap-2 border-t border-[#ccc] pt-2"><button className="underline" onClick={() => onFilter({ status: undefined })}>Open</button><button className="underline" onClick={() => onFilter({ status: TASK_STATUSES.join(",") })}>All</button></div>
      </div>
    </details>
    <div className="flex [&>button+button]:border-l-0">
      {(["tree", "board"] as TaskLayout[]).map((item) => <button
        key={item}
        className={button(layout === item ? "active" : "default")}
        aria-pressed={layout === item}
        onClick={() => onLayout(item)}
      >{item[0]!.toUpperCase() + item.slice(1)}</button>)}
    </div>
    {layout === "tree" && <><button className={button()} onClick={onCollapseAll}>Collapse all</button><button className={button()} onClick={onExpandAll}>Expand all</button></>}
  </div>;
}

function TaskTree({ data, nodes, selection, select, collapsed, toggleCollapsed, forceOpen, depth = 0 }: { data: Obj; nodes: Obj[]; selection: Selection | null; select: Select; collapsed: Set<string>; toggleCollapsed: (id: string) => void; forceOpen: boolean; depth?: number }): React.ReactNode {
  return nodes.map((node) => <div key={node.task.id}>
    <div className={cx(node.contextOnly && "opacity-55", "relative")}>
      {node.children.length > 0 && <button aria-label={`${collapsed.has(node.task.id) ? "Expand" : "Collapse"} ${node.task.title}`} className="absolute top-[13px] z-[1] w-5 text-center" style={{ left: 8 + depth * 22 }} onClick={(event) => { event.stopPropagation(); toggleCollapsed(node.task.id); }}>{collapsed.has(node.task.id) && !forceOpen ? "+" : "-"}</button>}
      <Row
      title={node.task.title}
      meta={<>{node.task.status} · <AssigneeRef value={node.task.assignee} data={data} select={select} />{node.contextOnly ? " · context" : ""}</>}
      badge={isLoop(data, node.task.id) ? "LOOP" : undefined}
      indent={depth + (node.children.length > 0 ? 1 : 0)}
      selected={isSelected(selection, "task", node.task.id)}
      onClick={() => select("task", node.task.id)}
      />
    </div>
    {(!collapsed.has(node.task.id) || forceOpen) && <TaskTree data={data} nodes={node.children} selection={selection} select={select} collapsed={collapsed} toggleCollapsed={toggleCollapsed} forceOpen={forceOpen} depth={depth + 1} />}
  </div>);
}

function BoardColumn({ data, status, selection, select }: { data: Obj; status: string; selection: Selection | null; select: Select }) {
  const tasks = data.tasks.filter((task: Obj) => task.status === status);
  return <section className="min-w-[190px] border-r border-[#aaa] last:border-r-0">
    <header className="flex h-9 items-center justify-between border-b border-[#aaa] px-[9px] text-[11px] uppercase">
      <strong>{status}</strong><span className="text-[#666]">{tasks.length}</span>
    </header>
    <div>
      {tasks.length
        ? tasks.map((task: Obj) => <BoardCard
          key={task.id}
          task={task}
          loop={isLoop(data, task.id)}
          selected={isSelected(selection, "task", task.id)}
          data={data}
          select={select}
          onClick={() => select("task", task.id)}
        />)
        : <Empty text="No tasks" />}
    </div>
  </section>;
}

function BoardCard({ task, loop, selected, data, select, onClick }: { task: Obj; loop: boolean; selected: boolean; data: Obj; select: Select; onClick: () => void }) {
  return <div
    role="button"
    tabIndex={0}
    className={cx("relative block min-h-[76px] w-full cursor-pointer border-b border-[#ccc] p-2.5 text-left", selectableCard(selected))}
    aria-current={selected || undefined}
    onClick={onClick}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
  >
    <span className="flex items-start gap-1.5">
      <strong className="flex-1 leading-[1.35]">{task.title}</strong>
      {loop && <code className="border border-[#777] px-[3px] py-[1px] text-[9px]">LOOP</code>}
    </span>
    <small className="mt-[9px] block truncate text-[#666]"><AssigneeRef value={task.assignee} data={data} select={select} /></small>
    {task.priority && <span className="absolute right-[9px] bottom-[9px] text-[10px]">{task.priority}</span>}
  </div>;
}
