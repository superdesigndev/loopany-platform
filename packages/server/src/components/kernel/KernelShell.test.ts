// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKernel, useKernelData } from "./context";
import { DocumentsView } from "./DocumentsView";
import { InboxView } from "./InboxView";
import { KernelShell } from "./KernelShell";
import type { Selection, View } from "./model";
import { TasksView } from "./TasksView";
import { TimelineView } from "./TimelineView";

vi.mock("../../lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
// The rail renders real links; the router itself is exercised by routing.test.ts.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: { children?: ReactNode; to?: string; params?: Record<string, string>; className?: string }) => {
    let href = to ?? "";
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    return createElement("a", { href, className }, children as never);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = { id: "task-1", title: "Ship it", status: "todo", assignee: "stone-mbp/codex", version: 3, body: "spec", workdir: "/tmp", executionMachine: "stone-mbp", priority: "P1", owner: "person:1", goal: null, workflow: null };
const run = { id: "run-1", state: "running", taskId: "task-1", cause: "assignment", assignee: "stone-mbp/codex", createdAt: "2026-08-13T00:00:00.000Z", workflow: null, agentSessionId: "sess-1", note: null };
const workflowRun = { id: "run-workflow", state: "done", taskId: "task-1", cause: "cron", assignee: "stone-mbp/claude", createdAt: "2026-08-13T00:30:00.000Z", workflow: { format: "loopany-js-v1", outcome: "direct", message: "All providers are healthy" }, agentSessionId: null, note: "All providers are healthy" };
const doc = { id: "doc-1", key: "notes", title: "Notes", version: 2, updatedAt: "2026-08-13T00:00:00.000Z", body: "hello" };

const workspace = {
  generatedAt: "2026-08-13T00:00:00.000Z",
  team: { id: "team-1", name: "Acme", slug: "acme" },
  me: { email: "tim@example.com" },
  members: [{ id: "1", email: "tim@example.com", name: "Tim", role: "owner" }],
  machines: [{ id: "m1", name: "stone-mbp", alias: null, platform: "darwin", online: true, mine: true, enrolledBy: "1", agentProfiles: ["codex"] }],
  agentAddresses: [
    { address: "stone-mbp/codex", availability: "available", lastSucceededAt: null },
    { address: "other-mbp/claude", availability: "available", lastSucceededAt: null },
  ],
  inbox: [{ task, reason: "assigned" }],
  tasks: [task, { ...task, id: "task-2", status: "done", title: "Old" }],
  tree: [{ task, children: [{ task: { ...task, id: "task-3", title: "Child", assignee: "person:1" }, children: [] }] }],
  triggers: [{ taskId: "task-1", kind: "cron" }],
  documents: [doc],
  activeRuns: [run],
  recentRuns: [run],
  recentTimeline: [
    { eventIds: ["e1"], summary: "Run finished", at: "2026-08-13T00:00:00.000Z", actor: "agent", agent: "codex", agentSessionId: "sess-1", kind: "run", runId: "run-1", objectId: "task-1" },
    // Two events on the SAME task - only the clicked row may highlight.
    { eventIds: ["e2"], summary: "idea to todo", at: "2026-08-13T00:00:00.000Z", actor: "human", kind: "status", runId: null, objectId: "task-1" },
    { eventIds: ["e3"], summary: "todo to idea", at: "2026-08-13T00:00:00.000Z", actor: "human", kind: "status", runId: null, objectId: "task-1" },
  ],
};

const detail = {
  task, run, doc,
  events: [
    { id: "evt-start", kind: "run-started", at: "2026-08-13T00:00:00.000Z", note: "run started" },
    { id: "evt-result", kind: "note", at: "2026-08-13T00:01:00.000Z", note: "Run complete: no balance alerts" },
  ],
  linkedTasks: [task], children: [{ id: "task-3", title: "Child" }],
  artifacts: [{ artifact: { id: "doc-1", archetype: "doc", title: "Notes", key: "notes" }, actions: ["update"] }],
  recent: [{ eventIds: ["e1"], at: "2026-08-13T00:00:00.000Z", summary: "Updated", actor: "human:anonymous", kind: "status", runId: null, objectId: "task-1" }],
  runs: [workflowRun, run], activeRun: run,
};

// The four view routes, inlined exactly as `routes/t.$teamSlug_.kernel.*.tsx`
// composes them - so the context wiring is under test too.
const CHILDREN: Record<string, () => ReactNode> = {
  inbox: () => { const { selection, select } = useKernel(); return createElement(InboxView, { data: useKernelData(), selection, select }); },
  tasks: () => { const { selection, select } = useKernel(); return createElement(TasksView, { data: useKernelData(), selection, select }); },
  documents: () => { const { selection, select } = useKernel(); return createElement(DocumentsView, { data: useKernelData(), selection, select }); },
  timeline: () => { const { selection, select } = useKernel(); const data = useKernelData(); return createElement(TimelineView, { items: data.recentTimeline, data, selection, select }); },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const select = vi.fn();
const closeDetail = vi.fn();

afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); select.mockClear(); closeDetail.mockClear(); });

async function render(view: View = "inbox", selection: Selection | null = null) {
  window.localStorage.clear(); // the task layout is persisted per team
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/workspace") ? workspace : detail), { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(KernelShell, { teamSlug: "acme", view, selection, select, closeDetail }, createElement(CHILDREN[view] ?? (() => null))));
  });
}

const rows = () => [...host!.querySelector("main")!.querySelectorAll<HTMLElement>("button, [role=button]")];
const clickRow = async (text: string) => {
  const row = rows().find((element) => element.textContent?.includes(text));
  expect(row, text).toBeTruthy();
  await act(async () => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const link = (label: string) => [...host!.querySelectorAll("a")].find((a) => a.textContent?.trim().startsWith(label))!;

describe("Kernel shell", () => {
  it("points the rail at every view route and marks the matched one", async () => {
    await render("tasks");
    expect(link("Inbox").getAttribute("href")).toBe("/t/acme/kernel/inbox");
    expect(link("Documents").getAttribute("href")).toBe("/t/acme/kernel/documents");
    expect(link("Settings").getAttribute("href")).toBe("/t/acme/kernel/settings/team");

    // The active skin must REPLACE the resting one, never layer on top of it:
    // two utilities for one property resolve by stylesheet order, not by the
    // order written, so a layered "active" background silently loses.
    expect(link("Tasks").className).toContain("bg-[#171717]");
    expect(link("Tasks").className).not.toContain("bg-transparent");
    expect(link("Inbox").className).toContain("bg-transparent");
    expect(link("Inbox").className).not.toContain("bg-[#171717]");
  });

  it("renders each view through the Kernel context", async () => {
    await render("inbox");
    expect(host!.textContent).toContain("Ship it");

    await render("tasks");
    expect(host!.textContent).toContain("Task Tree");
    expect(host!.textContent).toContain("Child");
    expect(host!.textContent).toContain("Tim");
    expect(host!.textContent).not.toContain("person:1");

    await render("documents");
    expect(host!.textContent).toContain("Notes");

    await render("timeline");
    expect(host!.textContent).toContain("Run finished");
    expect(host!.textContent).toContain("Tim"); // a person renders as a member, never `person:<id>`
    expect(host!.textContent).not.toContain("person:1");
  });

  it("asks the route to open a row, and marks the open one", async () => {
    await render("tasks");
    await clickRow("Ship it");
    expect(select).toHaveBeenCalledWith("task", "task-1");

    // Selection comes back down from the URL, so re-render with it applied.
    await render("tasks", { kind: "task", id: "task-1" });
    const row = rows().find((element) => element.textContent?.includes("Ship it"))!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("shadow-[inset_3px_0_0_#171717]");
    const sibling = rows().find((element) => element.textContent?.includes("Child"))!;
    expect(sibling.getAttribute("aria-current")).toBe(null);
    expect(sibling.className).toContain("bg-transparent");
  });

  it("keys Timeline highlighting to the event, not the object it points at", async () => {
    await render("timeline");
    await clickRow("idea to todo");
    expect(select).toHaveBeenCalledWith("task", "task-1", "e2");

    // Both e2 and e3 point at task-1: only the one in the URL lights up.
    await render("timeline", { kind: "task", id: "task-1", eventKey: "e2" });
    const current = rows().filter((element) => element.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("idea to todo");
  });

  it("renders the detail pane for the selected object and closes it on Escape", async () => {
    await render("tasks", { kind: "run", id: "run-1" });
    const aside = host!.querySelector("aside")!;
    expect(aside.textContent).toContain("Artifacts touched");
    expect(aside.textContent).toContain("Run complete: no balance alerts");
    expect(aside.textContent).toContain("Runtime");
    expect(aside.textContent).toContain("Transcript");
    expect(aside.textContent).toContain("Task changes");
    expect(aside.textContent).toContain("Copy resume");
    expect(aside.textContent).not.toContain("cd --");

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(closeDetail).toHaveBeenCalled();
  });

  it("identifies a workflow-only Run without pretending Claude executed it", async () => {
    await render("tasks", { kind: "task", id: "task-1" });
    const aside = host!.querySelector("aside")!;
    expect(aside.textContent).toContain("Workflow · direct");
    expect(aside.textContent).toContain("All providers are healthy");
  });

  it("only offers Agents on the Task's derived execution Machine", async () => {
    await render("tasks", { kind: "task", id: "task-1" });
    const picker = host!.querySelector<HTMLSelectElement>('select[aria-label="Assignee"]')!;
    const values = [...picker.options].map((option) => option.value);
    expect(values).toContain("stone-mbp/codex");
    expect(values).not.toContain("other-mbp/claude");
    expect(values).toContain("person:1");
  });

  it("resizes and remembers the desktop detail pane", async () => {
    await render("tasks", { kind: "task", id: "task-1" });
    const separator = host!.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator).toBeTruthy();
    const before = Number(separator.getAttribute("aria-valuenow"));
    await act(async () => { separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before + 24);
    expect(window.localStorage.getItem("loopany-kernel:detail-width:acme")).toBe(String(before + 24));
  });

  it("gates the main pane until the workspace payload lands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(KernelShell, { teamSlug: "acme", view: "inbox", selection: null, select, closeDetail }, createElement(CHILDREN.inbox!)));
    });
    expect(host.querySelector("main")!.textContent).toContain("HTTP 500");
  });
});
