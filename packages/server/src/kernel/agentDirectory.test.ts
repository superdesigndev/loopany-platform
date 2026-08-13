import { describe, expect, test } from "vitest";
import type { RunRecord } from "@loopany/kernel";
import { agentDirectory } from "./agentDirectory.js";

const machine = (agentProfiles: string[] | null, online = true) => ({
  id: "m-1", name: "Mac", agentProfiles, online,
}) as any;
const run = (assignee: string, state: string, createdAt: string) => ({ assignee, state, createdAt }) as RunRecord;

describe("agent directory", () => {
  test("current daemon capabilities are authoritative", () => {
    expect(agentDirectory(
      [machine(["claude"], true)],
      [{ machineId: "m-1", alias: "mbp" }],
      [run("mbp/codex", "done", "2026-08-12T10:00:00Z")],
    )).toEqual([{ address: "mbp/claude", machineId: "m-1", machine: "mbp", profile: "claude", availability: "available", lastSucceededAt: null }]);
  });

  test("successful runs fill the gap only for daemons that never reported", () => {
    expect(agentDirectory(
      [machine(null, false)],
      [{ machineId: "m-1", alias: "mbp" }],
      [run("mbp/claude", "done", "2026-08-12T10:00:00Z"), run("mbp/codex", "failed", "2026-08-12T11:00:00Z")],
    )).toEqual([{ address: "mbp/claude", machineId: "m-1", machine: "mbp", profile: "claude", availability: "last-known", lastSucceededAt: "2026-08-12T10:00:00Z" }]);
  });
});
