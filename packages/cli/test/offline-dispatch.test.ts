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

function deps(presence: Record<string, string>, calls?: unknown[]): CliDeps {
  const transport: SyncTransport = (_url, _token, body) => {
    calls?.push(body);
    if ((body as { read?: boolean }).read) {
      return { status: 200, response: { ok: true, snapshot, events: {}, machinePresence: presence } };
    }
    return {
      status: 200,
      response: {
        ok: true,
        result: { id: "audit" },
        notices: [],
        operationalContext: {
          changed: ["manual run"],
          taskId: "audit",
          run: { createdId: "run-owned", retainedId: null, supersededId: null, consequence: "created" },
          machine: { alias: "mbp", presence: presence.mbp ?? "unregistered" },
          nextTriggerAt: null,
          action: presence.mbp === "online" ? "no action required; the run is queued for delivery" : `no action required if the daemon will reconnect; the pending run is retained for the ${presence.mbp} machine`,
          nextCommand: null,
        },
      },
    };
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
    expect(out.stdout).toContain("full history: lk show audit --log");
  });

  it("show exposes the machine's actual presence", () => {
    const out = run(["show", "audit"], deps({ mbp: "online" }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("machine mbp: online");
    expect(out.stdout).not.toContain("machine mbp: unregistered");
  });

  it("returns an offline machine's dispatch context in exactly one write request", () => {
    const calls: unknown[] = [];
    const out = run(["run", "audit", "--json"], deps({ mbp: "offline" }, calls));
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).operationalContext).toMatchObject({
      run: { createdId: "run-owned", consequence: "created" },
      machine: { alias: "mbp", presence: "offline" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: { op: "run", id: "audit" } });
  });

  it("keeps online dispatch concise", () => {
    const out = run(["run", "audit", "--json"], deps({ mbp: "online" }));
    expect(JSON.parse(out.stdout).notices).toEqual([]);
  });
});
