import { useCallback, useEffect, useState } from "react";
import type { LoadedDetail, Obj, Selection } from "./model";

const POLL_MS = 5000;

/**
 * The Team workspace payload, refreshed on a visible-tab poll.
 *
 * Auth is driven by the API, not a client session: a 401 means sign in. This
 * keeps open mode (gate off, no session at all) working without a login wall.
 */
export function useWorkspace(teamSlug: string) {
  const [data, setData] = useState<Obj | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState<Date | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/kernel/web/workspace?teamSlug=${encodeURIComponent(teamSlug)}`);
      if (res.status === 401) { setUnauthorized(true); return; }
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setUnauthorized(false);
      setData(await res.json()); setRefreshed(new Date()); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [teamSlug]);

  useEffect(() => {
    void reload();
    const whenVisible = () => { if (document.visibilityState === "visible") void reload(); };
    const id = window.setInterval(whenVisible, POLL_MS);
    document.addEventListener("visibilitychange", whenVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", whenVisible); };
  }, [reload]);

  return { data, error, refreshed, unauthorized, reload };
}

/**
 * The selected object's full detail. Returns a value only when it belongs to
 * the CURRENT selection, so switching rows never flashes the previous object.
 * Re-fetches whenever the workspace payload advances (`generatedAt`).
 */
export function useDetail(selected: Selection | null, teamSlug: string, generatedAt?: string): Obj | null {
  const [detail, setDetail] = useState<LoadedDetail | null>(null);

  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    const requested = selected;
    const plural = selected.kind === "task" ? "tasks" : selected.kind === "doc" ? "docs" : selected.kind === "run" ? "runs" : "members";
    const res = await fetch(`/api/kernel/web/${plural}/${encodeURIComponent(selected.id)}?teamSlug=${encodeURIComponent(teamSlug)}`);
    if (res.ok) setDetail({ ...requested, value: await res.json() });
  }, [selected, teamSlug]);

  useEffect(() => { void loadDetail(); }, [loadDetail, generatedAt]);

  if (!selected || detail?.kind !== selected.kind || detail.id !== selected.id) return null;
  return detail.value;
}

/** Incremental Run transcript reader. The large append stream stays out of the
 * 5s Team workspace payload; only an open running Run polls it every 2s. */
export function useRunTranscript(runId: string, teamSlug: string, active: boolean): Obj {
  const [entries, setEntries] = useState<Obj[]>([]);
  const [capture, setCapture] = useState<Obj>({ status: "unavailable", entries: 0, bytes: 0, truncated: false });
  const [nextSeq, setNextSeq] = useState(-1);

  useEffect(() => { setEntries([]); setNextSeq(-1); setCapture({ status: "unavailable", entries: 0, bytes: 0, truncated: false }); }, [runId]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/kernel/web/run-transcript/${encodeURIComponent(runId)}?teamSlug=${encodeURIComponent(teamSlug)}&after=${nextSeq}&limit=200`);
        if (!res.ok || stopped) return;
        const page = await res.json();
        if (stopped) return;
        setEntries((current) => {
          const seen = new Set(current.map((entry) => entry.seq));
          return [...current, ...(page.entries ?? []).filter((entry: Obj) => !seen.has(entry.seq))].sort((a, b) => a.seq - b.seq);
        });
        setNextSeq((value) => Math.max(value, Number(page.nextSeq ?? value)));
        setCapture(page.capture ?? capture);
      } catch { /* workspace-level connectivity UI already reports outages */ }
    };
    void load();
    if (!active) return () => { stopped = true; };
    const timer = window.setInterval(() => void load(), 2_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [runId, teamSlug, active, nextSeq]);
  return { entries, capture };
}

/** `r` refreshes, `Esc` closes the detail pane - unless the user is typing. */
export function useHotkeys(refresh: () => void, escape: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key.toLowerCase() === "r") refresh();
      if (e.key === "Escape") escape();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [refresh, escape]);
}
