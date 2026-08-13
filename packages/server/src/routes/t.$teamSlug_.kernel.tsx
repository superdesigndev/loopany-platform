import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { KernelShell } from "../components/kernel/KernelShell";
import type { Select } from "../components/kernel/model";
import { formatOpen, parseOpen, viewFromPathname } from "../components/kernel/routing";

/**
 * The Kernel workspace layout: the chrome plus the detail pane, with the matched
 * view rendered into it. Everything the URL carries is resolved here -
 * `?open=<kind>:<id>` (+ `?row=` for a Timeline event) is the inspector, the
 * path segment is the view - so a deep link opens exactly what a teammate saw.
 *
 * No loader on purpose: the workspace is a 5s poll owned by `KernelShell`, and a
 * loader would refetch on every view change and race the poll.
 */
export const Route = createFileRoute("/t/$teamSlug_/kernel")({
  validateSearch: (search: Record<string, unknown>): { open?: string; row?: string } => ({
    open: typeof search.open === "string" && search.open ? search.open : undefined,
    row: typeof search.row === "string" && search.row ? search.row : undefined,
  }),
  component: KernelLayout,
});

function KernelLayout() {
  const { teamSlug } = Route.useParams();
  const { open, row } = Route.useSearch();
  const navigate = useNavigate();
  const view = viewFromPathname(useLocation().pathname);
  // An unparseable `open` is ignored rather than an error: the pane simply has
  // nothing to show, which is what a stale or hand-edited link deserves.
  const selection = parseOpen(open, row);

  const select: Select = (kind, id, eventKey) => void navigate({
    to: ".",
    search: (prev: Record<string, unknown>) => ({ ...prev, ...formatOpen({ kind, id, eventKey }) }),
    // Opening the inspector is a back-button step; swapping to another object
    // while it is already open is not (browsing a list would flood history).
    replace: selection != null,
  });
  const closeDetail = () => void navigate({ to: ".", search: () => ({}) });

  return <KernelShell teamSlug={teamSlug} view={view} selection={selection} select={select} closeDetail={closeDetail}>
    <Outlet />
  </KernelShell>;
}
