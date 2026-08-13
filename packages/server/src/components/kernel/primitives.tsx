import { cx, MUTED, selectableRow } from "./styles";

/** One main-pane surface: a titled head (with optional right-aligned controls)
 *  above a list. `flush` drops the list's top rule for panels that draw their
 *  own frame (board, settings). */
export function Section({ title, sub, children, action, flush = false }: { title: string; sub: string; children: React.ReactNode; action?: React.ReactNode; flush?: boolean }) {
  return <section>
    <div className="flex items-start justify-between gap-[18px] max-[900px]:block">
      <div><h1>{title}</h1><p className={MUTED}>{sub}</p></div>
      {action}
    </div>
    <div className={cx("mt-[18px]", !flush && "border-t border-[#bbb]")}>{children}</div>
  </section>;
}

/** One selectable line in a list. `indent` draws the Task tree's nesting;
 *  `selected` marks the object currently open in the detail pane. */
export function Row({ title, meta, badge, indent = 0, selected = false, onClick }: { title: string; meta: React.ReactNode; badge?: string; indent?: number; selected?: boolean; onClick: () => void }) {
  return <div
    role="button"
    tabIndex={0}
    className={cx("flex w-full cursor-pointer items-center gap-2 border-b border-[#ddd] py-[11px] pr-3 text-left", selectableRow(selected))}
    style={{ paddingLeft: 12 + indent * 22 }}
    aria-current={selected || undefined}
    onClick={onClick}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
  >
    {indent > 0 && <span className="text-[#999]">└</span>}
    <span className="flex min-w-0 flex-col gap-1">
      <strong className="truncate">{title}</strong>
      <small className={MUTED}>{meta}</small>
    </span>
    {badge && <code className="ml-auto border border-[#aaa] px-1 py-[2px] text-[10px]">{badge}</code>}
  </div>;
}

export function Empty({ text }: { text: string }) {
  return <div className="p-7 text-center text-[#777]">{text}</div>;
}

/** Label/value grid used by every detail view. `Field` renders a dt/dd pair
 *  straight into the parent grid, so the two columns stay aligned. */
export function Fields({ children }: { children: React.ReactNode }) {
  return <dl className="my-[18px] grid grid-cols-[90px_1fr] gap-[7px]">{children}</dl>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <>
    <dt className={MUTED}>{label}</dt>
    <dd className="wrap-anywhere">{children}</dd>
  </>;
}
