import { isSelected, type Obj, type Select, type Selection } from "./model";
import { Row, Section } from "./primitives";
import { LocalTime } from "./DisplayPrimitives";

export function DocumentsView({ data, selection, select }: { data: Obj; selection: Selection | null; select: Select }) {
  return <Section title="Documents" sub="Team artifacts, newest updates first">
    {[...data.documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((doc: Obj) => <Row
      key={doc.id}
      title={doc.title ?? doc.key}
      meta={<>{doc.key} · v{doc.version} · <LocalTime value={doc.updatedAt} /></>}
      badge="DOC"
      selected={isSelected(selection, "doc", doc.id)}
      onClick={() => select("doc", doc.id)}
    />)}
  </Section>;
}
