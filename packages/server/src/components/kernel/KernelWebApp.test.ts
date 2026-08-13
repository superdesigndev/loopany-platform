// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelWebApp } from "./KernelWebApp";

vi.mock("../../lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("Kernel Web settings", () => {
  it("opens personal notification settings from the bottom navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      team: { id: "team-1", name: "Acme", slug: "acme" },
      me: { email: "tim@example.com" },
      members: [],
      machines: [],
      agentAddresses: [{ address: "stone-mbp/codex", availability: "available", lastSucceededAt: null }],
      inbox: [],
      tasks: [],
      tree: [],
      triggers: [],
      documents: [],
      activeRuns: [],
      recentRuns: [],
      recentTimeline: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(KernelWebApp, { teamSlug: "team-one" }));
    });

    const settings = [...host.querySelectorAll("button")].find((button) => button.textContent === "Settings");
    expect(settings).toBeTruthy();
    await act(async () => {
      settings!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("Manage this Team, your Machines, and personal preferences");
    const settingsNav = host.querySelector('nav[aria-label="Settings sections"]');
    expect(settingsNav?.textContent).toContain("TeamMachinesNotifications");
    expect(host.textContent).toContain("Set up this Team");
    expect(host.textContent).toContain("stone-mbp/codex");
    expect(host.textContent).toContain("AVAILABLE");

    const notifications = [...settingsNav!.querySelectorAll("button")].find((button) => button.textContent === "Notifications");
    await act(async () => {
      notifications!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("My Feishu");
    expect(host.textContent).toContain("Active");
    expect(host.textContent).not.toContain("Select an item to inspect");
  });
});
