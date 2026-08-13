export type AssigneeOption = {
  value: string;
  label: string;
  detail: string;
  kind: "person" | "agent";
  disabled?: boolean;
};

/** One Team-scoped assignment control. Values are canonical Kernel addresses;
 * labels are presentation only, so human and agent assignment cannot drift. */
export function AssigneePicker({
  id,
  className,
  value,
  options,
  disabled,
  onChange,
}: {
  id?: string;
  className?: string;
  value: string;
  options: readonly AssigneeOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const people = options.filter((option) => option.kind === "person");
  const agents = options.filter((option) => option.kind === "agent");
  return <select id={id} className={className} aria-label="Assignee" value={value} disabled={disabled || options.length === 0} onChange={(event) => onChange(event.target.value)}>
    <option value="">{options.length ? "Select an assignee" : "No assignees available"}</option>
    {people.length > 0 && <optgroup label="People">{people.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label} · {option.detail}</option>)}</optgroup>}
    {agents.length > 0 && <optgroup label="Agents">{agents.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label} · {option.detail}</option>)}</optgroup>}
  </select>;
}
