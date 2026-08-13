import { useEffect, useState } from "react";
import { AssigneePicker, type AssigneeOption } from "./AssigneePicker";
import type { Obj } from "./model";
import { button, BUTTON_DISABLED, cx, ERROR, FIELD } from "./styles";

const STATUSES = ["idea", "todo", "in-progress", "done", "archived"];
/** Label + one-line explanation of what the control actually does. */
const CONTROL_LABEL = "flex flex-col gap-[3px] max-[900px]:col-span-full";
const CONTROL_HINT = "text-[11px] leading-[1.4] text-[#666]";
const ROW = "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-[7px] p-[9px] max-[900px]:grid-cols-[1fr_auto]";

/** The two write surfaces on a Task: set its status, or hand it to a person or
 *  an Agent. Both post the same Kernel command envelope. */
export function TaskActions({ task, teamSlug, reload, assignees }: { task: Obj; teamSlug: string; reload: () => Promise<void>; assignees: AssigneeOption[] }) {
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

  return <div className="my-4 border border-[#aaa]">
    <div className={ROW}>
      <label className={CONTROL_LABEL}>
        <strong>Set status</strong>
        <span className={CONTROL_HINT}>Update this task without dispatching an agent.</span>
      </label>
      <select className={FIELD} value={status} disabled={busy} onChange={(event) => setStatus(event.target.value)}>
        {STATUSES.map((value) => <option key={value}>{value}</option>)}
      </select>
      <button
        className={cx(button(), BUTTON_DISABLED)}
        disabled={busy || status === task.status}
        onClick={() => void send({ op: "update", id: task.id, patch: { status }, note: `Human set ${status}`, ifVersion: task.version })}
      >Apply</button>
    </div>
    <div className="border-t border-[#bbb] p-[9px]">
      <label className="flex flex-col gap-[3px]" htmlFor={`handoff-${task.id}`}>
        <strong>Hand off</strong>
        <span className={CONTROL_HINT}>{assignee.startsWith("person:") ? "This sends the Task to the person's Inbox." : "Choosing an Agent sets the Task to todo and starts an assignment Run."}</span>
      </label>
      <textarea
        id={`handoff-${task.id}`}
        className={cx(FIELD, "mt-2 block min-h-16 w-full")}
        placeholder="What should they decide or do next?"
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[7px] pt-[7px]">
        <AssigneePicker className={FIELD} value={assignee} options={assignees} disabled={busy} onChange={setAssignee} />
        <button
          className={cx(button("primary"), BUTTON_DISABLED)}
          disabled={busy || !note.trim() || !assignee}
          onClick={() => void send({ op: "update", id: task.id, patch: { assignee, status: "todo" }, note: note.trim(), ifVersion: task.version })}
        >{busy ? "Sending..." : "Hand off"}</button>
      </div>
    </div>
    {error && <div className={cx(ERROR, "px-[9px] pb-[9px]")}>{error}</div>}
  </div>;
}
