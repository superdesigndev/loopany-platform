import { isLoop, isSelected, type Obj, type Select, type Selection } from "./model";
import { Empty, Row, Section } from "./primitives";

export function InboxView({ data, selection, select }: { data: Obj; selection: Selection | null; select: Select }) {
  return <Section title={`Inbox · ${data.me.email}`} sub="Tasks waiting for your decision or action">
    {data.inbox.length
      ? data.inbox.map((entry: Obj) => <Row
        key={entry.task.id}
        title={entry.task.title}
        meta={`${entry.reason} · ${entry.task.status}`}
        badge={isLoop(data, entry.task.id) ? "LOOP" : undefined}
        selected={isSelected(selection, "task", entry.task.id)}
        onClick={() => select("task", entry.task.id)}
      />)
      : <Empty text="Inbox is clear" />}
  </Section>;
}
