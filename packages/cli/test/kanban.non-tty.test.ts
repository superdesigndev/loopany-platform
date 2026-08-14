import { describe, expect, it, vi } from "vitest";
import { launchKanban } from "../src/kanban/launch.js";

describe("kanban terminal boundary", () => {
  it("refuses a non-TTY before workspace discovery or loading Ink", async () => {
    const write = vi.fn();
    const exitCode = await launchKanban({
      cwd: "/definitely/not/a/workspace",
      env: {},
      stdin: { isTTY: false },
      stdout: { isTTY: false, write },
      stderr: { isTTY: false, write },
    });
    expect(exitCode).toBe(1);
    expect(write).toHaveBeenCalledWith("lk kanban requires an interactive TTY\n");
  });
});
