import { describe, expect, it } from "vitest";
import { runKernelCli } from "./kernel-cli.js";
import { classify } from "./route.js";

function response(body: unknown, status = 200, type = "application/json") {
  return new Response(type === "application/json" ? JSON.stringify(body) : String(body), { status, headers: { "Content-Type": type } });
}

describe("rewrite kernel CLI", () => {
  it("routes object verbs through device+run-id plumbing even in a legacy-token environment", () => {
    expect(classify(["task", "list"], { LOOPANY_RUN_TOKEN: "rk_old", LOOPANY_RUN_ID: "run-new" })).toEqual({ kind: "kernel", argv: ["task", "list"] });
  });

  it("attaches LOOPANY_RUN_ID invisibly and renders the main task-list golden shape", async () => {
    let request: Request | undefined; let stdout = "";
    const code = await runKernelCli(["task", "list", "--due", "--watcher", "loop-own"], {
      server: "https://example.test", token: "dk_test", env: { LOOPANY_RUN_ID: "run-live" }, out: (s) => { stdout += s; },
      fetchImpl: async (input, init) => { request = new Request(input, init); return response({ tasks: [{ id: "task-a", title: "Observe", status: "open", followUpAt: "2026-08-04T00:00:00Z", watcher: "loop-own", pendingQuestion: null }] }); },
    });
    expect(code).toBe(0); expect(request!.headers.get("x-loopany-run")).toBe("run-live");
    expect(request!.url).toContain("due=true"); expect(request!.url).toContain("watcher=loop-own");
    expect(stdout).toBe("count: 1\ntasks[1]{id,title,status,follow_up,watcher,question}:\n  task-a,Observe,open,\"2026-08-04T00:00:00Z\",loop-own,—\nhelp[1]:\n  Run `loopany task show <id>` before changing it\n");
  });

  it("reads --file - from stdin and refuses flag/file ambiguity locally", async () => {
    let called = false; let stdout = "";
    const code = await runKernelCli(["task", "create", "--file", "-", "--watcher", "loop-own"], {
      server: "https://example.test", token: "dk_test", env: { LOOPANY_RUN_ID: "run-live" }, readStdin: () => "---\nwatcher: loop-other\n---\nbody\n", out: (s) => { stdout += s; }, fetchImpl: async () => { called = true; return response({}); },
    });
    expect(code).toBe(2); expect(called).toBe(false); expect(stdout).toContain("code: FLAG_FILE_CONFLICT");
  });

  it("maps refusal classes to 0/1/2/3 without prose parsing", async () => {
    for (const [status, exit] of [[401, 1], [403, 2], [404, 3], [409, 2], [429, 1]] as const) {
      let stdout = ""; const code = await runKernelCli(["task", "show", "task-nope"], { server: "https://example.test", token: "dk", out: (s) => { stdout += s; }, fetchImpl: async () => response({ code: status === 404 ? "NOT_FOUND" : "X", message: "no" , issues: [], hint: "next" }, status) });
      expect(code).toBe(exit); expect(stdout).toContain("help[1]:");
    }
  });
});
