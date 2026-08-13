// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: { children?: ReactNode; to?: string; params?: Record<string, string>; className?: string }) => {
    let href = to ?? "";
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    return createElement("a", { href, className }, children as never);
  },
}));
vi.mock("../../server/notifyFns", () => ({
  createChannel: vi.fn(async () => ({ ok: true, id: "channel-new" })),
  deleteChannel: vi.fn(async () => ({ ok: true })),
  listChannels: vi.fn(async () => [{
    id: "channel-1",
    name: "My Feishu",
    type: "feishu",
    hint: "hook ending 1234",
    active: true,
  }]),
  listSlackChannels: vi.fn(async () => ({ ok: true, channels: [] })),
  testChannel: vi.fn(async () => ({ ok: true })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data = {
  team: { id: "team-1", name: "Acme", slug: "acme" },
  me: { email: "tim@example.com" },
  members: [],
  machines: [],
  agentAddresses: [{ address: "stone-mbp/codex", availability: "available", lastSucceededAt: null }],
  tasks: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });

async function render(section: "team" | "machines" | "notifications") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ machines: [], teams: [], personalTeamId: "p" }), { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(SettingsView, { data, teamId: "team-1", teamSlug: "acme", section, agents: ["stone-mbp/codex"], select: vi.fn() }));
  });
}

describe("Kernel Web settings", () => {
  it("shows the Team directory and links each section to its own URL", async () => {
    await render("team");
    expect(host!.textContent).toContain("Manage this Team, your Machines, and personal preferences");
    const nav = host!.querySelector('nav[aria-label="Settings sections"]')!;
    expect(nav.textContent).toContain("TeamMachinesNotifications");
    // Every section is a real place, so it survives a reload and can be linked to.
    expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/t/acme/kernel/settings/team",
      "/t/acme/kernel/settings/machines",
      "/t/acme/kernel/settings/notifications",
    ]);
    expect(host!.textContent).toContain("Set up this Team");
    expect(host!.textContent).toContain("codex on stone-mbp");
    expect(host!.textContent).toContain("AVAILABLE");
  });

  it("renders personal notification settings at its own section", async () => {
    await render("notifications");
    expect(host!.textContent).toContain("My Feishu");
    expect(host!.textContent).toContain("Active");
    expect(host!.textContent).not.toContain("Set up this Team");
  });
});
