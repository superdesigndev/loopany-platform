import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { authClient } from "../../lib/auth-client";
import { KernelProvider } from "./context";
import { DetailPanel } from "./DetailPanel";
import { KernelLogin } from "./KernelLogin";
import { assigneeOptions, knownAgents, type Obj, type Select, type Selection, type View } from "./model";
import { Empty } from "./primitives";
import { DEFAULT_SETTINGS_SECTION, KERNEL_VIEWS } from "./routing";
import { button, cx, ERROR, MUTED, railButton, SURFACE } from "./styles";
import { useDetail, useHotkeys, useWorkspace } from "./useWorkspace";
import { LocalTime } from "./DisplayPrimitives";

/** Nav targets as literals - the router types `to` against the route tree, so a
 *  template string would not narrow. */
const VIEW_TO = {
  inbox: "/t/$teamSlug/kernel/inbox",
  tasks: "/t/$teamSlug/kernel/tasks",
  documents: "/t/$teamSlug/kernel/documents",
  timeline: "/t/$teamSlug/kernel/timeline",
} as const;
const SETTINGS_TO = "/t/$teamSlug/kernel/settings/$section";

/** Below 900px the detail pane floats over the main column instead of sharing
 *  the grid - the nav rail (120px) stays visible beside it. */
const DETAIL_OVERLAY = "max-[900px]:fixed max-[900px]:top-11 max-[900px]:right-0 max-[900px]:bottom-7 max-[900px]:left-[120px] max-[900px]:border-l max-[900px]:border-[#bbb] max-[900px]:bg-[#fafafa]";

/**
 * The Kernel workspace chrome: header, view rail, main pane, detail pane.
 *
 * It owns the workspace poll and the detail fetch (both survive a view change,
 * since the layout route stays mounted) and publishes them on the Kernel
 * context; `children` is the matched view route. Navigation itself is NOT owned
 * here - the rail renders real links, and selection changes come in as
 * callbacks from the route, so this component stays renderable without a router.
 */
export function KernelShell({ teamSlug, view, selection, select, closeDetail, children }: {
  teamSlug: string;
  view: View;
  selection: Selection | null;
  select: Select;
  closeDetail: () => void;
  children?: React.ReactNode;
}) {
  const { data, error, refreshed, unauthorized, reload } = useWorkspace(teamSlug);
  const detail = useDetail(selection, teamSlug, data?.generatedAt);
  const agents = useMemo(() => knownAgents(data), [data]);
  const assignees = useMemo(() => assigneeOptions(data), [data]);
  const refresh = useCallback(() => { void reload(); }, [reload]);
  useHotkeys(refresh, closeDetail);

  if (unauthorized) return <KernelLogin />;

  return <div className={SURFACE}>
    <header className="flex h-11 items-center gap-5 border-b border-[#bbb] pr-[104px] pl-3">
      <strong>LOOPANY KERNEL</strong>
      <span>{data?.team?.name ?? teamSlug}</span>
      <span className={MUTED}>{data?.me?.email ?? ""}</span>
      <span className="flex-1" />
      <span>{data?.activeRuns?.length ?? 0} running</span>
      <button className={button()} onClick={refresh}>R Refresh</button>
      {data?.me?.email && <button className={button()} onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button>}
    </header>

    <div className={cx(
      "grid h-[calc(100vh-72px)] max-[900px]:grid-cols-[120px_1fr]",
      view === "settings" ? "grid-cols-[160px_minmax(0,1fr)]" : "grid-cols-[160px_minmax(360px,1fr)_minmax(320px,42%)]",
    )}>
      <nav className="flex flex-col justify-between overflow-auto border-r border-[#bbb] p-2.5">
        {/* search={{}} drops `open`: moving to another view closes the inspector. */}
        <div>{KERNEL_VIEWS.map((item) => <Link
          key={item}
          to={VIEW_TO[item as keyof typeof VIEW_TO]}
          params={{ teamSlug }}
          search={{}}
          className={railButton(view === item)}
        >
          {item[0]!.toUpperCase() + item.slice(1)}{item === "inbox" && data ? `  ${data.inbox.length}` : ""}
        </Link>)}</div>
        <div className="flex flex-col gap-1.5">
          <div className="p-2 leading-[1.8] text-[#666]">
            Tasks {data?.tasks?.length ?? 0}<br />
            Loops {data?.triggers?.filter((trigger: Obj) => trigger.kind === "cron").length ?? 0}<br />
            Docs {data?.documents?.length ?? 0}
          </div>
          <Link
            to={SETTINGS_TO}
            params={{ teamSlug, section: DEFAULT_SETTINGS_SECTION }}
            search={{}}
            className={railButton(view === "settings")}
          >Settings</Link>
        </div>
      </nav>

      <main className={cx("overflow-auto p-[18px]", view !== "settings" && "border-r border-[#bbb]")}>
        <KernelProvider value={{ teamSlug, data, error, reload, selection, select, agents, assignees }}>
          {data ? children : <Empty text={error || "Loading workspace..."} />}
        </KernelProvider>
      </main>

      {view !== "settings" && <aside className={cx("overflow-auto p-[18px]", DETAIL_OVERLAY, !selection && "max-[900px]:hidden")}>
        {selection
          ? <DetailPanel selection={selection} detail={detail} data={data ?? {}} select={select} teamSlug={teamSlug} reload={reload} assignees={assignees} />
          : <Empty text="Select an item to inspect" />}
      </aside>}
    </div>

    <footer className="flex h-7 items-center justify-between border-t border-[#bbb] px-3">
      <span>R refresh · Esc close detail</span>
      <span className={error ? ERROR : undefined}>{error || <>updated <LocalTime value={refreshed?.toISOString()} /></>}</span>
    </footer>
  </div>;
}
