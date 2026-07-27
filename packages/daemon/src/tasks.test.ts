import { describe, expect, it } from "vitest";

import { runTaskCreate, runTaskGet, runTaskList, runTaskMv, runTaskRun, runTaskUpdate, type TaskDeps } from "./tasks.js";
import { readFrontmatter, scaffoldReadme } from "./taskfile.js";

/** In-memory fs seam. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    fsImpl: {
      existsSync: (p: unknown) => files.has(String(p)),
      readFileSync: (p: unknown) => {
        if (!files.has(String(p))) throw new Error(`ENOENT: ${String(p)}`);
        return files.get(String(p))!;
      },
      writeFileSync: (p: unknown, data: unknown) => void files.set(String(p), String(data)),
      mkdirSync: () => undefined,
    } as never,
  };
}

/** Routing fake fetch: handlers keyed by "<METHOD> <path>" prefix. */
function fakeFetch(handlers: Record<string, (url: string, body: unknown) => { status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fn = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });
    for (const [key, handler] of Object.entries(handlers)) {
      const [m, p] = key.split(" ", 2);
      if (method === m && new URL(u).pathname === p) {
        const r = handler(u, body);
        return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as typeof fetch;
  return { fn, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const BASE = { server: "http://s", token: "dk_test", tasksRoot: "/root/loopany", actor: "tester" };

const TASK = (over: Record<string, unknown> = {}) => ({
  loopId: "loop-1",
  slug: "cheap-geo-ppp",
  title: "Cheap geo PPP",
  type: "experiment",
  status: "todo",
  priority: "P2",
  owner: null,
  parent: null,
  follow_up_date: null,
  order: null,
  cron: null,
  enabled: true,
  taskFile: "/root/loopany/cheap-geo-ppp/README.md",
  ...over,
});

describe("create", () => {
  it("cloud-born create: registers with slug + inline doc, writes NO local files", async () => {
    const { fsImpl, files } = memFs();
    const { fn, calls } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
      "POST /api/machine/loop": () => ({ body: { ok: true, id: "loop-9", name: "Cheap geo PPP" } }),
    });
    const c = capture();
    const code = await runTaskCreate(["Cheap geo PPP", "--parent", "monetization", "--type", "experiment"], {
      ...BASE,
      ...c.deps,
      fsImpl,
      fetchFn: fn,
    } as TaskDeps);
    expect(code).toBe(0);
    // Cloud-born: NO local folder/README is written at create — the doc rides
    // the registration; the folder appears lazily when artifacts first land.
    expect(files.has("/root/loopany/cheap-geo-ppp/README.md")).toBe(false);
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.body).toMatchObject({ slug: "cheap-geo-ppp" });
    expect((post.body as { taskFile?: string }).taskFile).toBeUndefined();
    const doc = (post.body as { taskFileContent: string }).taskFileContent;
    expect(readFrontmatter(doc)).toMatchObject({ id: "cheap-geo-ppp", parent: "monetization", type: "experiment", status: "idea" });
  });

  it("warns on a fuzzy-duplicate title unless --force", async () => {
    const { fsImpl } = memFs();
    const { fn, calls } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [TASK({ title: "PPP pricing for cheap geos" })] } }),
      "POST /api/machine/loop": () => ({ body: { ok: true, id: "loop-9" } }),
    });
    const c = capture();
    const code = await runTaskCreate(["Cheap geo PPP pricing"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("similar task");
    expect(calls.some((x) => x.method === "POST")).toBe(false);

    const forced = await runTaskCreate(["Cheap geo PPP pricing", "--force"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn } as TaskDeps);
    expect(forced).toBe(0);
  });

  it("teaches valid enum values on a bad --type", async () => {
    const c = capture();
    const code = await runTaskCreate(["X", "--type", "epic"], { ...BASE, ...c.deps } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toMatch(/goal, strategy, experiment, task, idea/);
    expect(c.err.join("")).toMatch(/'epic'/);
  });

  it("a failed server registration writes nothing locally (cloud-born create is atomic)", async () => {
    const { fsImpl, files } = memFs();
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
      "POST /api/machine/loop": () => ({ status: 500, body: { error: "boom" } }),
    });
    const c = capture();
    const code = await runTaskCreate(["Solo task"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn } as TaskDeps);
    expect(code).toBe(1);
    expect(files.size).toBe(0);
    expect(c.err.join("")).toContain("boom");
  });

  it("--spec-file seeds the doc body (cwd-fenced)", async () => {
    const { fsImpl, files } = memFs({ "/root/spec.md": "Do the thing carefully.\n" });
    const posts: unknown[] = [];
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
      "POST /api/machine/loop": (_u, body) => {
        posts.push(body);
        return { body: { ok: true, id: "loop-9" } };
      },
    });
    const c = capture();
    const code = await runTaskCreate(["Spec task", "--spec-file", "/root/spec.md"], {
      ...BASE,
      ...c.deps,
      fsImpl,
      fetchFn: fn,
      cwd: () => "/root",
    } as TaskDeps);
    expect(code).toBe(0);
    expect((posts[0] as { taskFileContent: string }).taskFileContent).toContain("Do the thing carefully.");
    expect(files.size).toBe(1); // only the pre-seeded spec file — nothing written
  });

  it("exits 2 with guidance when not connected", async () => {
    const c = capture();
    const code = await runTaskCreate(["X"], { ...c.deps, server: "", token: undefined } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("isn't connected");
  });
});

describe("update", () => {
  const seededFile = scaffoldReadme({ slug: "cheap-geo-ppp", title: "Cheap geo PPP", type: "experiment", status: "todo", date: "2026-07-01" });

  function updateWorld(taskOver: Record<string, unknown> = {}) {
    const { fsImpl, files } = memFs({ "/root/loopany/cheap-geo-ppp/README.md": seededFile });
    const patches: unknown[] = [];
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, task: TASK(taskOver), children: [] } }),
      "PATCH /api/machine/loop": (_u, body) => {
        patches.push(body);
        return { body: { ok: true, id: "loop-1", applied: Object.keys((body as { patch: object }).patch) } };
      },
    });
    return { fsImpl, files, patches, fn };
  }

  it("writes work-state into the README (front matter + auto timeline line)", async () => {
    const w = updateWorld();
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "status=in-progress", "priority=P1"], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(0);
    const readme = w.files.get("/root/loopany/cheap-geo-ppp/README.md")!;
    expect(readFrontmatter(readme)).toMatchObject({ status: "in-progress", priority: "P1" });
    expect(readme).toMatch(/## Timeline[\s\S]*status → in-progress, priority → P1 \(tester\)/);
    // The edited README rides a PATCH so the server's tree index refreshes
    // immediately (not only on the next watcher sync).
    expect(w.patches).toHaveLength(1);
    expect((w.patches[0] as { patch: { taskFileContent: string } }).patch.taskFileContent).toContain("in-progress");
  });


  it("assignee routing: email → front matter (human); slug and machine/runtime → server op; null → clear", async () => {
    // email → workState → README front matter, no envelope.assignee
    let w = updateWorld();
    let c = capture();
    expect(await runTaskUpdate(["cheap-geo-ppp", "assignee=alice@x.dev"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps)).toBe(0);
    expect(readFrontmatter(w.files.get("/root/loopany/cheap-geo-ppp/README.md")!)).toMatchObject({ assignee: "alice@x.dev" });
    expect((w.patches[0] as { patch: Record<string, unknown> }).patch.assignee).toBeUndefined();

    // bare registry slug (no slash!) → envelope op, NEVER front matter
    w = updateWorld();
    c = capture();
    expect(await runTaskUpdate(["cheap-geo-ppp", "assignee=claude-studio"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps)).toBe(0);
    expect((w.patches[0] as { patch: Record<string, unknown> }).patch.assignee).toBe("claude-studio");
    expect(readFrontmatter(w.files.get("/root/loopany/cheap-geo-ppp/README.md")!).assignee).toBeUndefined();

    // machine/runtime alias still routes to the op
    w = updateWorld();
    c = capture();
    expect(await runTaskUpdate(["cheap-geo-ppp", "assignee=Studio/claude-code"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps)).toBe(0);
    expect((w.patches[0] as { patch: Record<string, unknown> }).patch.assignee).toBe("Studio/claude-code");

    // null clears the HUMAN plane (front matter), not the executor
    w = updateWorld();
    c = capture();
    expect(await runTaskUpdate(["cheap-geo-ppp", "assignee=null"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps)).toBe(0);
    expect((w.patches[0] as { patch: Record<string, unknown> }).patch.assignee).toBeUndefined();
  });

  it("combined status+assignee(agent) rides ONE PATCH carrying both taskFileContent and the op", async () => {
    const w = updateWorld();
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "status=todo", "assignee=claude-studio"], {
      ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(0);
    expect(w.patches).toHaveLength(1);
    const patch = (w.patches[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.assignee).toBe("claude-studio");
    expect(String(patch.taskFileContent)).toContain("status: todo");
  });

  it("prints the server's hint line when present", async () => {
    const { fsImpl } = memFs({ "/root/loopany/cheap-geo-ppp/README.md": seededFile });
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, task: TASK(), children: [] } }),
      "PATCH /api/machine/loop": () => ({ body: { ok: true, id: "loop-1", applied: ["taskFileContent"], hint: "status alone never dispatches — loopany run cheap-geo-ppp starts it now" } }),
    });
    const c = capture();
    expect(await runTaskUpdate(["cheap-geo-ppp", "status=todo"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn } as TaskDeps)).toBe(0);
    expect(c.out.join("")).toContain("hint: status alone never dispatches");
  });

  it("status=follow-up without follow_up_date is a hard error", async () => {
    const w = updateWorld();
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "status=follow-up"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("follow_up_date");
    const ok = await runTaskUpdate(["cheap-geo-ppp", "status=follow-up", "follow_up_date=2026-07-17"], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(ok).toBe(0);
  });

  it("status=done on a recurring task also pauses the schedule (enabled=false PATCH)", async () => {
    const w = updateWorld({ cron: "0 9 * * 1" });
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "status=done"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(code).toBe(0);
    expect(w.patches).toHaveLength(1);
    const patch = (w.patches[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.enabled).toBe(false);
    expect(String(patch.taskFileContent)).toContain("status: done");
  });

  it("cron=<expr> arms via the server PATCH; cron=null disarms", async () => {
    const w = updateWorld();
    const c = capture();
    await runTaskUpdate(["cheap-geo-ppp", "cron=0 9 * * 1"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(w.patches[0]).toMatchObject({ patch: { cron: "0 9 * * 1" } });
    await runTaskUpdate(["cheap-geo-ppp", "cron=null"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(w.patches[1]).toMatchObject({ patch: { cron: null } });
  });

  it("--note appends a dated attributed Timeline line", async () => {
    const w = updateWorld();
    const c = capture();
    await runTaskUpdate(["cheap-geo-ppp", "--note", "readout: 29%→41%"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(w.files.get("/root/loopany/cheap-geo-ppp/README.md")!).toMatch(/readout: 29%→41% \(tester\)/);
  });

  it("unknown keys enumerate both vocabularies", async () => {
    const w = updateWorld();
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "prio=P1"], { ...BASE, ...c.deps, fsImpl: w.fsImpl, fetchFn: w.fn } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toMatch(/work-state: .*priority/);
    expect(c.err.join("")).toMatch(/envelope: .*cron/);
  });
});

describe("list / get", () => {
  it("renders the tree mode with schedule + due badges", async () => {
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({
        body: {
          ok: true,
          mode: "tree",
          tree: [
            {
              ...TASK({ slug: "goal", title: "Goal", cron: null }),
              children: [{ ...TASK({ slug: "leaf", title: "Leaf", cron: "0 9 * * 1", follow_up_date: "2026-07-10" }), children: [] }],
            },
          ],
        },
      }),
    });
    const c = capture();
    const code = await runTaskList([], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps);
    expect(code).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("goal");
    expect(text).toContain("⟳ 0 9 * * 1");
    expect(text).toContain("⏰ 2026-07-10");
  });

  it("get renders node + content + children and forwards --runs", async () => {
    const { fn, calls } = fakeFetch({
      "GET /api/machine/task": () => ({
        body: {
          ok: true,
          task: { ...TASK(), content: "---\nid: cheap-geo-ppp\n---\n\n## Spec\nbody", goal: null, notify: "auto", nextRunAt: null },
          children: [TASK({ slug: "child-1", title: "Child" })],
          runs: [{ ts: "2026-07-03", role: "exec", phase: "done", outcome: "exec", message: "did it" }],
        },
      }),
    });
    const c = capture();
    const code = await runTaskGet(["cheap-geo-ppp", "--runs"], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps);
    expect(code).toBe(0);
    expect(new URL(calls[0]!.url).searchParams.get("runs")).toBe("1");
    const text = c.out.join("");
    expect(text).toContain("## Spec");
    expect(text).toContain("children (1)");
    expect(text).toContain("did it");
  });
});

describe("mv", () => {
  it("midpoint-inserts before a sibling by editing ONE file", async () => {
    const file = scaffoldReadme({ slug: "b", title: "B", date: "2026-07-01" });
    const { fsImpl, files } = memFs({ "/root/loopany/b/README.md": file });
    const { fn } = fakeFetch({
      "PATCH /api/machine/loop": () => ({ body: { ok: true } }),
      "GET /api/machine/task": (u) => {
        const op = new URL(u).searchParams.get("op");
        if (op === "get") return { body: { ok: true, task: TASK({ slug: "b", title: "B", taskFile: "/root/loopany/b/README.md", priority: "P2" }), children: [] } };
        return {
          body: {
            ok: true,
            mode: "flat",
            rows: [
              TASK({ loopId: "l-a", slug: "a", title: "A", order: 1, priority: "P2" }),
              TASK({ loopId: "l-c", slug: "c", title: "C", order: 2, priority: "P2" }),
            ],
          },
        };
      },
    });
    const c = capture();
    const code = await runTaskMv(["b", "--before", "c"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn } as TaskDeps);
    expect(code).toBe(0);
    expect(readFrontmatter(files.get("/root/loopany/b/README.md")!).order).toBe("1.5");
  });

  it("rejects when zero or two placement flags are given", async () => {
    const c = capture();
    expect(await runTaskMv(["b"], { ...BASE, ...c.deps } as TaskDeps)).toBe(2);
    expect(await runTaskMv(["b", "--top", "--bottom"], { ...BASE, ...c.deps } as TaskDeps)).toBe(2);
  });
});

describe("run", () => {
  it("dispatches and, with --wait, polls until the run finishes", async () => {
    let polls = 0;
    const { fn } = fakeFetch({
      "POST /api/machine/loop/run": () => ({ body: { ok: true, id: "loop-1", name: "Cheap geo PPP" } }),
      "GET /api/machine/log": () => {
        polls++;
        return {
          body: {
            ok: true,
            runs: [
              polls < 2
                ? { ts: new Date().toISOString(), phase: "running", role: "exec" }
                : { ts: new Date().toISOString(), phase: "done", role: "exec", message: "all good" },
            ],
          },
        };
      },
    });
    const c = capture();
    const code = await runTaskRun(["cheap-geo-ppp", "--wait"], {
      ...BASE,
      ...c.deps,
      fetchFn: fn,
      sleep: async () => undefined,
    } as TaskDeps);
    expect(code).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(c.out.join("")).toContain("all good");
  });

  it("--wait on an offline machine warns and skips the wait entirely (nothing will claim the run)", async () => {
    let polls = 0;
    const { fn } = fakeFetch({
      "POST /api/machine/loop/run": () => ({
        body: { ok: true, id: "loop-1", name: "Cheap geo PPP", machine: { id: "m-2", name: "Remote-Studio", presence: "offline" } },
      }),
      "GET /api/machine/log": () => {
        polls++;
        return { body: { ok: true, runs: [] } };
      },
    });
    const c = capture();
    const code = await runTaskRun(["cheap-geo-ppp", "--wait"], {
      ...BASE,
      ...c.deps,
      fetchFn: fn,
      sleep: async () => undefined,
    } as TaskDeps);
    expect(code).toBe(0);
    expect(polls).toBe(0); // never entered the wait loop
    expect(c.err.join("")).toContain("Remote-Studio is offline");
    expect(c.out.join("")).toContain("not waiting");
  });

  it("an online machine echo keeps --wait polling exactly as before", async () => {
    let polls = 0;
    const { fn } = fakeFetch({
      "POST /api/machine/loop/run": () => ({
        body: { ok: true, id: "loop-1", name: "N", machine: { id: "m-1", name: "M", presence: "online" } },
      }),
      "GET /api/machine/log": () => {
        polls++;
        return { body: { ok: true, runs: [{ ts: new Date().toISOString(), phase: "done", role: "exec" }] } };
      },
    });
    const c = capture();
    const code = await runTaskRun(["cheap-geo-ppp", "--wait"], { ...BASE, ...c.deps, fetchFn: fn, sleep: async () => undefined } as TaskDeps);
    expect(code).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(c.err.join("")).toBe("");
  });

  it("surfaces the server's already-running refusal", async () => {
    const { fn } = fakeFetch({
      "POST /api/machine/loop/run": () => ({ status: 409, body: { error: "a run is already open for this task" } }),
    });
    const c = capture();
    const code = await runTaskRun(["cheap-geo-ppp"], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("already open");
  });
});

describe("create --cron sugar", () => {
  function createWorld() {
    const { fsImpl, files } = memFs();
    const posts: unknown[] = [];
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
      "POST /api/machine/loop": (_u, body) => {
        posts.push(body);
        return { body: { ok: true, id: "loop-9", name: "Nightly sweep" } };
      },
    });
    return { fsImpl, files, posts, fn };
  }

  it("--cron rides into the create envelope (one-line loop creation)", async () => {
    const w = createWorld();
    const c = capture();
    const code = await runTaskCreate(["Nightly sweep", "--cron", "0 3 * * *"], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(0);
    expect(w.posts[0]).toMatchObject({ cron: "0 3 * * *", slug: "nightly-sweep" });
  });

  it("a conflicting --json cron is a loud error, never a silent pick", async () => {
    const w = createWorld();
    const c = capture();
    const code = await runTaskCreate(["Nightly sweep", "--cron", "0 3 * * *", "--json", '{"cron":"0 4 * * *"}'], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("conflicts");
    expect(w.posts).toHaveLength(0);
  });

  it("an identical --json cron is not a conflict", async () => {
    const w = createWorld();
    const c = capture();
    const code = await runTaskCreate(["Nightly sweep", "--cron", "0 3 * * *", "--json", '{"cron":"0 3 * * *"}'], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(0);
    expect(w.posts[0]).toMatchObject({ cron: "0 3 * * *" });
  });

  it("rejects a non-5-field cron before scaffolding anything", async () => {
    const w = createWorld();
    const c = capture();
    const code = await runTaskCreate(["Nightly sweep", "--cron", "every day at 3"], {
      ...BASE,
      ...c.deps,
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("5-field");
    expect(w.files.size).toBe(0); // no folder left behind
  });
});

describe("update content-file cwd fence", () => {
  const seededFile = scaffoldReadme({ slug: "cheap-geo-ppp", title: "Cheap geo PPP", type: "experiment", status: "todo", date: "2026-07-01" });

  function fenceWorld() {
    const { fsImpl, files } = memFs({
      "/root/loopany/cheap-geo-ppp/README.md": seededFile,
      "/tmp/ui.html": "<h1>stale from another run</h1>",
      "/work/ui.html": "<h1>fresh</h1>",
    });
    const patches: unknown[] = [];
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, task: TASK(), children: [] } }),
      "PATCH /api/machine/loop": (_u, body) => {
        patches.push(body);
        return { body: { ok: true, id: "loop-1", applied: ["ui"] } };
      },
    });
    return { fsImpl, files, patches, fn };
  }

  it("refuses a /tmp content file with the fence message", async () => {
    const w = fenceWorld();
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "--ui-file", "/tmp/ui.html"], {
      ...BASE,
      ...c.deps,
      cwd: () => "/work",
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("--allow-external-file");
    expect(w.patches).toHaveLength(0);
  });

  it("--allow-external-file overrides deliberately; in-cwd paths never prompt", async () => {
    const w = fenceWorld();
    const c = capture();
    const forced = await runTaskUpdate(["cheap-geo-ppp", "--ui-file", "/tmp/ui.html", "--allow-external-file"], {
      ...BASE,
      ...c.deps,
      cwd: () => "/work",
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(forced).toBe(0);
    const inCwd = await runTaskUpdate(["cheap-geo-ppp", "--ui-file", "/work/ui.html"], {
      ...BASE,
      ...c.deps,
      cwd: () => "/work",
      fsImpl: w.fsImpl,
      fetchFn: w.fn,
    } as TaskDeps);
    expect(inCwd).toBe(0);
    expect(w.patches).toHaveLength(2);
  });
});

describe("create --json envelope capture (pre-existing parseArgs bug)", () => {
  it("captures the --json object as the envelope, never as title text", async () => {
    const { fsImpl, files } = memFs();
    const posts: unknown[] = [];
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
      "POST /api/machine/loop": (_u, body) => {
        posts.push(body);
        return { body: { ok: true, id: "loop-9" } };
      },
    });
    const c = capture();
    const code = await runTaskCreate(["Nightly sweep", "--json", '{"notify":"never","cron":"0 3 * * *"}'], {
      ...BASE,
      ...c.deps,
      fsImpl,
      fetchFn: fn,
    } as TaskDeps);
    expect(code).toBe(0);
    // The envelope landed as fields — and the title (→ slug/folder) stayed clean.
    expect(posts[0]).toMatchObject({ notify: "never", cron: "0 3 * * *", name: "Nightly sweep", slug: "nightly-sweep" });
    expect(files.has("/root/loopany/nightly-sweep/README.md")).toBe(false); // cloud-born, no local scaffold
  });

  it("list --json stays a boolean output-mode flag (no value swallowed)", async () => {
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, mode: "flat", rows: [] } }),
    });
    const c = capture();
    const code = await runTaskList(["--json"], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps);
    expect(code).toBe(0);
    expect(() => JSON.parse(c.out.join(""))).not.toThrow();
  });
});

describe("doc working copy (get --checkout / update --doc-file)", () => {
  it("checkout materializes <slug>.md + the .base sidecar with the server hash", async () => {
    const { fsImpl, files } = memFs();
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, task: { ...TASK(), content: "## Spec\nx\n", docHash: "abc123" }, children: [] } }),
    });
    const c = capture();
    const code = await runTaskGet(["cheap-geo-ppp", "--checkout"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn, cwd: () => "/work" } as TaskDeps);
    expect(code).toBe(0);
    expect(files.get("/work/cheap-geo-ppp.md")).toBe("## Spec\nx\n");
    expect(files.get("/work/cheap-geo-ppp.md.base")).toBe("abc123\n");
    expect(c.out.join("")).toContain("--doc-file cheap-geo-ppp.md");
  });

  it("doc push sends {doc, docBase} alone and advances the sidecar; 409 shows the diff", async () => {
    const { fsImpl, files } = memFs({ "/work/cheap-geo-ppp.md": "## Spec\nedited\n", "/work/cheap-geo-ppp.md.base": "abc123\n" });
    const patches: unknown[] = [];
    let status = 200;
    const { fn } = fakeFetch({
      "GET /api/machine/task": () => ({ body: { ok: true, task: TASK(), children: [] } }),
      "PATCH /api/machine/loop": (_u, body) => {
        patches.push(body);
        return status === 200
          ? { body: { ok: true, docHash: "def456", text: "doc: updated (14 bytes)" } }
          : { status, body: { error: "doc changed on the server since your checkout", diff: "--- your base\n+++ server\n+server line" } };
      },
    });
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "--doc-file", "/work/cheap-geo-ppp.md"], { ...BASE, ...c.deps, fsImpl, fetchFn: fn, cwd: () => "/work" } as TaskDeps);
    expect(code).toBe(0);
    expect((patches[0] as { patch: { doc: string; docBase: string } }).patch).toEqual({ doc: "## Spec\nedited\n", docBase: "abc123" });
    expect(files.get("/work/cheap-geo-ppp.md.base")).toBe("def456\n"); // sidecar advanced

    status = 409;
    const c2 = capture();
    const conflicted = await runTaskUpdate(["cheap-geo-ppp", "--doc-file", "/work/cheap-geo-ppp.md"], { ...BASE, ...c2.deps, fsImpl, fetchFn: fn, cwd: () => "/work" } as TaskDeps);
    expect(conflicted).toBe(2);
    expect(c2.err.join("")).toContain("+server line"); // the diff IS the merge input
    expect(files.get("/work/cheap-geo-ppp.md.base")).toBe("def456\n"); // untouched on refusal
  });

  it("doc push without a sidecar teaches checkout; mixing with field writes is refused", async () => {
    const { fsImpl } = memFs({ "/work/cheap-geo-ppp.md": "x" });
    const c = capture();
    const code = await runTaskUpdate(["cheap-geo-ppp", "--doc-file", "/work/cheap-geo-ppp.md"], { ...BASE, ...c.deps, fsImpl, cwd: () => "/work" } as TaskDeps);
    expect(code).toBe(2);
    expect(c.err.join("")).toContain("--checkout");

    const c2 = capture();
    const mixed = await runTaskUpdate(["cheap-geo-ppp", "status=done", "--doc-file", "/work/cheap-geo-ppp.md"], { ...BASE, ...c2.deps, fsImpl, cwd: () => "/work" } as TaskDeps);
    expect(mixed).toBe(2);
    expect(c2.err.join("")).toContain("alone");
  });
});

describe("review (F7 worklist)", () => {
  it("lists the queue, clears one item, and errors on bad usage", async () => {
    const { runTaskReview } = await import("./tasks.js");
    const { fn, calls } = fakeFetch({
      "GET /api/machine/task": () => ({
        body: { ok: true, items: [{ task: "reddit-loop", path: "drafts/r1.md", title: "Reply draft", type: "draft", due: "2026-07-28", updatedAt: "2026-07-27T00:00:00Z" }] },
      }),
      "POST /api/machine/task": (_u, body) => {
        expect(body).toMatchObject({ op: "review-clear", id: "reddit-loop", path: "drafts/r1.md" });
        return { body: { ok: true, text: "reviewed: reddit-loop :: drafts/r1.md" } };
      },
    });
    const c = capture();
    expect(await runTaskReview([], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps)).toBe(0);
    expect(c.out.join("")).toContain("reddit-loop :: drafts/r1.md");
    expect(c.out.join("")).toContain("⏰ 2026-07-28");

    expect(await runTaskReview(["clear", "reddit-loop", "drafts/r1.md"], { ...BASE, ...c.deps, fetchFn: fn } as TaskDeps)).toBe(0);
    expect(c.out.join("")).toContain("reviewed:");

    const bad = capture();
    expect(await runTaskReview(["clear", "reddit-loop"], { ...BASE, ...bad.deps, fetchFn: fn } as TaskDeps)).toBe(2);
    expect(bad.err.join("")).toContain("usage");
    void calls;
  });
});
