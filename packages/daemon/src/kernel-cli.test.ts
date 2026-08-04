import { describe, expect, it } from "vitest";

import { runKernelCli, type KernelCliDeps } from "./kernel-cli.js";
import { classify } from "./route.js";

const NOW = Date.parse("2026-08-03T09:00:00.000Z");

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
    const { code, stdout } = await run(["task", "list", "--open", "--unwatched"], {
      total: 2, viewerLoop: "loop-4c1d77",
      tasks: [
        { id: "task-52ff10", title: "Observe the impact of PR #201", followUpAt: null, watcher: null, pendingQuestion: null },
        { id: "task-9a1c03", title: "Verify the docs sweep landed", followUpAt: "2026-08-06T09:00:00.000Z", watcher: null, pendingQuestion: null },
      ],
    });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "count: 2\n" +
      "tasks[2]{id,title,follow_up,watcher,question}:\n" +
      '  task-52ff10,"Observe the impact of PR #201",—,—,—\n' +
      '  task-9a1c03,"Verify the docs sweep landed","2026-08-06T09:00:00.000Z",—,—\n' +
      "help[3]:\n" +
      "  Run `loopany task show <id>` to read one, with its payload and event tail\n" +
      "  Run `loopany task update <id> --watcher loop-4c1d77 --follow-up +3d` to adopt one\n" +
      "  Run `loopany task list --watcher loop-4c1d77 --due` for the work you already own\n",
    );
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
      "  Run `loopany task list --open --unwatched` to see the unclaimed pool\n" +
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
  it("prints the handle first and the consequence of every default it took", async () => {
    const { code, stdout, request } = await run(["task", "create", "--file", "-"], {
      created: true, event: "ev-1",
      task: { id: "task-7f3a91", kind: "task", title: "Observe the impact of PR #201", status: "open", followUpAt: null, watcher: null, pendingQuestion: null, key: "pr-201-impact", createdByLoop: "loop-2d7e55", payload: {} },
    }, 201, { readStdin: () => "---\ntitle: Observe the impact of PR #201\nkey: pr-201-impact\n---\n\nbody\n" });
    expect(code).toBe(0);
    expect(request!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(stdout.startsWith("ok: created task-7f3a91\n")).toBe(true);
    expect(stdout).toContain("  watcher: — (unclaimed pool)\n");
    expect(stdout).toContain("Unwatched with no follow_up: the inbox orphan floor surfaces it to a human after 48h");
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

describe("task update", () => {
  it("echoes the field-level diff the events table stores", async () => {
    const { code, stdout } = await run(["task", "update", "task-52ff10", "--watcher", "loop-4c1d77", "--follow-up", "+3d"], {
      changed: true, event: "ev-6b30a8",
      diff: { watcher: { old: null, new: "loop-4c1d77" }, followUpAt: { old: null, new: "2026-08-06T09:00:00.000Z" } },
      task: { id: "task-52ff10", kind: "task", title: "Observe", status: "open", followUpAt: "2026-08-06T09:00:00.000Z", watcher: "loop-4c1d77", pendingQuestion: null, key: null, payload: {} },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: updated task-52ff10\n");
    expect(stdout).toContain("changed[2]:\n  watcher: — → loop-4c1d77\n");
    expect(stdout).toContain("event: ev-6b30a8\n");
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
    expect(stdout).toContain("allowed[5]: --follow-up, --watcher, --needs-human, --payload-merge, --file");
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

describe("loop evolve and loop update", () => {
  it("names the free-zone/keyed-zone boundary at the moment the agent rewrites itself", async () => {
    const { code, stdout } = await run(["loop", "evolve", "loop-8e3311", "--file", "-"], {
      changed: true, event: "ev-9d2c11", diff: { body: { old: "a\n", new: "a\nb\n" } },
      loop: { id: "loop-8e3311", kind: "loop", title: "Reddit Outreach", body: "a\nb\n" },
    }, 200, { readStdin: () => "---\ntitle: Reddit Outreach\n---\n\ncharter\n" });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: evolved loop-8e3311\n");
    expect(stdout).toContain("changed[1]:\n  body: +1 lines, -0 lines\n");
    expect(stdout).toContain("Cadence, retirement and creating other loops are governance");
  });

  it("turns NOT_YOUR_LOOP into a one-substitution fix", async () => {
    const { code, stdout } = await run(["loop", "evolve", "loop-4c1d77", "--file", "-"], {
      code: "NOT_YOUR_LOOP", message: "run-3f8a20 belongs to loop-8e3311 and may not write loop-4c1d77",
      issues: [{ path: "id", message: "must be the run's own loop", got: "loop-4c1d77", expected: "loop-8e3311" }],
      hint: "a run evolves and governs only its own loop",
    }, 403, { readStdin: () => "---\ntitle: x\n---\n\nbody\n" });
    expect(code).toBe(2);
    expect(stdout).toContain("code: NOT_YOUR_LOOP\n");
    expect(stdout).toContain("wrote:    loop-4c1d77\n");
    expect(stdout).toContain("expected: loop-8e3311\n");
  });

  it("refuses `self` locally, before any round trip", async () => {
    let called = false;
    const { code, stdout } = await run(["loop", "evolve", "self", "--file", "-"], {}, 200, { fetchImpl: async () => { called = true; return reply({}); } });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(stdout).toContain("There is no `self` keyword");
  });

  it("prints the whole governance protocol when the approval key is missing", async () => {
    const { code, stdout } = await run(["loop", "update", "loop-8e3311", "--cron", "0 * * * *"], {});
    expect(code).toBe(2);
    expect(stdout).toContain("code: FORBIDDEN\n");
    expect(stdout).toContain("help[4]:");
    expect(stdout).toContain("Step 1: `loopany task create");
    expect(stdout).toContain("--watcher loop-8e3311");
  });

  it("prints the three-link audit chain at the moment it is forged", async () => {
    const { code, stdout } = await run(["loop", "update", "loop-8e3311", "--cron", "0 * * * *", "--approval", "ev-9c22d1"], {
      changed: true, event: "ev-a41f80", diff: { cron: { old: "0 9 * * 1", new: "0 * * * *" } },
      loop: { id: "loop-8e3311", kind: "loop", title: "Reddit Outreach", cron: "0 * * * *", status: "active", nextFire: "2026-08-03T15:00:00.000Z" },
      approval: { event: "ev-9c22d1", entrance: "human", actor: "u-2b91", task: "task-0b19ac", ts: "2026-08-03T11:42:08.000Z" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("approval:\n  key: ev-9c22d1\n  entrance: human\n");
    expect(stdout).toContain("  task: task-0b19ac\n");
    expect(stdout).toContain('Run `loopany task close task-0b19ac --note "cadence applied"`');
    expect(stdout).toContain("one queued run per loop");
  });

  it("carries the auto-pause warning through as a success, not a refusal", async () => {
    const { code, stdout } = await run(["loop", "update", "loop-8e3311", "--cron", "0 * * * *", "--approval", "ev-9c22d1"], {
      changed: true, event: "ev-a41f81", diff: { cron: { old: "0 9 * * 1", new: "0 * * * *" } },
      loop: { id: "loop-8e3311", kind: "loop", cron: "0 * * * *", status: "paused", nextFire: null },
      approval: { event: "ev-9c22d1", entrance: "human", task: "task-0b19ac" },
      notice: { code: "LOOP_STILL_PAUSED", message: "the cadence changed but the loop remains paused" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("  next_fire: — (paused)\n");
    expect(stdout).toContain("warning: ");
    expect(stdout).toContain("Time never un-pauses a loop — a human does");
  });
});

describe("loop create, list and show", () => {
  const CHARTER = '---\ntitle: Housekeeper\ncron: "0 7 * * *"\nkey: housekeeper\n---\n\nYou are the Housekeeper.\n';
  const LOOP = { id: "loop-8e3311", kind: "loop", title: "Housekeeper", status: "active", cron: "0 7 * * *", timezone: null, key: "housekeeper", nextFire: "2026-08-04T07:00:00.000Z", body: "You are the Housekeeper.\n" };

  it("posts the artifact to the loop collection and never carries the machine's credential", async () => {
    // Creating a loop is the OWNER's act, so it is a human verb: a device token
    // here would name the wrong actor on the object-created event.
    const { code, stdout, request } = await run(["loop", "create", "--file", "-"], { created: true, loop: LOOP, event: "ev-1" }, 201, { readStdin: () => CHARTER });
    expect(code).toBe(0);
    expect(request!.method).toBe("POST");
    expect(new URL(request!.url).pathname).toBe("/api/loops");
    expect(request!.headers.get("authorization")).toBeNull();
    expect(await request!.text()).toBe(CHARTER);
    expect(stdout).toContain("ok: created loop-8e3311\n");
    expect(stdout).toContain('  next_fire: "2026-08-04T07:00:00.000Z"\n');
    expect(stdout).toContain("claimed by any machine of this team — there is no machine to bind");
  });

  it("says plainly that a loop born without a cadence will never fire on its own", async () => {
    const { stdout } = await run(["loop", "create", "--file", "-"], { created: true, loop: { ...LOOP, cron: null, nextFire: null }, event: "ev-1" }, 201, { readStdin: () => CHARTER });
    expect(stdout).toContain("  next_fire: — (no cadence — runs on demand only)\n");
    expect(stdout).toContain("will never fire on its own");
  });

  it("renders the roster with the cadence cursor as a column", async () => {
    const { code, stdout, request } = await run(["loop", "list"], {
      total: 2,
      loops: [
        { id: "loop-8e3311", title: "Housekeeper", status: "active", cron: "0 7 * * *", nextFire: "2026-08-04T07:00:00.000Z" },
        { id: "loop-4c1d77", title: "Reddit Outreach", status: "retired", cron: null, nextFire: null },
      ],
    });
    expect(code).toBe(0);
    expect(new URL(request!.url).search).toBe("");
    expect(stdout).toBe(
      "count: 2\n" +
      "loops[2]{id,title,status,cron,next_fire}:\n" +
      '  loop-8e3311,Housekeeper,active,"0 7 * * *","2026-08-04T07:00:00.000Z"\n' +
      '  loop-4c1d77,"Reddit Outreach",retired,—,—\n' +
      "help[3]:\n" +
      "  Run `loopany loop show <loop-id>` to read one, with its charter and event tail\n" +
      "  A blank next_fire means the loop is paused, retired, or has no cadence — `loop show` names which\n" +
      "  Retired loops stay listed on purpose: the kernel is event-sourced, so nothing is ever deleted\n",
    );
  });

  it("passes --status through and echoes the filter when it matched nothing", async () => {
    const { stdout, request } = await run(["loop", "list", "--status", "retired"], { total: 0, loops: [] });
    expect(new URL(request!.url).search).toBe("?status=retired");
    expect(stdout).toContain("count: 0\nloops: []\n");
    expect(stdout).toContain('filter: "--status retired"\n');
    expect(stdout).toContain("An empty roster is a clean result, not an error");
  });

  it("refuses a status a loop cannot hold, locally and before any round trip", async () => {
    let called = false;
    const { code, stdout } = await run(["loop", "list", "--status", "closed"], {}, 200, { fetchImpl: async () => { called = true; return reply({}); } });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(stdout).toContain("allowed[3]: active, paused, retired");
    expect(stdout).toContain("it never closes, because it is a standing cadence and not a unit of work");
  });

  it("shows the charter and the seq-ordered timeline, and names the next legal move", async () => {
    const { code, stdout } = await run(["loop", "show", "loop-8e3311"], {
      loop: LOOP,
      events: [
        { seq: 1, ts: "2026-08-01T00:00:00.000Z", actor: "u-owner", entrance: "human", kind: "object-created" },
        { seq: 4, ts: "2026-08-02T09:00:00.000Z", actor: "run-3f8a20", entrance: "agent", kind: "charter-evolved", diff: { body: { old: "a", new: "b" } } },
      ],
    });
    expect(code).toBe(0);
    expect(stdout).toContain("loop:\n  id: loop-8e3311\n");
    expect(stdout).toContain(String.raw`charter: "You are the Housekeeper.\\n"` + "\n");
    expect(stdout).toContain("events[2]{seq,ts,actor,entrance,change}:\n");
    expect(stdout).toContain("Run `loopany loop evolve loop-8e3311 --file charter.md` to apply it");
  });

  it("emits the raw artifact under --file, with no ok: line to corrupt it", async () => {
    let stdout = "";
    const code = await runKernelCli(["loop", "show", "loop-8e3311", "--file"], {
      server: "https://example.test", token: "dk_test", env: {}, out: (t) => { stdout += t; },
      fetchImpl: async (input, init) => {
        expect(new Request(input, init).headers.get("accept")).toBe("text/markdown");
        return reply(CHARTER, 200, "text/markdown");
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe(CHARTER);
  });
});

describe("the loop lifecycle: pause, resume and retire — there is no delete", () => {
  const LOOP = { id: "loop-8e3311", kind: "loop", title: "Housekeeper", cron: "0 7 * * *" };

  it("pauses on the owner's credential, carries the note, and says what disarming means", async () => {
    const { code, stdout, request } = await run(["loop", "pause", "loop-8e3311", "--note", "muted for the migration"], {
      changed: true, event: "ev-77a1", diff: { status: { old: "active", new: "paused" }, nextFire: { old: "2026-08-04T07:00:00.000Z", new: null } },
      loop: { ...LOOP, status: "paused", nextFire: null },
    });
    expect(code).toBe(0);
    expect(new URL(request!.url).pathname).toBe("/api/loops/loop-8e3311/pause");
    expect(request!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(await request!.text())).toEqual({ note: "muted for the migration" });
    expect(stdout).toContain("ok: paused loop-8e3311\n");
    expect(stdout).toContain("  next_fire: — (paused)\n");
    expect(stdout).toContain("  status: active → paused\n");
    expect(stdout).toContain("event: ev-77a1\n");
    expect(stdout).toContain("Time never un-pauses a loop");
  });

  it("resumes with one fire owed, not a backlog", async () => {
    const { code, stdout, request } = await run(["loop", "resume", "loop-8e3311"], {
      changed: true, event: "ev-77a2", diff: { status: { old: "paused", new: "active" } },
      loop: { ...LOOP, status: "active", nextFire: "2026-08-20T07:00:00.000Z" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(await request!.text())).toEqual({});
    expect(stdout).toContain("ok: resumed loop-8e3311\n");
    expect(stdout).toContain("a week paused owes exactly one fire, not a week of them");
  });

  it("names retire as the delete, and the freeze it forces", async () => {
    const { code, stdout, request } = await run(["loop", "retire", "loop-8e3311", "--note", "the experiment is over"], {
      changed: true, event: "ev-77a3", diff: { status: { old: "active", new: "retired" } },
      loop: { ...LOOP, status: "retired", nextFire: null },
    });
    expect(code).toBe(0);
    expect(new URL(request!.url).pathname).toBe("/api/loops/loop-8e3311/retire");
    expect(stdout).toContain("ok: retired loop-8e3311\n");
    expect(stdout).toContain("  next_fire: — (retired — terminal)\n");
    expect(stdout).toContain("the kernel is event-sourced, so nothing is erased and there is no un-retire");
    expect(stdout).toContain("`loop evolve` and `loop update` are refused for this loop for good");
  });

  it("reads a repeated verb as the free retry it is", async () => {
    const { code, stdout } = await run(["loop", "pause", "loop-8e3311"], { changed: false, event: null, diff: {}, loop: { ...LOOP, status: "paused", nextFire: null } });
    expect(code).toBe(0);
    expect(stdout).toContain("ok: paused loop-8e3311 (no change: already paused)\n");
    expect(stdout).toContain("event: — (no event written for an empty diff)\n");
    expect(stdout).toContain("a retry after a dropped connection costs nothing");
  });

  it("renders the terminal refusal when a retired loop is asked to come back", async () => {
    const { code, stdout } = await run(["loop", "resume", "loop-8e3311"], {
      code: "RETIRED", message: "loop-8e3311 is retired and cannot be resumed",
      issues: [{ path: "status", message: "retirement is terminal", got: "retired", expected: "active|paused" }],
      hint: "there is no un-retire: the charter is frozen and the cadence is gone for good",
    }, 409);
    expect(code).toBe(2);
    expect(stdout).toContain("code: CONFLICT\n");
    expect(stdout).toContain("wrote:    retired\n");
    expect(stdout).toContain("expected: active|paused\n");
    expect(stdout).toContain("there is no un-retire");
  });

  it("teaches the property, not the spelling, when an agent reaches for `loop delete`", async () => {
    for (const wrong of [["loop", "delete", "loop-8e3311"], ["loop", "remove", "loop-8e3311"], ["loop", "rm", "loop-8e3311"], ["loop", "archive", "loop-8e3311"]]) {
      let called = false;
      const { code, stdout } = await run(wrong, {}, 200, { fetchImpl: async () => { called = true; return reply({}); } });
      expect(code, wrong.join(" ")).toBe(2);
      expect(called).toBe(false);
      expect(stdout).toContain("expected: loopany loop retire <loop-id>");
      expect(stdout).toContain("the kernel is event-sourced, so nothing is ever erased");
      expect(stdout).toContain("`loop retire` IS the D in CRUD");
    }
  });

  it("refuses a missing or non-prefixed loop id locally", async () => {
    const missing = await run(["loop", "retire"], {});
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("expected: loopany loop retire <loop-id>");
    const bare = await run(["loop", "pause", "self"], {});
    expect(bare.code).toBe(2);
    expect(bare.stdout).toContain("There is no `self` keyword");
  });

  it("answers `loop retire --help` locally, naming retire as the D in CRUD", async () => {
    let called = false;
    let stdout = "";
    const code = await runKernelCli(["loop", "retire", "--help"], { server: "https://example.test", token: "dk", env: {}, out: (t) => { stdout += t; }, fetchImpl: async () => { called = true; return reply({}); } });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(stdout).toContain("usage: loopany loop retire <loop-id> [--note <text>]\n");
    expect(stdout).toContain("retire IS the delete");
    expect(stdout).toContain("there is no `loop delete`");
  });
});

describe("the human commands", () => {
  it("renders the inbox with the question as the title on a question row", async () => {
    const { code, stdout } = await run(["inbox"], {
      counts: { question: 1, dueUnwatched: 0, orphan: 1, total: 2 }, now: "2026-08-03T09:00:00.000Z",
      items: [
        { task: { id: "task-7f3a91", title: "Observe the impact of PR #201", pendingQuestion: "revert or wait?", watcher: "loop-4c1d77", createdAt: "2026-08-01T00:00:00.000Z" }, reasons: ["question"], askedAt: "2026-08-02T14:00:00.000Z" },
        { task: { id: "task-52ff10", title: "Draft the pricing FAQ", pendingQuestion: null, watcher: null, createdAt: "2026-07-30T09:00:00.000Z" }, reasons: ["orphan"], askedAt: null },
      ],
    });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "count: 2\n" +
      "inbox[2]{id,title,reason,waiting,watcher}:\n" +
      '  task-7f3a91,"revert or wait?",question,19h,loop-4c1d77\n' +
      '  task-52ff10,"Draft the pricing FAQ",orphan,4d,—\n' +
      "help[3]:\n" +
      '  Run `loopany answer <task-id> "…"` to reply — free text; approve/reject plus instructions are all just the answer\n' +
      "  Run `loopany task show <task-id>` to read the full question, its payload and its history\n" +
      "  Rows with a watcher queue one run for that loop the moment you answer; rows without one just record the answer\n",
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

  it("says plainly that a watcher-less answer wakes nothing", async () => {
    const { stdout } = await run(["answer", "task-52ff10", "drop it"], { event: "ev-1", task: { id: "task-52ff10", kind: "task", status: "open" }, run: null });
    expect(stdout).toContain("wake: — (no watcher — the answer sits on the record)\n");
    expect(stdout).toContain("Nothing is queued");
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
    expect(stdout).toContain("allowed[7]: --open, --closed, --due, --unwatched, --watcher, --creator, --since");
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
    expect(stdout).toContain("usage: loopany task update <id> [flags]\n");
    expect(stdout).toContain("flags:\n");
    expect(stdout).toContain("examples:\n");
    expect(stdout).toContain("only a human clears a pending question");
    expect(stdout).toContain("see also:\n  task front matter: title, key, follow_up, watcher, needs_human, payload\n");
  });

  it("refuses an unknown command with the verb list", async () => {
    const { code, stdout } = await run(["task", "reopen", "task-7f3a91"], {});
    expect(code).toBe(2);
    expect(stdout).toContain('error: "unknown command \\"task reopen task-7f3a91\\""');
    expect(stdout).toContain("task close");
  });
});
