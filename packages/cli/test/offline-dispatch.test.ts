import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "../src/index.js";
import type { SyncTransport } from "../src/remote.js";

const snapshot = {
  objects: {
    audit: {
      archetype: "task" as const,
      id: "audit",
      title: "Audit",
      status: "in-progress" as const,
      assignee: "mbp/claude",
      priority: null,
      type: null,
      parent: null,
      tracks: null,
      refs: [],
      followUpAt: null,
      owner: null,
      workdir: "/tmp",
      goal: null,
      body: "",
      version: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
  },
  triggers: [],
  runs: [],
};

function deps(presence: Record<string, string>): CliDeps {
  const transport: SyncTransport = (_url, _token, body) => {
    if ((body as { read?: boolean }).read) {
      return { status: 200, response: { ok: true, snapshot, events: {}, machinePresence: presence } };
    }
    return { status: 200, response: { ok: true, result: { id: "audit" }, notices: [] } };
  };
  return {
    cwd: "/tmp",
    now: "2026-08-12T00:00:00.000Z",
    env: { LOOPANY_KERNEL_BACKEND: "https://kernel.test", LOOPANY_KERNEL_TOKEN: "dk_test" },
    transport,
  };
}

describe("remote dispatch feedback", () => {
  it("show exposes an unregistered machine and a full-history escape hatch", () => {
    const out = run(["show", "audit"], deps({}));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("machine mbp: unregistered");
    expect(out.stdout).toContain("full history: loopany-kernel show audit --log");
  });

  it("says an offline machine's manual run is queued", () => {
    const out = run(["run", "audit", "--json"], deps({ mbp: "offline" }));
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).notices).toContain(
      'run queued: machine "mbp" is offline; it will claim when its daemon reconnects',
    );
  });

  it("keeps online dispatch concise", () => {
    const out = run(["run", "audit", "--json"], deps({ mbp: "online" }));
    expect(JSON.parse(out.stdout).notices).toEqual([]);
  });
});
