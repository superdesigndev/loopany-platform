import { describe, expect, test } from "vitest";
import { authorizeKernelRequest } from "./authority";

describe("kernel server authority", () => {
  test("human sessions can manage work but cannot claim or finish runs", () => {
    expect(authorizeKernelRequest("human-session", { command: { op: "update" } })).toBeNull();
    expect(authorizeKernelRequest("human-session", { command: { op: "run" } })).toBeNull();
    expect(authorizeKernelRequest("human-session", { command: { op: "run-claim" } })?.status).toBe(403);
    expect(authorizeKernelRequest("human-session", { command: { op: "run-finish" } })?.status).toBe(403);
    expect(authorizeKernelRequest("human-session", { tick: true })?.status).toBe(403);
  });

  test("an agent run can finish only itself", () => {
    const run = { runId: "run-1", state: "active" as const };
    expect(authorizeKernelRequest("agent-run", { command: { op: "note" } }, run)).toBeNull();
    expect(authorizeKernelRequest("agent-run", { command: { op: "run-finish", runId: "run-1" } }, run)).toBeNull();
    expect(authorizeKernelRequest("agent-run", { command: { op: "run-finish", runId: "run-2" } }, run)?.status).toBe(403);
  });

  test("terminal run credentials are dead", () => {
    expect(authorizeKernelRequest("agent-run", { read: true }, { runId: "run-1", state: "terminal-grace" })?.status).toBe(409);
  });
});
