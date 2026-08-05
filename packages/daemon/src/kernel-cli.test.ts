import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runKernelCli, type KernelCliDeps } from "./kernel-cli.js";
import { slugFor } from "./kernel-render.js";
import { classify } from "./route.js";

const NOW = Date.parse("2026-08-03T09:00:00.000Z");
/** Kept in a VARIABLE: a literal `new URL("./x.ts", import.meta.url)` is
 *  statically rewritten into an asset URL, which `fileURLToPath` then rejects. */
const CLI_SOURCE = "./kernel-cli.ts";

function reply(body: unknown, status = 200, type = "application/json") {
  return new Response(type === "application/json" ? JSON.stringify(body) : String(body), { status, headers: { "Content-Type": type } });
}

/** Runs the CLI against a stub server and returns everything a caller can see:
 *  the exact stdout, the exit code, and the request that was actually sent. */
async function run(argv: string[], body: unknown, status = 200, extra: Partial<KernelCliDeps> = {}) {
  let stdout = "";
  let request: Request | undefined;
  const code = await runKernelCli(argv, {
    server: "https://example.test", token: "dk_test", env: { LOOPANY_RUN_ID: "run-3f8a20" },
    now: () => NOW, out: (text) => { stdout += text; },
    fetchImpl: async (input, init) => { request = new Request(input, init); return reply(body, status); },
    ...extra,
  });
  return { code, stdout, request };
}

// ------------------------------------------------------------------- plumbing

describe("routing and the invisible run context", () => {
  it("classifies the rewrite object verbs away from the legacy run-token callback", () => {
    expect(classify(["task", "list"], { LOOPANY_RUN_TOKEN: "rk_old", LOOPANY_RUN_ID: "run-new" })).toEqual({ kind: "kernel", argv: ["task", "list"] });
    expect(classify(["inbox"], {})).toEqual({ kind: "kernel", argv: ["inbox"] });
  });

  it("attaches the run id as a header — never as an argument the agent could edit", async () => {
    const { request } = await run(["task", "list"], { tasks: [], total: 0 });
    expect(request!.headers.get("x-loopany-run")).toBe("run-3f8a20");
    expect(request!.headers.get("authorization")).toBe("Bearer dk_test");
    expect(request!.url).not.toContain("run-3f8a20");
  });

  /**
   * THE IN-RUN CREDENTIAL. The device token is a FILE under `LOOPANY_HOME`, and
   * the daemon's allowlisted child env carries neither that variable nor the
   * token — so on a stack with a relocated home this read resolved to some other
   * machine's `~/.loopany` and every kernel verb in the delivery came back
   * UNAUTHORIZED. `LOOPANY_RUN_TOKEN` is set on every run and is the authority
   * the server checks anyway, so it is what rides.
   */
  it("sends the RUN's own lease token inside a run, and falls back to the device token", async () => {
    const send = async (env: NodeJS.ProcessEnv) => {
      let request: Request | undefined;
      await runKernelCli(["task", "list"], {
        server: "https://example.test", env, out: () => {},
        readFile: () => "", now: () => NOW,
        fetchImpl: async (input, init) => { request = new Request(input, init); return reply({ tasks: [], total: 0 }); },
      });
      return request!.headers.get("authorization");
    };
    expect(await send({ LOOPANY_RUN_ID: "run-3f8a20", LOOPANY_RUN_TOKEN: "rk_lease", LOOPANY_TOKEN: "dk_device" })).toBe("Bearer rk_lease");
    // No lease in the env (an older daemon's delivery) ⇒ the device token still
    // authenticates, so this is not a flag day.
    expect(await send({ LOOPANY_RUN_ID: "run-3f8a20", LOOPANY_TOKEN: "dk_device" })).toBe("Bearer dk_device");
    // …and outside a run neither credential is attached at all.
    expect(await send({ LOOPANY_RUN_TOKEN: "rk_lease", LOOPANY_TOKEN: "dk_device" })).toBeNull();
  });

  it("never sends the machine's credential on the two HUMAN verbs", async () => {
    // The ordinary human runs this CLI on the same machine the daemon is
    // registered on, so the device token is always on disk. Sending it names the
    // wrong actor on a surface that belongs to a person.
    for (const argv of [["inbox"], ["answer", "task-7f3a91", "yes"]]) {
      const { request } = await run(argv, { items: [], counts: { total: 0 }, task: { id: "task-7f3a91", kind: "task" }, run: null });
      expect(request!.headers.get("authorization"), argv[0]).toBeNull();
    }
    // …and still sends it on every agent verb.
    const { request } = await run(["task", "list"], { tasks: [], total: 0 });
    expect(request!.headers.get("authorization")).toBe("Bearer dk_test");
  });

  it("never sends the machine's credential OUTSIDE a run, on any verb", async () => {
    // The credential travels with the run context. Outside a run the caller is
    // the person at the keyboard, and a device token there is answered
    // `NO_RUN_CONTEXT` on every DUAL read (§2.6) — which refused `loop show`,
    // `loop list` and `task list` for exactly the owner they serve.
    for (const argv of [["task", "list"], ["loop", "list"], ["loop", "show", "loop-8e3311"], ["doc", "show", "doc-1"]]) {
      let request: Request | undefined;
      await runKernelCli(argv, {
        server: "https://example.test", token: "dk_test", env: {}, out: () => {},
        fetchImpl: async (input, init) => { request = new Request(input, init); return reply({ tasks: [], loops: [], total: 0, loop: { id: "loop-8e3311" }, doc: { id: "doc-1", kind: "doc" }, events: [] }); },
      });
      if (argv[0] === "loop") {
        // S3 answers retired kernel loop verbs locally, so no credential can
        // ride a request: there is no request.
        expect(request, argv.join(" ")).toBeUndefined();
        continue;
      }
      expect(request!.headers.get("authorization"), argv.join(" ")).toBeNull();
      expect(request!.headers.get("x-loopany-run"), argv.join(" ")).toBeNull();
    }
  });

  it("carries the human session cookie when one is set", async () => {
    let request: Request | undefined;
    await runKernelCli(["inbox"], {
      server: "https://example.test", token: "dk_test", env: { LOOPANY_SESSION: "sess-abc" }, out: () => {},
      fetchImpl: async (input, init) => { request = new Request(input, init); return reply({ items: [], counts: { total: 0 } }); },
    });
    expect(request!.headers.get("cookie")).toBe("better-auth.session_token=sess-abc");
  });

  it("maps the HTTP status to the four exit codes without parsing prose", async () => {
    for (const [status, exit] of [[200, 0], [401, 1], [403, 2], [404, 3], [409, 2], [429, 1], [500, 1]] as const) {
      const { code, stdout } = await run(["task", "show", "task-7f3a91"], status === 200 ? { task: { id: "task-7f3a91", kind: "task" }, events: [] } : { code: "X", message: "no", issues: [], hint: "next" }, status);
      expect(code, `status ${status}`).toBe(exit);
      expect(stdout).toContain("help[");
    }
  });

  it("treats an unreachable server as transport, not as a bad command", async () => {
    let stdout = "";
    const code = await runKernelCli(["task", "list"], { server: "https://example.test", token: "dk", out: (t) => { stdout += t; }, env: {}, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    expect(code).toBe(1);
    expect(stdout).toContain("code: ERROR");
    expect(stdout).toContain("retry with backoff");
  });
});

// ------------------------------------------------------------- golden outputs

describe("task list", () => {
  it("renders the five default columns above a self-guiding tail", async () => {
    const { code, stdout } = await run(["task", "list", "--open"], {
      total: 2, viewerLoop: "loop-4c1d77",
      tasks: [
        { id: "task-52ff10", title: "Observe the impact of PR #201", followUpAt: null, watcher: "loop-4c1d77", pendingQuestion: null },
        { id: "task-9a1c03", title: "Verify the docs sweep landed", followUpAt: "2026-08-06T09:00:00.000Z", watcher: "loop-8e3311", pendingQuestion: null },
      ],
    });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "count: 2\n" +
      "tasks[2]{id,title,follow_up,watcher,question}:\n" +
      '  task-52ff10,"Observe the impact of PR #201",—,loop-4c1d77,—\n' +
      '  task-9a1c03,"Verify the docs sweep landed","2026-08-06T09:00:00.000Z",loop-8e3311,—\n' +
      "help[3]:\n" +
      "  Run `loopany task show <id>` to read one, with its payload and event tail\n" +
      "  Run `loopany task update <id> --follow-up +3d` to change when its watcher is woken for it\n" +
      "  Run `loopany task list --watcher loop-4c1d77 --due` for the work you already own\n",
    );
  });

  /** `--unwatched` retired with the pool it queried: an unknown flag, exit 2. */
  it("refuses --unwatched — there is no unwatched set to ask for", async () => {
    const { code, stdout } = await run(["task", "list", "--open", "--unwatched"], { tasks: [], total: 0 });
    expect(code).toBe(2);
    expect(stdout).toContain('error: "unknown flag --unwatched"');
    expect(stdout).toContain("allowed[6]: --open, --closed, --due, --watcher, --creator, --since");
  });

  it("inlines the real id when the list has exactly one row", async () => {
    const { stdout } = await run(["task", "list", "--due"], { total: 1, viewerLoop: "loop-4c1d77", tasks: [{ id: "task-7f3a91", title: "Observe", followUpAt: null, watcher: "loop-4c1d77", pendingQuestion: null }] });
    expect(stdout).toContain("Run `loopany task show task-7f3a91`");
  });

  it("echoes the filter on an empty result and refuses to invite invented work", async () => {
    const { code, stdout } = await run(["task", "list", "--watcher", "loop-4c1d77", "--due"], { total: 0, tasks: [], viewerLoop: "loop-4c1d77" });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "count: 0\n" +
      "tasks: []\n" +
      'filter: "--due --watcher loop-4c1d77"\n' +
      "help[2]:\n" +
      "  Run `loopany task list --watcher loop-4c1d77` for everything this loop is on the hook for, due or not\n" +
      "  Nothing due is a clean result — do not manufacture work\n",
    );
  });

  it("says how much it is NOT showing rather than clipping silently", async () => {
    const { stdout } = await run(["task", "list"], { total: 112, truncated: true, viewerLoop: "loop-4c1d77", tasks: [{ id: "task-1", title: "a", followUpAt: null, watcher: null, pendingQuestion: null }] });
    expect(stdout).toContain("count: 1 of 112 total");
    expect(stdout).toContain("narrow the query rather than paging");
  });

  it("translates the flag set into the wire filters", async () => {
    const { request } = await run(["task", "list", "--closed", "--since", "14d", "--creator", "loop-8e3311"], { tasks: [], total: 0 });
    const url = new URL(request!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "closed", since: "14d", creator: "loop-8e3311" });
  });
});

describe("task show", () => {
  it("prints detail, payload, a truncation-escaped body and the seq-led event tail", async () => {
    const { stdout } = await run(["task", "show", "task-7f3a91"], {
      task: {
        id: "task-7f3a91", kind: "task", title: "Observe the impact of PR #201", status: "open",
        followUpAt: "2026-08-03T05:00:00.000Z", watcher: "loop-4c1d77", pendingQuestion: null, key: "pr-201-impact",
        createdByRun: "run-3f8a20", createdByLoop: "loop-2d7e55", createdAt: "2026-08-01T07:04:11.000Z", updatedAt: "2026-08-02T09:12:40.000Z", closedAt: null,
        payload: { pr: 201 }, body: "## What to watch\n",
      },
      events: [
        { seq: 8801, ts: "2026-08-01T07:04:11.000Z", actor: "run-3f8a20", entrance: "clock", kind: "object-created", diff: null },
        { seq: 8912, ts: "2026-08-02T09:12:40.000Z", actor: "run-51cc09", entrance: "agent", kind: "object-updated", diff: { watcher: { old: null, new: "loop-4c1d77" } } },
      ],
    });
    expect(stdout).toContain("  follow_up: 2026-08-03T05:00:00.000Z (due, 4h ago)\n");
    expect(stdout).toContain("  key: pr-201-impact\n");
    expect(stdout).toContain("payload:\n  pr: 201\n");
    expect(stdout).toContain("events[2]{seq,ts,actor,entrance,change}:\n");
    expect(stdout).toContain("  8801,");
    expect(stdout).toContain('"watcher: — → loop-4c1d77"');
    expect(stdout).toContain("Run `loopany task close task-7f3a91 --note \"…\"` when it is verified");
  });

  it("truncates a long body with the --full escape named in the hint", async () => {
    const body = "x".repeat(900);
    const { stdout } = await run(["task", "show", "task-7f3a91"], { task: { id: "task-7f3a91", kind: "task", body, payload: {} }, events: [] });
    expect(stdout).toContain("(truncated, 900 chars total — use --full to see complete body)");
    const full = await run(["task", "show", "task-7f3a91", "--full"], { task: { id: "task-7f3a91", kind: "task", body, payload: {} }, events: [] });
    expect(full.stdout).not.toContain("truncated");
  });

  it("emits the artifact verbatim under --file: a file, with no ok: line and no help block", async () => {
    let stdout = "";
    const file = "---\ntitle: Observe\nkey: pr-201-impact\n---\n\n## What to watch\n";
    const code = await runKernelCli(["task", "show", "task-7f3a91", "--file"], {
      server: "https://example.test", token: "dk", env: {}, out: (t) => { stdout += t; },
      fetchImpl: async () => reply(file, 200, "text/markdown"),
    });
    expect(code).toBe(0);
    expect(stdout).toBe(file);
  });

  it("asks for the id rather than guessing one", async () => {
    const { code, stdout } = await run(["task", "show"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "task show requires a task id"');
    expect(stdout).toContain("expected: loopany task show <id>");
  });
});

describe("task create", () => {
  /**
   * The watcher DEFAULTED to the creating loop and no `follow_up` was set, so
   * the render names both consequences: who is on the hook (and that it was the
   * default), and that nothing will wake them for it.
   */
  it("prints the handle first and the consequence of every default it took", async () => {
    const { code, stdout, request } = await run(["task", "create", "--file", "-"], {
      created: true, event: "ev-1",
      task: { id: "task-7f3a91", kind: "task", title: "Observe the impact of PR #201", status: "open", followUpAt: null, watcher: "loop-2d7e55", pendingQuestion: null, key: "pr-201-impact", createdByLoop: "loop-2d7e55", payload: {} },
    }, 201, { readStdin: () => "---\ntitle: Observe the impact of PR #201\nkey: pr-201-impact\n---\n\nbody\n" });
    expect(code).toBe(0);
    expect(request!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(stdout.startsWith("ok: created task-7f3a91\n")).toBe(true);
    expect(stdout).toContain("  watcher: loop-2d7e55\n");
    expect(stdout).toContain("loop-2d7e55 is watching it — the default: a task you file is yours unless you name another loop");
    expect(stdout).toContain("with no follow_up it waits for the loop's own cadence");
  });

  it("makes the R-answer contract visible on a gated create", async () => {
    const { stdout } = await run(["task", "create", "--file", "-", "--needs-human", "Post this reply?", "--watcher", "loop-8e3311"], {
      created: true, event: "ev-1",
      task: { id: "task-0b19ac", kind: "task", title: "Reddit reply", status: "open", followUpAt: null, watcher: "loop-8e3311", pendingQuestion: "Post this reply?", key: null, payload: {} },
    }, 201, { readStdin: () => "---\ntitle: Reddit reply\n---\n\nbody\n" });
    expect(stdout).toContain("This task is in the human inbox now; `loopany task close` is refused until it is answered");
    expect(stdout).toContain("On answer, one run is queued for loop-8e3311 with scope task-0b19ac");
  });

  it("folds a kernel-primitive flag into the uploaded front matter", async () => {
    const { request } = await run(["task", "create", "--file", "-", "--watcher", "loop-8e3311", "--follow-up", "+3d"], { created: true, task: { id: "t", kind: "task", payload: {} } }, 201, { readStdin: () => "---\ntitle: A\n---\n\nbody\n" });
    const sent = await request!.text();
    expect(sent).toContain('watcher: "loop-8e3311"');
    expect(sent).toContain('follow_up: "+3d"');
    expect(sent).toContain("\n---\n\nbody\n");
  });

  it("refuses a flag and a front-matter key supplying the same field, printing both", async () => {
    let called = false;
    const { code, stdout } = await run(["task", "create", "--file", "-", "--watcher", "loop-8e3311"], {}, 200, {
      readStdin: () => "---\nwatcher: loop-4c1d77\n---\nbody\n",
      fetchImpl: async () => { called = true; return reply({}); },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(stdout).toContain('error: "watcher was supplied twice, by --watcher and by the file\'s front matter"');
    expect(stdout).toContain("loop-8e3311");
    expect(stdout).toContain("loop-4c1d77");
    expect(stdout).toContain("there is no precedence rule");
  });

  it("says the changes went nowhere when a key already exists with different content", async () => {
    const { code, stdout } = await run(["task", "create", "--file", "-"], {
      created: false, contentDiffers: true, differingFields: ["title", "body"], event: null,
      notice: { code: "KEY_EXISTS_CONTENT_DIFFERS", message: "key \"pr-201-impact\" already names task-7f3a91; the submitted file differs from it and was not applied" },
      task: { id: "task-7f3a91", kind: "task", title: "Observe", status: "open", key: "pr-201-impact", payload: {}, watcher: null, followUpAt: null, pendingQuestion: null },
    }, 200, { readStdin: () => "---\ntitle: Observe harder\nkey: pr-201-impact\n---\n\nbody\n" });
    // Exit 0: the object exists and its id is in hand — but the discard is loud.
    expect(code).toBe(0);
    expect(stdout).toContain("ok: created task-7f3a91 (idempotent: existing object returned)");
    expect(stdout).toContain("differs[2]: title, body");
    expect(stdout).toContain("your changes were NOT applied");
    expect(stdout).toContain("Run `loopany task update task-7f3a91 --file <path>` to apply them");
  });

  it("never sends a human to the agent-only evolve when a loop key already exists", async () => {
    const { code, stdout } = await run(["loop", "create", "--file", "-"], {
      created: false, contentDiffers: true, differingFields: ["body"], event: null,
      notice: { code: "KEY_EXISTS_CONTENT_DIFFERS", message: "key \"housekeeper\" already names loop-4c1d77; the submitted file differs from it and was not applied" },
      loop: { id: "loop-4c1d77", kind: "loop", title: "Housekeeper", status: "active", key: "housekeeper", cron: "0 7 * * *", nextFire: "2026-08-05T07:00:00.000Z", payload: {} },
    }, 200, { readStdin: () => "---\ntitle: Housekeeper\nkey: housekeeper\n---\n\nnew charter\n" });
    expect(code).toBe(2);
    expect(stdout).toContain("code: SURFACE_MOVED");
    expect(stdout).toContain("loopany new --json");
  });

  it("treats an unreadable file as transport, not as a bad command", async () => {
    const { code, stdout } = await run(["task", "create", "--file", "/tmp/definitely-not-here-9f13.md"], {});
    expect(code).toBe(1);
    expect(stdout).toContain("code: ERROR");
    expect(stdout).toContain("creation is file-first");
  });

  it("requires --file", async () => {
    const { code, stdout } = await run(["task", "create"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "task create requires --file"');
  });
});

/**
 * `--parent` — the hierarchy flag (convergence S4), on both write verbs.
 *
 * The CLI validates the SHAPE and nothing else: whether the parent exists, is a
 * task, is in this team and is outside this task's subtree are facts only the
 * kernel's transaction knows, and its `PARENT_CYCLE` / `NOT_FOUND` refusals are
 * printed verbatim (`renderRefusal`).
 */
describe("--parent, on create and on update", () => {
  it("folds --parent into the uploaded front matter on create", async () => {
    const { request } = await run(["task", "create", "--file", "-", "--parent", "task-7f3a91"], { created: true, task: { id: "t", kind: "task", payload: {} } }, 201, { readStdin: () => "---\ntitle: step 1\n---\n\nbody\n" });
    expect(await request!.text()).toContain('parent: "task-7f3a91"');
  });

  it("sends `parent` on the field patch, and `null` to move a task back to a root", async () => {
    const patched = await run(["task", "update", "task-52ff10", "--parent", "task-7f3a91"], { changed: true, event: "ev-1", diff: {}, task: { id: "task-52ff10", kind: "task", payload: {} } });
    expect(JSON.parse(await patched.request!.text())).toEqual({ parent: "task-7f3a91" });
    // The asymmetry with --watcher is the point: a task may stop being a
    // sub-task, but it may never stop having a watcher.
    const rooted = await run(["task", "update", "task-52ff10", "--parent", "null"], { changed: true, event: "ev-2", diff: {}, task: { id: "task-52ff10", kind: "task", payload: {} } });
    expect(JSON.parse(await rooted.request!.text())).toEqual({ parent: null });
  });

  it("refuses a loop id where a task id belongs, locally, and teaches the difference", async () => {
    for (const argv of [["task", "update", "task-52ff10", "--parent", "loop-4c1d77"], ["task", "create", "--file", "-", "--parent", "loop-4c1d77"]]) {
      const { code, stdout, request } = await run(argv, {}, 200, { readStdin: () => "---\ntitle: A\n---\nbody\n" });
      expect(code, argv.join(" ")).toBe(2);
      // No round trip: a shape error is the CLI's own to answer.
      expect(request).toBeUndefined();
      expect(stdout).toContain('error: "--parent takes a task id"');
      expect(stdout).toContain("the loop that acts next is the watcher");
    }
  });

  it("prints the kernel's cycle refusal verbatim, hint included", async () => {
    const { code, stdout } = await run(["task", "update", "task-a", "--parent", "task-b"], {
      code: "PARENT_CYCLE",
      message: "task-a is already an ancestor of task-b",
      issues: [{ path: "parentId", got: "task-b", expected: "a task outside this task's subtree" }],
      hint: "a task tree is a tree: pick a parent that is not this task and not underneath it, or clear the parent to make this task a root. Nothing was written.",
    }, 409);
    expect(code).toBe(2);
    expect(stdout).toContain('error: "task-a is already an ancestor of task-b"');
    expect(stdout).toContain("code: CONFLICT\n");
    expect(stdout).toContain("wrote:    task-b\n");
    expect(stdout).toContain("a task tree is a tree");
  });

  it("shows a task's parent and its sub-tasks, both directions on one screen", async () => {
    const { stdout } = await run(["task", "show", "task-child"], {
      task: { id: "task-child", kind: "task", title: "step 1", status: "open", followUpAt: null, watcher: "loop-4c1d77", parentId: "task-7f3a91", pendingQuestion: null, key: null, payload: {} },
      children: [{ id: "task-leaf", title: "sub step", status: "open", watcher: "loop-8e3311" }],
      events: [],
    });
    expect(stdout).toContain("parent: task-7f3a91\n");
    expect(stdout).toContain("children[1]{id,title,status,watcher}:\n");
    expect(stdout).toContain("  task-leaf,\"sub step\",open,loop-8e3311\n");
  });

  // A ROOT is the ordinary case, and it says so: an absent line would leave a
  // run inferring "no parent" from silence. An empty children list is omitted,
  // because "no sub-tasks" is not a fact worth a heading.
  it("says a root has no parent, and prints no empty children block", async () => {
    const { stdout } = await run(["task", "show", "task-7f3a91"], {
      task: { id: "task-7f3a91", kind: "task", title: "epic", status: "open", followUpAt: null, watcher: "loop-4c1d77", parentId: null, pendingQuestion: null, key: null, payload: {} },
      children: [],
      events: [],
    });
    expect(stdout).toContain("parent: \u2014\n");
    expect(stdout).not.toContain("children");
  });
});

describe("task update", () => {
  it("echoes the field-level diff the events table stores", async () => {
    const { code, stdout } = await run(["task", "update", "task-52ff10", "--watcher", "loop-4c1d77", "--follow-up", "+3d"], {
      changed: true, event: "ev-6b30a8",
      // A watcher move is loop → loop: a HAND-OFF, never a claim out of nothing.
      diff: { watcher: { old: "loop-8e3311", new: "loop-4c1d77" }, followUpAt: { old: null, new: "2026-08-06T09:00:00.000Z" } },
      task: { id: "task-52ff10", kind: "task", title: "Observe", status: "open", followUpAt: "2026-08-06T09:00:00.000Z", watcher: "loop-4c1d77", pendingQuestion: null, key: null, payload: {} },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: updated task-52ff10\n");
    expect(stdout).toContain("changed[2]:\n  watcher: loop-8e3311 → loop-4c1d77\n");
    expect(stdout).toContain("event: ev-6b30a8\n");
  });

  /**
   * TRANSFER ONLY. `--watcher null` released a task to the unclaimed pool until
   * the watcher rule; the pool is gone, so the CLI refuses it LOCALLY — before a
   * round trip — and names the reason rather than printing a bare "not a loop
   * id", because an agent carrying the old habit needs the rule, not the regex.
   */
  it("refuses --watcher null locally, and teaches the hand-off in its place", async () => {
    const { code, stdout, request } = await run(["task", "update", "task-52ff10", "--watcher", "null"], {});
    expect(code).toBe(2);
    // Local refusal: the helper records every call through `fetchImpl`, so an
    // undefined request is proof no round trip happened.
    expect(request).toBeUndefined();
    expect(stdout).toContain('error: "--watcher takes a loop id"');
    expect(stdout).toContain("wrote:    null\n");
    expect(stdout).toContain("never released");
    expect(stdout).toContain("loopany loop list");
  });

  it("still lets --follow-up be cleared with null — a date is not a watcher", async () => {
    const { code, request } = await run(["task", "update", "task-52ff10", "--follow-up", "null"], {
      changed: true, event: "ev-1", diff: {}, task: { id: "task-52ff10", kind: "task", payload: {} },
    });
    expect(code).toBe(0);
    expect(JSON.parse(await request!.text())).toEqual({ followUp: null });
  });

  it("states plainly that a no-op wrote no event", async () => {
    const { code, stdout } = await run(["task", "update", "task-52ff10", "--watcher", "loop-4c1d77"], {
      changed: false, event: null, diff: {},
      task: { id: "task-52ff10", kind: "task", watcher: "loop-4c1d77", payload: {} },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: updated task-52ff10 (no change)");
    expect(stdout).toContain("changed[0]: —\n");
    expect(stdout).toContain("event: — (no event written for an empty diff)\n");
  });

  it("splits merged from deleted so the null-deletes rule is visible where it fires", async () => {
    const { stdout, request } = await run(["task", "update", "task-52ff10", "--payload-merge", '{"merged_at":"2026-08-02","draft":null}'], {
      changed: true, event: "ev-6b30a9", diff: { payload: { old: {}, new: {} } },
      task: { id: "task-52ff10", kind: "task", payload: { pr: 201, merged_at: "2026-08-02" } },
    });
    expect(JSON.parse(await request!.text())).toEqual({ payloadMerge: { merged_at: "2026-08-02", draft: null } });
    expect(stdout).toContain("merged[1]: merged_at\n");
    expect(stdout).toContain("deleted[1]: draft\n");
  });

  it("refuses a --payload-merge that is not one JSON object", async () => {
    const { code, stdout } = await run(["task", "update", "task-52ff10", "--payload-merge", "merged_at=2026-08-02"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "--payload-merge is not a JSON object"');
    expect(stdout).toContain("`null` value deletes a key");
  });

  it("refuses an update with no fields rather than sending an empty patch", async () => {
    const { code, stdout } = await run(["task", "update", "task-52ff10"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "task update requires at least one field"');
    expect(stdout).toContain("allowed[6]: --follow-up, --watcher, --parent, --needs-human, --payload-merge, --file");
  });

  it("prints the server's NOT_HUMAN teaching verbatim under its own slug", async () => {
    const { code, stdout } = await run(["task", "update", "task-0b19ac", "--needs-human", "null"], {
      code: "NOT_HUMAN", message: "a run cannot clear or replace a pending question",
      issues: [{ path: "pendingQuestion", message: "only a human may clear it", got: "null" }],
      hint: "a human answers it in the inbox",
    }, 403);
    expect(code).toBe(2);
    expect(stdout).toBe(
      'error: "a run cannot clear or replace a pending question"\n' +
      "code: NOT_HUMAN\n" +
      "wrote:    null\n" +
      "help[1]:\n" +
      "  a human answers it in the inbox\n",
    );
  });
});

describe("task close", () => {
  it("requires the attestation note", async () => {
    const { code, stdout } = await run(["task", "close", "task-7f3a91"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "task close requires --note"');
    expect(stdout).toContain("the only record of why this closed");
  });

  it("renders the attested-close refusal with the question verbatim", async () => {
    const { code, stdout } = await run(["task", "close", "task-0b19ac", "--note", "posted it"], {
      code: "OPEN_QUESTION", message: "task-0b19ac cannot be closed while a question is waiting for a human",
      issues: [{ path: "pendingQuestion", message: "must be empty to close", got: "Post this reply to r/selfhosted?" }],
      hint: "a human answers it in the inbox; after that the task closes normally",
    }, 409);
    expect(code).toBe(2);
    expect(stdout).toContain("code: CONFLICT\n");
    // Verbatim, unquoted: the agent diffs `wrote:` against `expected:` (§3.4).
    expect(stdout).toContain("wrote:    Post this reply to r/selfhosted?\n");
  });

  it("makes a second close a loud no-op at exit 0", async () => {
    const { code, stdout } = await run(["task", "close", "task-7f3a91", "--note", "closing again"], {
      changed: false, event: null, contentDiffers: true, differingFields: ["note"],
      notice: { code: "CLOSE_NOTE_DIFFERS", message: "the submitted note was not recorded; the original closure stands" },
      task: { id: "task-7f3a91", kind: "task", status: "closed", closedAt: "2026-08-02T16:40:03.000Z", payload: {} },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: closed task-7f3a91 (no change: already closed)");
    expect(stdout).toContain("differs[1]: note");
    expect(stdout).toContain("Close is idempotent");
  });
});

describe("S3 kernel loop commands are teaching pointers only", () => {
  const cases: Array<[string, string[], string, number]> = [
    ["evolve", ["loop", "evolve", "loop-8e3311", "--file", "-"], "loopany edit loop-8e3311", 2],
    ["evolve other", ["loop", "evolve", "loop-4c1d77", "--file", "-"], "loopany edit loop-4c1d77", 2],
    ["evolve self", ["loop", "evolve", "self", "--file", "-"], "loopany edit self", 2],
    ["update", ["loop", "update", "loop-8e3311", "--cron", "0 * * * *"], "loopany edit loop-8e3311", 2],
    ["update approved", ["loop", "update", "loop-8e3311", "--approval", "ev-1"], "loopany edit loop-8e3311", 2],
    ["update paused", ["loop", "update", "loop-8e3311", "--cron", "0 * * * *", "--approval", "ev-1"], "owner edits are the schedule/config authority", 2],
    ["create", ["loop", "create", "--file", "-"], "loopany new --json", 2],
    ["create bound", ["loop", "create", "--file", "bound.md"], "installed loopany skill", 2],
    ["create no cadence", ["loop", "create", "--file", "manual.md"], "production flow", 2],
    ["list", ["loop", "list"], "loopany loops", 2],
    ["list filtered", ["loop", "list", "--status", "retired"], "production loops are now the only roster", 2],
    ["list invalid filter", ["loop", "list", "--status", "closed"], "loopany loops", 2],
    ["show", ["loop", "show", "loop-8e3311"], "loopany show loop-8e3311", 2],
    ["show file", ["loop", "show", "loop-8e3311", "--file"], "production loop's full editable envelope", 2],
    ["pause", ["loop", "pause", "loop-8e3311", "--note", "quiet"], '{"enabled":false}', 2],
    ["resume", ["loop", "resume", "loop-8e3311"], '{"enabled":true}', 2],
    ["retire", ["loop", "retire", "loop-8e3311"], "terminal retire state no longer governs", 2],
    ["retire noted", ["loop", "retire", "loop-8e3311", "--note", "done"], "Production loops pause", 2],
    ["retire bare", ["loop", "retire"], "Production loops pause", 2],
    ["pause repeat", ["loop", "pause", "loop-8e3311"], '{"enabled":false}', 2],
    ["resume retired", ["loop", "resume", "loop-8e3311"], '{"enabled":true}', 2],
    ["delete", ["loop", "delete", "loop-8e3311"], "loopany loops", 2],
    ["pause self", ["loop", "pause", "self"], '{"enabled":false}', 2],
    ["retire help", ["loop", "retire", "--help"], "terminal retire state no longer governs", 0],
  ];

  it.each(cases)("%s never reaches the kernel mutation surface", async (_name, argv, hint, exit) => {
    let called = false;
    const { code, stdout } = await run(argv, {}, 200, {
      readStdin: () => "ignored",
      fetchImpl: async () => { called = true; return reply({}); },
    });
    expect(code).toBe(exit);
    expect(called).toBe(false);
    expect(stdout).toContain("code: SURFACE_MOVED");
    expect(stdout).toContain(hint);
  });

  it("carries NO render machinery for the retired loop kind", () => {
    // The `loop *` verbs short-circuit above, so every loop-shaped render branch
    // downstream was unreachable — and unreachable teaching is worse than none:
    // it names commands (`loopany loop pause`, `loop update … --approval`) that
    // answer with a pointer, and facets (cron/timezone/next_fire/workdir) the
    // kernel no longer stores (cv-s5 F1). Deleted; pinned deleted.
    const cli = readFileSync(fileURLToPath(new URL(CLI_SOURCE, import.meta.url)), "utf8");
    for (const dead of ["loopRows", '"task" | "doc" | "loop"', 'kind === "loop"', "loopany loop pause", "loopany loop resume", "--approval ev-"]) {
      expect(cli, dead).not.toContain(dead);
    }
    // The kernel-only 403 slug retired with the code the server can no longer
    // produce, so it degrades to the status-derived FORBIDDEN.
    expect(slugFor("NOT_YOUR_LOOP", 403)).toBe("FORBIDDEN");
    expect(slugFor("NOT_HUMAN", 403)).toBe("NOT_HUMAN");
  });
});

describe("the human commands", () => {
  it("renders the inbox with the question as the title on a question row", async () => {
    const { code, stdout } = await run(["inbox"], {
      counts: { question: 2, total: 2 }, now: "2026-08-03T09:00:00.000Z",
      items: [
        { task: { id: "task-7f3a91", title: "Observe the impact of PR #201", pendingQuestion: "revert or wait?", watcher: "loop-4c1d77", createdAt: "2026-08-01T00:00:00.000Z" }, reasons: ["question"], askedAt: "2026-08-02T14:00:00.000Z" },
        { task: { id: "task-52ff10", title: "Draft the pricing FAQ", pendingQuestion: "ship it or shelve it?", watcher: "loop-8e3311", createdAt: "2026-07-30T09:00:00.000Z" }, reasons: ["question"], askedAt: null },
      ],
    });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "count: 2\n" +
      "inbox[2]{id,title,reason,waiting,watcher}:\n" +
      '  task-7f3a91,"revert or wait?",question,19h,loop-4c1d77\n' +
      '  task-52ff10,"ship it or shelve it?",question,4d,loop-8e3311\n' +
      "help[3]:\n" +
      '  Run `loopany answer <task-id> "…"` to reply — free text; approve/reject plus instructions are all just the answer\n' +
      "  Run `loopany task show <task-id>` to read the full question, its payload and its history\n" +
      "  Answering queues one run for the watching loop — every task has one, so every answer reaches somebody\n",
    );
  });

  it("does not read an empty inbox as a failure", async () => {
    const { code, stdout } = await run(["inbox"], { items: [], counts: { total: 0 } });
    expect(code).toBe(0);
    expect(stdout).toContain("count: 0\ninbox: []\n");
    expect(stdout).toContain("the default mode is zero human involvement, by design");
  });

  it("answers with the wake block — the concrete run a person can follow", async () => {
    const { code, stdout, request } = await run(["answer", "task-7f3a91", "(b) give it one more day"], {
      event: "ev-3a77f2",
      task: { id: "task-7f3a91", kind: "task", title: "Observe", status: "open", pendingQuestion: null },
      run: { id: "run-61b0d4", loopId: "loop-4c1d77", scope: "task:task-7f3a91", reason: "answered", state: "queued", alreadyQueued: false },
    });
    expect(code).toBe(0);
    expect(JSON.parse(await request!.text())).toEqual({ answer: "(b) give it one more day" });
    expect(stdout).toContain("ok: answered task-7f3a91\n");
    expect(stdout).toContain("  question: cleared\n");
    // Reference prefixes are dropped: the scope renders as the bare id.
    expect(stdout).toContain("  scope: task-7f3a91\n");
    expect(stdout).toContain("One run is queued for loop-4c1d77");
    expect(stdout).toContain("Event ev-3a77f2 is the approval key for this task");
  });

  // Every task names a watcher, so a null run means the QUEUE declined — the
  // watching loop is retired, or is not this team's. The render says which, and
  // names the repair, rather than claiming there was no watcher.
  it("says plainly when the watching loop could not take a run", async () => {
    const { stdout } = await run(["answer", "task-52ff10", "drop it"], { event: "ev-1", task: { id: "task-52ff10", kind: "task", status: "open" }, run: null });
    expect(stdout).toContain("wake: — (the watching loop had no run to queue — the answer is on the record)\n");
    expect(stdout).toContain("most likely it is retired, which is terminal");
    expect(stdout).toContain("--watcher <loop-id>");
  });

  it("explains that a second answer joins the queued run rather than stacking", async () => {
    const { stdout } = await run(["answer", "task-0b19ac", "approved"], {
      event: "ev-9c22d0", task: { id: "task-0b19ac", kind: "task", status: "open" },
      run: { id: "run-71c2e5", loopId: "loop-8e3311", scope: "task:task-0b19ac", reason: "answered", state: "queued", alreadyQueued: true },
    });
    expect(stdout).toContain("  run: run-71c2e5 (already queued)\n");
    expect(stdout).toContain("one run, not two");
  });

  it("requires a non-empty answer", async () => {
    const { code, stdout } = await run(["answer", "task-7f3a91", ""], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "answer text is required"');
    expect(stdout).toContain("teaches it nothing");
  });
});

// -------------------------------------------------------- flags, help, unknowns

describe("the flag grammar is local, loud, and never ignored", () => {
  it("pre-computes the substitution for --mine, the flag every other task CLI has", async () => {
    const { code, stdout } = await run(["task", "list", "--mine"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "unknown flag --mine"');
    expect(stdout).toContain("expected: --watcher <loop-id>");
    expect(stdout).toContain("allowed[6]: --open, --closed, --due, --watcher, --creator, --since");
    expect(stdout).toContain("There is no `--mine` and no `self`");
  });

  it("suggests the near miss on an ordinary typo", async () => {
    const { code, stdout } = await run(["task", "update", "task-7f3a91", "--followup", "+3d"], {});
    expect(code).toBe(2);
    expect(stdout).toContain("expected: --follow-up");
  });

  it("refuses contradictory status flags", async () => {
    const { code, stdout } = await run(["task", "list", "--open", "--closed"], {});
    expect(code).toBe(2);
    expect(stdout).toContain("--open and --closed are mutually exclusive");
  });

  it("refuses a signed or prose --since", async () => {
    for (const bad of ["two weeks", "+14d", "-14d", "2w"]) {
      const { code, stdout } = await run(["task", "list", "--closed", "--since", bad], {});
      expect(code, bad).toBe(2);
      expect(stdout).toContain("allowed[2]: <N>d, <N>h");
    }
  });

  it("answers --help locally, with no round trip and before any side effect", async () => {
    let called = false;
    let stdout = "";
    const code = await runKernelCli(["task", "update", "--help"], { server: "https://example.test", token: "dk", env: {}, out: (t) => { stdout += t; }, fetchImpl: async () => { called = true; return reply({}); } });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(stdout).toContain("usage: loopany task update <id-or-key> [flags]\n");
    expect(stdout).toContain("flags:\n");
    expect(stdout).toContain("examples:\n");
    expect(stdout).toContain("only a human clears a pending question");
    // `mirrors` is flagged create-only in the key set, because it is a
    // constructor argument rather than a field an update can rewrite.
    expect(stdout).toContain("see also:\n  task front matter: title, key, parent, follow_up, watcher, needs_human, payload, mirrors (create-only)\n");
  });

  it("refuses an unknown command with the verb list", async () => {
    const { code, stdout } = await run(["task", "reopen", "task-7f3a91"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "unknown command \\"task reopen task-7f3a91\\""');
    expect(stdout).toContain("task close");
  });
});

// ------------------------------------------------------------------- mirrors

/**
 * THE MIRROR VERBS. The CLI's own job here is the flag grammar — an attach with
 * no coords, a detach with no `--from`, a mirror id where an object id belongs —
 * all refused LOCALLY at exit 2 before any side effect. What the server decides
 * (whether the coords fit the kind, whether the object exists) is left to it.
 */
describe("mirror — the pointer verbs", () => {
  const MIRROR = {
    id: "mirror-3f9a21c04b7e", kind: "mirror", externalKind: "github-pr",
    coords: "superdesigndev/loopany-platform#57", note: "seed article PR",
    href: "https://github.com/superdesigndev/loopany-platform/pull/57",
    attachedTo: ["task-7f3a91"], createdAt: "", updatedAt: "",
  };

  it("attaches with the flags, and posts the object id in the body", async () => {
    const { code, stdout, request } = await run(
      ["mirror", "attach", "task-7f3a91", "--kind", "github-pr", "--coords", "superdesigndev/loopany-platform#57", "--note", "seed article PR"],
      { attached: true, created: true, mirror: MIRROR, object: "task-7f3a91", event: "ev-1" },
      201,
    );
    expect(code).toBe(0);
    expect(request!.method).toBe("POST");
    expect(new URL(request!.url).pathname).toBe("/api/mirrors");
    await expect(request!.json()).resolves.toEqual({ objectId: "task-7f3a91", kind: "github-pr", coords: "superdesigndev/loopany-platform#57", note: "seed article PR" });
    expect(stdout).toContain("ok: attached mirror-3f9a21c04b7e to task-7f3a91");
    expect(stdout).toContain("coords: superdesigndev/loopany-platform#57");
    // THE LAW, on every mirror surface — not only when something goes wrong.
    expect(stdout).toContain("A mirror tells you WHERE to look, never WHAT state it is in");
  });

  it("says when an EXISTING mirror was shared rather than a twin minted", async () => {
    const { stdout } = await run(
      ["mirror", "attach", "task-other", "--kind", "github-pr", "--coords", "o/r#57"],
      { attached: true, created: false, changed: true, mirror: { ...MIRROR, attachedTo: ["task-7f3a91", "task-other"] }, object: "task-other", event: "ev-2" },
    );
    expect(stdout).toContain("(existing mirror, now shared)");
    expect(stdout).toContain("One external thing is one mirror");
  });

  it("refuses an attach with no --kind or no --coords, locally, before any request", async () => {
    for (const argv of [
      ["mirror", "attach", "task-7f3a91", "--kind", "github-pr"],
      ["mirror", "attach", "task-7f3a91", "--coords", "o/r#1"],
      ["mirror", "attach", "--kind", "github-pr", "--coords", "o/r#1"],
    ]) {
      let called = false;
      const { code } = await run(argv, {}, 200, { fetchImpl: async () => { called = true; return reply({}); } });
      expect(code, argv.join(" ")).toBe(2);
      expect(called, argv.join(" ")).toBe(false);
    }
  });

  it("detaches by mirror id, and requires --from rather than guessing", async () => {
    const { code, request, stdout } = await run(
      ["mirror", "detach", "mirror-3f9a21c04b7e", "--from", "task-7f3a91"],
      { detached: true, changed: true, mirror: { ...MIRROR, attachedTo: [] }, object: "task-7f3a91", event: "ev-3", orphaned: true },
    );
    expect(code).toBe(0);
    expect(new URL(request!.url).pathname).toBe("/api/mirrors/mirror-3f9a21c04b7e/detach");
    await expect(request!.json()).resolves.toEqual({ from: "task-7f3a91" });
    expect(stdout).toContain("Nothing depends on");

    const missing = await run(["mirror", "detach", "mirror-3f9a21c04b7e"], {});
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("--from");
  });

  it("refuses an object id where a mirror id belongs, with the kind prefix as the teaching", async () => {
    const { code, stdout } = await run(["mirror", "detach", "task-7f3a91", "--from", "task-7f3a91"], {});
    expect(code).toBe(2);
    expect(stdout).toContain("wrote:    task-7f3a91");
    expect(stdout).toContain("expected: mirror-3f9a21c04b7e");
  });

  it("lists with the three filters, and echoes them when the result is empty", async () => {
    const { request } = await run(["mirror", "list", "--attached-to", "task-7f3a91", "--kind", "github-pr", "--coords-like", "o/r"], { mirrors: [MIRROR], total: 1 });
    const url = new URL(request!.url);
    expect(url.pathname).toBe("/api/mirrors");
    expect(url.searchParams.get("attached-to")).toBe("task-7f3a91");
    expect(url.searchParams.get("kind")).toBe("github-pr");
    expect(url.searchParams.get("coords-like")).toBe("o/r");

    const empty = await run(["mirror", "list", "--kind", "github-pr"], { mirrors: [], total: 0 });
    expect(empty.stdout).toContain("count: 0");
    expect(empty.stdout).toContain("filter: \"--kind github-pr\"");
  });

  it("prints the kinds in use with counts, and the canonical ones alongside", async () => {
    const { stdout } = await run(["mirror", "kinds"], {
      kinds: [{ kind: "github-pr", count: 3, known: true }, { kind: "jira-ticket", count: 1, known: false }],
      canonical: [{ kind: "github-pr", what: "a pull request", coords: "owner/repo#57" }],
    });
    expect(stdout).toContain("in_use[2]{kind,count,known}:");
    expect(stdout).toContain("github-pr,3,yes");
    expect(stdout).toContain("jira-ticket,1,no");
    expect(stdout).toContain("this team's own vocabulary");
  });

  it("updates only the note, and refuses an update with none", async () => {
    const { request } = await run(["mirror", "update", "mirror-3f9a21c04b7e", "--note", "the fix PR"], { changed: true, mirror: MIRROR, event: "ev-4", diff: {} });
    expect(request!.method).toBe("PATCH");
    await expect(request!.json()).resolves.toEqual({ note: "the fix PR" });

    const bare = await run(["mirror", "update", "mirror-3f9a21c04b7e"], {});
    expect(bare.code).toBe(2);
    expect(bare.stdout).toContain("the external thing's identity");
  });

  /** The refusals an agent trained on any other CLI walks into, and each teaches
   *  the PROPERTY rather than the spelling. */
  it("teaches the model on `mirror create`, `mirror delete` and `mirror sync`", async () => {
    const create = await run(["mirror", "create", "--kind", "github-pr"], {});
    expect(create.code).toBe(2);
    expect(create.stdout).toContain("expected: loopany mirror attach <object-id>");
    expect(create.stdout).toContain("born attached");

    const remove = await run(["mirror", "delete", "mirror-1"], {});
    expect(remove.stdout).toContain("expected: loopany mirror detach <mirror-id> --from <object-id>");

    // The most important one: there is nothing to sync, because a mirror never
    // held external state and therefore can never be stale.
    const sync = await run(["mirror", "sync", "mirror-1"], {});
    expect(sync.code).toBe(2);
    expect(sync.stdout).toContain("There is nothing to sync");
  });

  it("prints the mirrors attached to an object on `task show`", async () => {
    const { stdout } = await run(["task", "show", "task-7f3a91"], {
      task: { id: "task-7f3a91", kind: "task", title: "Watch the PR", status: "open" },
      events: [],
      mirrors: [MIRROR],
    });
    expect(stdout).toContain("mirrors[1]{id,kind,coords,note}:");
    expect(stdout).toContain("mirror-3f9a21c04b7e,github-pr,superdesigndev/loopany-platform#57,\"seed article PR\"");
  });

  it("prints no mirrors block at all against a server that does not send one", async () => {
    const { stdout } = await run(["task", "show", "task-7f3a91"], { task: { id: "task-7f3a91", kind: "task" }, events: [] });
    expect(stdout).not.toContain("mirrors");
  });
});

// ------------------------------------------------------------- task tell

/**
 * THE DIRECTIVE VERB. A distinct verb from `answer` on purpose: the inbox is the
 * loop asking you, `tell` is you speaking first, and collapsing them would make
 * the two conversations indistinguishable in a transcript.
 */
describe("task tell — the human speaking first", () => {
  const RESPONSE = {
    task: { id: "task-7f3a91", kind: "task", title: "Seed article bet", status: "open" },
    event: "ev-9c22d1", directive: "Drop this bet — close the PR, then close the task.",
    run: { id: "run-4c1d77", state: "queued", loopId: "loop-8e3311", scope: "task:task-7f3a91", reason: "directive", alreadyQueued: false },
  };

  it("posts the directive and reports the run it woke", async () => {
    const { code, stdout, request } = await run(["task", "tell", "task-7f3a91", "Drop this bet — close the PR, then close the task."], RESPONSE);
    expect(code).toBe(0);
    expect(request!.method).toBe("POST");
    expect(new URL(request!.url).pathname).toBe("/api/tasks/task-7f3a91/directive");
    await expect(request!.json()).resolves.toEqual({ directive: "Drop this bet — close the PR, then close the task." });
    expect(stdout).toContain("ok: told task-7f3a91");
    expect(stdout).toContain("run: run-4c1d77");
    // The ordering rule is the part a person cannot infer from a run id.
    expect(stdout).toContain("acts on the INTENT against external reality first");
  });

  it("is a HUMAN verb, so the machine credential never rides along", async () => {
    const { request } = await run(["task", "tell", "task-7f3a91", "Ship it."], RESPONSE);
    expect(request!.headers.get("authorization")).toBeNull();
  });

  it("says the directive is not lost when the loop already had a run queued", async () => {
    const { stdout } = await run(["task", "tell", "task-7f3a91", "Ship it."], { ...RESPONSE, run: { ...RESPONSE.run, alreadyQueued: true } });
    expect(stdout).toContain("already queued");
    expect(stdout).toContain("reads this task's timeline when it claims");
  });

  it("refuses a missing id or missing text locally, before any request", async () => {
    for (const argv of [["task", "tell"], ["task", "tell", "task-7f3a91"], ["task", "tell", "task-7f3a91", "   "]]) {
      let called = false;
      const { code } = await run(argv, {}, 200, { fetchImpl: async () => { called = true; return reply({}); } });
      expect(code, argv.join(" ")).toBe(2);
      expect(called, argv.join(" ")).toBe(false);
    }
  });

  it("renders the server's refusal verbatim when a question is already pending", async () => {
    const { code, stdout } = await run(["task", "tell", "task-7f3a91", "Ship it."], {
      code: "OPEN_QUESTION", message: "task-7f3a91 is already waiting on you for an answer",
      issues: [{ path: "pendingQuestion", got: "Revert or wait?" }],
      hint: 'answer it instead — `loopany answer task-7f3a91 "…"` records your reply AND wakes the watcher',
    }, 409);
    expect(code).toBe(2);
    expect(stdout).toContain("code: CONFLICT");
    expect(stdout).toContain("loopany answer task-7f3a91");
  });
});
