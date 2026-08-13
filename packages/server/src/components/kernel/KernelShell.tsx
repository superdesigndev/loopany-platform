import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
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
const DETAIL_OVERLAY = "max-[900px]:fixed max-[900px]:top-11 max-[900px]:right-0 max-[900px]:bottom-[calc(48px+env(safe-area-inset-bottom))] max-[900px]:left-0 max-[900px]:z-20 max-[900px]:border-0 max-[900px]:bg-[#fafafa]";
const DETAIL_MIN = 320;
const MAIN_MIN = 360;
const SPLITTER = 7;

function storedDetailWidth(teamSlug: string): number {
  if (typeof window === "undefined") return 520;
  const saved = Number(window.localStorage.getItem(`loopany-kernel:detail-width:${teamSlug}`));
  return Number.isFinite(saved) && saved >= DETAIL_MIN ? saved : Math.max(DETAIL_MIN, Math.round(window.innerWidth * 0.42));
}

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
  const grid = useRef<HTMLDivElement>(null);
  const [detailWidth, setDetailWidth] = useState(() => storedDetailWidth(teamSlug));
  const { data, error, refreshed, unauthorized, reload } = useWorkspace(teamSlug);
  const detail = useDetail(selection, teamSlug, data?.generatedAt);
  const agents = useMemo(() => knownAgents(data), [data]);
  const assignees = useMemo(() => assigneeOptions(data), [data]);
  const refresh = useCallback(() => { void reload(); }, [reload]);
  useHotkeys(refresh, closeDetail);

  const resizeDetail = useCallback((next: number) => {
    const measured = grid.current?.getBoundingClientRect().width ?? 0;
    const available = (measured > 0 ? measured : window.innerWidth) - 160 - SPLITTER;
    const width = Math.round(Math.min(Math.max(next, DETAIL_MIN), Math.max(DETAIL_MIN, available - MAIN_MIN)));
    setDetailWidth(width);
    window.localStorage.setItem(`loopany-kernel:detail-width:${teamSlug}`, String(width));
  }, [teamSlug]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (next: PointerEvent) => resizeDetail((grid.current?.getBoundingClientRect().right ?? window.innerWidth) - next.clientX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [resizeDetail]);

  if (unauthorized) return <KernelLogin />;

  return <div className={SURFACE}>
    <header className="flex h-11 items-center gap-5 border-b border-[#bbb] pr-[104px] pl-3 max-[900px]:gap-3">
      <strong>LOOPANY KERNEL</strong>
      <span className="max-[600px]:hidden">{data?.team?.name ?? teamSlug}</span>
      <span className={cx(MUTED, "max-[900px]:hidden")}>{data?.me?.email ?? ""}</span>
      <span className="flex-1" />
      <span className="max-[900px]:hidden">{data?.activeRuns?.length ?? 0} running</span>
      <button className={cx(button(), "max-[900px]:hidden")} onClick={refresh}>R Refresh</button>
      {data?.me?.email && <button className={cx(button(), "max-[900px]:hidden")} onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button>}
      <Link
        to={SETTINGS_TO}
        params={{ teamSlug, section: DEFAULT_SETTINGS_SECTION }}
        search={{}}
        className={cx("hidden border px-2 py-[5px] max-[900px]:block", view === "settings" ? "border-[#171717] bg-[#171717] text-white" : "border-[#aaa]")}
      >Settings</Link>
    </header>

    <div ref={grid} style={{ "--kernel-detail-width": `${detailWidth}px` } as CSSProperties} className={cx(
      "grid h-[calc(100vh-72px)] max-[900px]:h-[calc(100vh-92px-env(safe-area-inset-bottom))] max-[900px]:grid-cols-[1fr]",
      view === "settings" ? "grid-cols-[160px_minmax(0,1fr)]" : "grid-cols-[160px_minmax(360px,1fr)_7px_var(--kernel-detail-width)]",
    )}>
      <nav className="flex flex-col justify-between overflow-auto border-r border-[#bbb] p-2.5 max-[900px]:hidden">
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

      <main className="overflow-auto p-3">
        <KernelProvider value={{ teamSlug, data, error, reload, selection, select, agents, assignees }}>
          {data ? children : <Empty text={error || "Loading workspace..."} />}
        </KernelProvider>
      </main>

      {view !== "settings" && <div
        role="separator"
        aria-label="Resize detail pane"
        aria-orientation="vertical"
        aria-valuenow={detailWidth}
        tabIndex={0}
        className="group/split relative cursor-col-resize border-x border-[#bbb] bg-[#f3f3f1] outline-none hover:bg-[#ddd] focus-visible:bg-[#ddd] max-[900px]:hidden"
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); resizeDetail(detailWidth + 24); }
          if (event.key === "ArrowRight") { event.preventDefault(); resizeDetail(detailWidth - 24); }
        }}
      ><span className="absolute top-1/2 left-1/2 h-8 w-px -translate-x-1/2 -translate-y-1/2 bg-[#888]" /></div>}

      {view !== "settings" && <aside className={cx("overflow-auto p-3", DETAIL_OVERLAY, !selection && "max-[900px]:hidden")}>
        {selection
          ? <DetailPanel selection={selection} detail={detail} data={data ?? {}} select={select} teamSlug={teamSlug} reload={reload} assignees={assignees} />
          : <Empty text="Select an item to inspect" />}
      </aside>}
    </div>

    <nav className="fixed right-0 bottom-0 left-0 z-30 hidden h-[calc(48px+env(safe-area-inset-bottom))] grid-cols-4 border-t border-[#999] bg-[#fafafa] pb-[env(safe-area-inset-bottom)] max-[900px]:grid" aria-label="Kernel views">
      {KERNEL_VIEWS.map((item) => <Link
        key={item}
        to={VIEW_TO[item as keyof typeof VIEW_TO]}
        params={{ teamSlug }}
        search={{}}
        className={cx(
          "flex min-w-0 items-center justify-center border-r border-[#ddd] px-1 text-[11px] uppercase last:border-r-0",
          view === item ? "bg-[#171717] text-white" : "bg-transparent text-[#555]",
        )}
      >{item === "documents" ? "Docs" : item}{item === "inbox" && data?.inbox?.length ? ` ${data.inbox.length}` : ""}</Link>)}
    </nav>

    <footer className="flex h-7 items-center justify-between border-t border-[#bbb] px-3 max-[900px]:hidden">
      <span>R refresh · Esc close detail</span>
      <span className={error ? ERROR : undefined}>{error || <>updated <LocalTime value={refreshed?.toISOString()} /></>}</span>
    </footer>
  </div>;
}
