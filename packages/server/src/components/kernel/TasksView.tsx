import { useState } from "react";
import { isLoop, isSelected, type Obj, type Select, type Selection, type TaskLayout } from "./model";
import { Empty, Row, Section } from "./primitives";
import { button, cx, selectableCard } from "./styles";
import { BOARD_STATUSES, hiddenTaskCount, visibleTaskTree } from "./taskLayouts";
import { AssigneeRef } from "./IdentityRefs";

export function TasksView({ data, selection, select }: { data: Obj; selection: Selection | null; select: Select }) {
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
  const hidden = hiddenTaskCount(data.tasks);
  const controls = <TaskControls
    layout={layout}
    onLayout={chooseLayout}
    hidden={hidden}
    showHidden={showHidden}
    onToggleHidden={() => setShowHidden((value) => !value)}
  />;

  if (layout === "board") {
    const statuses = showHidden ? ["idea", ...BOARD_STATUSES, "archived"] : BOARD_STATUSES;
    return <Section title="Task Board" sub="Work grouped by current state. Loops are marked at the card edge." action={controls} flush>
      <div className="grid grid-cols-[repeat(4,minmax(190px,1fr))] overflow-x-auto border border-[#aaa] max-[900px]:grid-cols-[repeat(4,190px)]">
        {statuses.map((status) => <BoardColumn key={status} data={data} status={status} selection={selection} select={select} />)}
      </div>
    </Section>;
  }
  return <Section title="Task Tree" sub="Parent defines scope. Hidden parents do not hide active children." action={controls}>
    <TaskTree data={data} nodes={visibleTaskTree(data.tree, showHidden)} selection={selection} select={select} />
  </Section>;
}

function TaskControls({ layout, onLayout, hidden, showHidden, onToggleHidden }: { layout: TaskLayout; onLayout: (next: TaskLayout) => void; hidden: number; showHidden: boolean; onToggleHidden: () => void }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 max-[900px]:justify-start" aria-label="Task layout">
    <div className="flex [&>button+button]:border-l-0">
      {(["tree", "board"] as TaskLayout[]).map((item) => <button
        key={item}
        className={button(layout === item ? "active" : "default")}
        aria-pressed={layout === item}
        onClick={() => onLayout(item)}
      >{item[0]!.toUpperCase() + item.slice(1)}</button>)}
    </div>
    {hidden > 0 && <button className={cx(button(), "text-[#555]")} onClick={onToggleHidden}>
      {showHidden ? "Hide" : "Show"} done + idea + archived ({hidden})
    </button>}
  </div>;
}

function TaskTree({ data, nodes, selection, select, depth = 0 }: { data: Obj; nodes: Obj[]; selection: Selection | null; select: Select; depth?: number }): React.ReactNode {
  return nodes.map((node) => <div key={node.task.id}>
    <Row
      title={node.task.title}
      meta={<>{node.task.status} · <AssigneeRef value={node.task.assignee} data={data} select={select} /></>}
      badge={isLoop(data, node.task.id) ? "LOOP" : undefined}
      indent={depth}
      selected={isSelected(selection, "task", node.task.id)}
      onClick={() => select("task", node.task.id)}
    />
    <TaskTree data={data} nodes={node.children} selection={selection} select={select} depth={depth + 1} />
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
