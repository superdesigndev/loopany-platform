import type { Selection, SelectionKind, SettingsSection, View } from "./model";

/**
 * The URL <-> workspace-state mapping, kept PURE so the tricky parts (an id
 * carrying a colon, an unknown kind, a hand-typed settings section) are unit
 * testable without a router or a DOM.
 *
 * The split is deliberate:
 *  - PATH carries the place - the view, and the settings section. Those are
 *    bookmarkable destinations with their own back-button step.
 *  - SEARCH carries the inspector - `?open=<kind>:<id>` (+ `?row=` for the
 *    Timeline, whose rows are events rather than objects). The detail pane is
 *    orthogonal to every view, so a nested route per view would mean repeating
 *    task/doc/run/member four times.
 *  - Personal preference (the Task tree/board toggle) stays in localStorage: it
 *    should not ride along in a link shared with a teammate.
 */

export const KERNEL_VIEWS: View[] = ["inbox", "tasks", "documents", "timeline"];
export const SETTINGS_SECTIONS: SettingsSection[] = ["team", "machines", "notifications"];
const SELECTION_KINDS: SelectionKind[] = ["task", "doc", "run", "member"];

export const DEFAULT_VIEW: View = "inbox";
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "team";

/** The `?open=` value: `<kind>:<id>`. Split on the FIRST colon only - ids are
 *  opaque and may contain one. */
export function parseOpen(open: unknown, row?: unknown): Selection | null {
  if (typeof open !== "string") return null;
  const cut = open.indexOf(":");
  if (cut < 1) return null;
  const kind = open.slice(0, cut) as SelectionKind;
  const id = open.slice(cut + 1);
  if (!id || !SELECTION_KINDS.includes(kind)) return null;
  return typeof row === "string" && row ? { kind, id, eventKey: row } : { kind, id };
}

export function formatOpen(selection: Selection): { open: string; row?: string } {
  return { open: `${selection.kind}:${selection.id}`, row: selection.eventKey };
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as string[]).includes(value);
}

/**
 * Which view the shell should mark active. Read from the PATH rather than
 * threaded down from each child route, so the layout can render its rail before
 * the child mounts. Anything under `.../settings` is the settings view.
 */
export function viewFromPathname(pathname: string): View {
  const segments = pathname.split("/").filter(Boolean);
  const kernel = segments.lastIndexOf("kernel");
  const rest = kernel < 0 ? [] : segments.slice(kernel + 1);
  if (rest[0] === "settings") return "settings";
  return KERNEL_VIEWS.find((view) => view === rest[0]) ?? DEFAULT_VIEW;
}
