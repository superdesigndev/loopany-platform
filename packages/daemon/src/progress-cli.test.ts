import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProgress } from "./progress-cli.js";

/**
 * `loopany progress` — the CLI reporting path the loop-creation skill invokes per
 * milestone. It must be strictly BEST-EFFORT: POST the shared /api/claim/progress
 * contract when it can, and quietly no-op (never throw, always exit 0) otherwise, so
 * the agent's real loop-creation work is never affected.
 */
type Call = { url: string; body: unknown };

function fakeFetch(behavior: "ok" | "throw" = "ok") {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (behavior === "throw") throw new Error("network down");
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const orig = process.env.LOOPANY_SERVER_URL;
beforeEach(() => {
  process.env.LOOPANY_SERVER_URL = "http://server.test";
})
afterEach(() => {
  if (orig === undefined) delete process.env.LOOPANY_SERVER_URL;
  else process.env.LOOPANY_SERVER_URL = orig;
})

describe("runProgress (best-effort milestone reporting)", () => {
  it("POSTs {claim, step} to the shared endpoint and exits 0", async () => {
    const { fn, calls } = fakeFetch();
    const code = await runProgress(["configuring", "--connect-key", "dk_abc"], { fetchImpl: fn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://server.test/api/claim/progress");
    expect(calls[0]!.body).toEqual({ claim: "dk_abc", step: "configuring" });
  });

  it("accepts --claim as an alias for --connect-key", async () => {
    const { fn, calls } = fakeFetch();
    await runProgress(["reading", "--claim", "dk_xyz"], { fetchImpl: fn });
    expect(calls[0]!.body).toEqual({ claim: "dk_xyz", step: "reading" });
  });

  it("resolves the step regardless of flag order", async () => {
    const { fn, calls } = fakeFetch();
    await runProgress(["--connect-key", "dk_abc", "creating"], { fetchImpl: fn });
    expect(calls[0]!.body).toEqual({ claim: "dk_abc", step: "creating" });
  });

  it("no-ops (no POST) when the connect-key is missing — never fails", async () => {
    const { fn, calls } = fakeFetch();
    const code = await runProgress(["inspecting"], { fetchImpl: fn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("no-ops when no step is given", async () => {
    const { fn, calls } = fakeFetch();
    const code = await runProgress(["--connect-key", "dk_abc"], { fetchImpl: fn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("no-ops (no POST) when no server URL can be resolved — never fails", async () => {
    const { fn, calls } = fakeFetch();
    const code = await runProgress(["reading", "--connect-key", "dk_abc"], { fetchImpl: fn, resolveServer: () => "" });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("swallows a network failure (never throws, exits 0)", async () => {
    const { fn } = fakeFetch("throw");
    const code = await runProgress(["authoring", "--connect-key", "dk_abc"], { fetchImpl: fn });
    expect(code).toBe(0);
  });
});
