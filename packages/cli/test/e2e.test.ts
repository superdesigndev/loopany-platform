/**
 * M2 acceptance — the local read/write loop end to end against a REAL temp
 * `.loopany/` workspace (no mocks, no process spawn: we drive the pure
 * `run(argv, deps)` and let the file driver hit the disk).
 *
 * The flow mirrors how work is really born and shepherded (§5, §6):
 *   init → create a tree → add a mirror + a shepherd task that tracks it →
 *   inbox surfaces the pending decision → update advances status (and the
 *   symmetric re-arm fires loudly) → show --log shows the FULL event stream →
 *   list renders the tree with the loop / due / shepherd markers.
 *
 * `now` is fixed so the assertions are deterministic; `cwd` is the temp dir so
 * `findWorkspace` walks up to the `.loopany/` we init.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  run,
  runCommand,
  requireWorkspace,
  DriverError,
  type CliDeps,
  type CliOutcome,
} from "../src/index.js";

const T0 = Date.parse("2026-08-09T12:00:00.000Z");

describe("M2 local read/write loop (temp-dir E2E)", () => {
  let dir: string;
  let tick: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-cli-e2e-"));
    tick = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A monotonically advancing clock — each command lands at a distinct instant,
  // as it would in real use. A frozen clock would make two dispatches at the
  // same second collide on the deterministic run id (uniqueness IS the dispatch
  // dedup), which is correct kernel behavior but a test-only artifact.
  const now = (): string => new Date(T0 + tick++ * 1000).toISOString();

  const deps = (over?: Partial<CliDeps>): CliDeps => ({
    cwd: dir,
    now: now(),
    env: {},
    // Isolate the workspace registry + PATH probe so `init` never writes the real
    // ~/.loopany or seeds from the host's installed agents (test hazard).
    registryHome: dir,
    probe: () => false,
    ...over,
  });

  // A human provenance for the driver-level runCommand cases below.
  const actor = () => ({ entrance: "human" as const, actorId: "cli" });

  /** Run a verb and fail LOUDLY (with stderr) on a non-zero exit — a silent
   *  failure inside a multi-step flow is the worst thing to debug. */
  const call = (argv: string[], over?: Partial<CliDeps>): CliOutcome => {
    const out = run(argv, deps(over));
    if (out.exitCode !== 0) {
      throw new Error(`\`${argv.join(" ")}\` exited ${out.exitCode}: ${out.stderr}`);
    }
    return out;
  };

  it("runs the whole init → shepherd → inbox → update → show → list flow", () => {
    // --- init ---
    const init = call(["init"]);
    expect(init.stdout).toContain("initialized");
    expect(existsSync(join(dir, ".loopany", "config.json"))).toBe(true);
    for (const sub of ["objects", "events", "triggers", "runs"]) {
      expect(existsSync(join(dir, ".loopany", sub))).toBe(true);
    }

    const home = call([]);
    expect(home.stdout).toContain("Loopany Kernel");
    expect(home.stdout).toContain("Recurring agent work that keeps its context and outputs");
    expect(home.stdout).toContain("source: local workspace");
    expect(home.stdout).toContain("tasks: 0");
    expect(home.stdout).toContain("lk --help");
    expect(home.stdout).not.toContain("workspace\n  init");
    const homeJson = JSON.parse(call(["--json"]).stdout);
    expect(homeJson.source.label).toContain("local workspace");
    expect(homeJson.tasks.total).toBe(0);

    // --- create a small tree ---
    const root = call(["create", "Ship the redesign", "--assignee", "claude", "--status", "todo"]);
    expect(root.stdout).toContain("ok ship-the-redesign");
    call(["create", "Wire the header", "--parent", "ship-the-redesign", "--assignee", "claude"]);

    // A recurring loop = a task with a cron trigger (§3). The trigger is
    // persisted by the driver as a real file.
    call(["create", "Nightly audit", "--cron", "0 7 * * *", "--assignee", "claude"]);
    expect(existsSync(join(dir, ".loopany", "triggers", "trg-nightly-audit-cron.json"))).toBe(true);

    // --- mirror + shepherd (§6): a task TRACKS an external-fact pointer, and
    // its verdict lands in a human's inbox. ---
    const mirror = call(["mirror", "add", "github-pr", "acme/web#42", "--json"]);
    const mirrorId = (JSON.parse(mirror.stdout) as { result: { id: string } }).result.id;
    expect(mirrorId).toMatch(/^m-/);

    call([
      "create",
      "Review PR #42",
      "--tracks",
      mirrorId,
      "--assignee",
      "reviewer@acme.dev",
      "--status",
      "todo",
    ]);

    // --- inbox: the human's pending decision is surfaced, and it names the
    // shepherded object. Nothing waits silently (§6). ---
    const inbox = call(["inbox", "--assignee", "reviewer@acme.dev"]);
    expect(inbox.stdout).toContain("review-pr-42");
    expect(inbox.stdout).toContain("assigned");
    // A non-owner's inbox does not see it.
    const otherInbox = call(["inbox", "--assignee", "someone-else@acme.dev"]);
    expect(otherInbox.stdout).toContain("inbox empty");
    // BARE `inbox` derives YOU from git user.email (announced, never a silent
    // guess) — the kernel's human identity IS an email, and git knows yours.
    const bareInbox = call(["inbox"], { gitEmail: () => "reviewer@acme.dev" });
    expect(bareInbox.stdout).toContain("inbox for reviewer@acme.dev");
    expect(bareInbox.stdout).toContain("git user.email");
    expect(bareInbox.stdout).toContain("review-pr-42");
    // No identity from any source: the usage error names all three.
    const noId = run(["inbox"], deps({ gitEmail: () => null }));
    expect(noId.exitCode).not.toBe(0);
    expect(noId.stderr).toContain("git user.email");

    // --- update: a note rides along and provenance is recorded. Advancing the
    // nightly loop to done disarms its cron under invariant ②; reviving it
    // re-arms it (②') with a LOUD notice. ---
    call(["update", "ship-the-redesign", "status=in-progress", "--note", "kicked off the work"]);

    const done = call(["update", "nightly-audit", "status=done", "--note", "goal met tonight"]);
    // The cron is disabled-by-invariant, not deleted (zombie-loop fix).
    const trigAfterDone = JSON.parse(
      readFileSync(join(dir, ".loopany", "triggers", "trg-nightly-audit-cron.json"), "utf8"),
    ) as { enabled: boolean; disabledBy: string };
    expect(trigAfterDone.enabled).toBe(false);
    expect(trigAfterDone.disabledBy).toBe("invariant");
    expect(done.stdout).toContain("ok");

    const revive = call(["update", "nightly-audit", "status=todo"]);
    // ②' re-arm echoes LOUDLY (the notice prefix is »).
    expect(revive.stdout).toContain("»");
    expect(revive.stdout.toLowerCase()).toContain("re-arm");
    const trigAfterRevive = JSON.parse(
      readFileSync(join(dir, ".loopany", "triggers", "trg-nightly-audit-cron.json"), "utf8"),
    ) as { enabled: boolean };
    expect(trigAfterRevive.enabled).toBe(true);

    // --- show --log: the FULL event stream is present (created + the note +
    // the status changes), rendered as compact one-liners. ---
    const show = call(["show", "ship-the-redesign", "--log"]);
    expect(show.stdout).toContain("task ship-the-redesign");
    expect(show.stdout).toContain("[in-progress]");
    expect(show.stdout).toContain("log:");
    expect(show.stdout).toContain("created");
    expect(show.stdout).toContain("kicked off the work");
    expect(show.stdout).toContain("status-changed");
    // The compact event line carries the attributable actor `entrance:actorId`
    // (§3/§7), not just the entrance — the default human actor is "cli".
    expect(show.stdout).toContain("device:shared");

    // Bare Task show carries a bounded meaningful projection by default. Raw
    // mechanics remain behind --log/--all rather than forcing agents to know a
    // protocol-only flag just to understand current context.
    const recentShow = call(["show", "ship-the-redesign"]);
    expect(recentShow.stdout).toContain("recent:");
    expect(recentShow.stdout).toContain("kicked off the work");
    // Creation context remains in recent activity. It is not mislabeled as a
    // handoff unless an assignee-change event supplied a reason.
    expect(recentShow.stdout).not.toContain("handoff:");
    expect(recentShow.stdout).toContain("full history: loopany-kernel show ship-the-redesign --log");
    expect(recentShow.stdout).not.toContain("run-started:");
    const boundedShow = call(["show", "ship-the-redesign", "--limit", "1", "--json"]);
    const boundedJson = JSON.parse(boundedShow.stdout) as { recent: unknown[]; events?: unknown[] };
    expect(boundedJson.recent).toHaveLength(1);
    expect(boundedJson.events).toBeUndefined();

    // The event stream on disk carries every event for the object.
    const events = readFileSync(join(dir, ".loopany", "events", "ship-the-redesign.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; provenance: { entrance: string } });
    expect(events.map((e) => e.kind)).toContain("created");
    expect(events.map((e) => e.kind)).toContain("status-changed");
    // With no configured person or agent, provenance is honestly device:shared.
    expect(events.every((e) => e.provenance.entrance === "device")).toBe(true);

    // --- list: no filter renders the tree with plain-text markers. The
    // nightly loop node carries the [loop] tag + humanized cadence; the child
    // is nested under its parent behind a tree guide. ---
    const list = call(["list"]);
    expect(list.stdout).toContain("ship-the-redesign");
    expect(list.stdout).toContain("wire-the-header");
    expect(list.stdout).toContain("nightly-audit");
    expect(list.stdout).toContain("[loop]"); // the cron loop tag (no icons)
    expect(list.stdout).toContain("daily 07:00"); // humanized cadence (kernel cronText)
    const loopContext = call(["show", "nightly-audit"]);
    expect(loopContext.stdout).toContain("trigger cron:");
    expect(loopContext.stdout).toContain("next=");
    const decisionContext = call(["show", "review-pr-42"]);
    expect(decisionContext.stdout).toContain("human decision:");
    expect(decisionContext.stdout).toContain("waiting on reviewer@acme.dev");
    expect(list.stdout).toContain(`tracks ${mirrorId}`); // the shepherd marker on the review task
    // The child connects below its parent (tree, not flat).
    const parentLine = list.stdout.split("\n").findIndex((l) => l.includes("ship-the-redesign"));
    const childLine = list.stdout.split("\n").findIndex((l) => l.includes("wire-the-header"));
    expect(childLine).toBeGreaterThan(parentLine);
    expect(list.stdout.split("\n")[childLine]).toMatch(/^└─ wire-the-header/);

    // --- a filtered list is flat with breadcrumbs to the root. ---
    const filtered = call(["list", "--assignee", "claude"]);
    expect(filtered.stdout).toContain("wire-the-header");
    expect(filtered.stdout).toContain("(ship-the-redesign"); // breadcrumb
    expect(filtered.stdout).not.toContain("review-pr-42"); // assigned to the human

    // --- search hits titles, ids, and bodies across archetypes. ---
    const search = call(["search", "audit"]);
    expect(search.stdout).toContain("nightly-audit");
  });

  it("renders refusals as error:/code:/hint: text and exits 1", () => {
    call(["init"]);
    const out = run(["update", "does-not-exist", "status=done"], deps());
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error:");
    expect(out.stderr).toContain("code: UNKNOWN_OBJECT");
    expect(out.stdout).toBe("");
  });

  it("returns operational context when an assignee handoff supersedes a pending run", () => {
    call(["init"]);
    const created = call(["create", "Handoff work", "--assignee", "mbp/claude", "--status", "todo"]);
    expect(created.stdout).toContain("run:");
    expect(created.stdout).toContain("created");
    const before = requireWorkspace(dir);
    const firstRun = JSON.parse(
      readFileSync(join(before, "runs", readdirSync(join(before, "runs"))[0]!), "utf8"),
    ) as { id: string };

    const handoff = call(["update", "handoff-work", "assignee=studio/codex", "--json"]);
    const body = JSON.parse(handoff.stdout) as {
      operationalContext: {
        run: { createdId: string; supersededId: string; consequence: string };
        machine: { alias: string; presence: string };
        nextCommand: string | null;
      };
    };
    expect(body.operationalContext.run).toMatchObject({
      supersededId: firstRun.id,
      consequence: "superseded-and-replaced",
    });
    expect(body.operationalContext.run.createdId).toMatch(/^run-/);
    expect(body.operationalContext.machine).toEqual({ alias: "studio", presence: "unavailable" });
    expect(body.operationalContext.nextCommand).toBeNull();
  });

  it("returns compact operational context for note, doc, mirror, and manual run writes", () => {
    call(["init"]);
    call(["create", "Context target", "--assignee", "claude", "--status", "in-progress"]);

    const note = call(["note", "context-target", "ready for dispatch"]);
    expect(note.stdout).toContain("changed: note");

    writeFileSync(join(dir, "context.md"), "# Context\nUseful details.\n");
    const doc = call(["doc", "put", "context", "--file", join(dir, "context.md"), "--task", "context-target"]);
    expect(doc.stdout).toContain("changed: doc");
    expect(doc.stdout).toContain("attached");

    const mirror = call(["mirror", "add", "github-pr", "acme/repo#7", "--task", "context-target"]);
    expect(mirror.stdout).toContain("changed: mirror");
    expect(mirror.stdout).toContain("attached");

    const manual = call(["run", "context-target", "--json"]);
    const body = JSON.parse(manual.stdout) as {
      operationalContext: { changed: string[]; run: { consequence: string } };
    };
    expect(body.operationalContext.changed).toEqual(["manual run"]);
    expect(body.operationalContext.run.consequence).toBe("created");
  });

  it("teaches archived instead of delete (no delete verb)", () => {
    call(["init"]);
    call(["create", "Throwaway"]);
    // There is no `delete` verb — an unknown verb is a usage error (exit 2).
    const out = run(["delete", "throwaway"], deps());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("unknown verb");
  });

  it("a note whose TEXT contains k=v prose (status=done) still lands verbatim", () => {
    // The tokenizer classifies any bare token with "=" as an assign; the note
    // verb rebuilds its free text from the lone assign - without this, everyday
    // prose like "status=done" silently became a usage error (agent trap).
    call(["init"]);
    call(["create", "Prose task"]);
    call(["note", "prose-task", "ended the pass with status=done after the fix"]);
    const events = readFileSync(join(dir, ".loopany", "events", "prose-task.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; note?: string });
    expect(events.find((e) => e.kind === "note")?.note).toBe("ended the pass with status=done after the fix");
  });

  it("show is the Task Detail: products from tracks+refs, children, last run; loops is the Loops projection", () => {
    call(["init"]);
    call(["create", "Seo loop", "--id", "seo", "--cron", "0 7 * * *", "--status", "in-progress", "--assignee", "mbp/claude"]);
    const report = join(dir, "weekly.md");
    writeFileSync(report, "# weekly-report\n");
    call(["doc", "put", "weekly-report", "--file", report, "--task", "seo"]);
    call(["update", "seo", "tracks=weekly-report"]);
    for (let i = 1; i <= 6; i++) call(["doc", "put", `report-${i}`, "--task", "seo"]);
    call(["create", "Child bet", "--id", "bet-child", "--parent", "seo"]);

    const show = call(["show", "seo"]);
    expect(show.stdout).toContain("products (latest 5 of 7; --all for all):");
    expect(show.stdout).toContain("doc weekly-report");
    expect(show.stdout).not.toContain("doc weekly-report  weekly-report");
    expect(show.stdout).not.toContain("doc report-1");
    expect(show.stdout).toContain("doc report-6");
    expect(show.stdout).not.toContain("refs:");
    expect(show.stdout).not.toContain("priority: —");
    expect(show.stdout).not.toContain("parent: —");
    expect(show.stdout).toContain("routing:");
    expect(show.stdout).toContain("loop:");
    expect(show.stdout).toContain("timezone=");
    expect(show.stdout).toContain("next: none - next run scheduled for");
    expect(show.stdout).toContain("children:");
    expect(show.stdout).toContain("bet-child");

    const expanded = call(["show", "seo", "--all"]);
    expect(expanded.stdout).toContain("products:");
    expect(expanded.stdout).toContain("doc report-1");

    const loops = call(["loops"]);
    // Humanized cadence with the raw spec in parens (the edit surface), no icon.
    expect(loops.stdout).toContain("seo  daily 07:00 (0 7 * * *)");
    expect(loops.stdout).toContain("next=");
    expect(loops.stdout).toContain(" local");
    expect(loops.stdout).toContain("agent mbp/claude");
    const json = JSON.parse(call(["loops", "--json"]).stdout) as Array<{ task: { id: string }; blockedNote: unknown }>;
    expect(json[0]!.task.id).toBe("seo");
  });

  it("collection JSON is compact by default and --full restores complete task records", () => {
    call(["init"]);
    const body = "A representative remote-shaped task body.\n".repeat(300);
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, body);
    call(["create", "Large loop", "--id", "large-loop", "--body-file", bodyFile,
      "--cron", "0 7 * * *", "--assignee", "reviewer@example.com"]);

    const cases: Array<{ argv: string[]; taskOf: (value: any) => any }> = [
      { argv: ["list", "--json"], taskOf: (value) => value[0].task },
      { argv: ["loops", "--json"], taskOf: (value) => value[0].task },
      { argv: ["inbox", "--assignee", "reviewer@example.com", "--json"], taskOf: (value) => value.items[0].task },
    ];

    for (const { argv, taskOf } of cases) {
      const compactOutput = call(argv).stdout;
      const compactTask = taskOf(JSON.parse(compactOutput));
      expect(compactTask.body).toBeUndefined();
      expect(compactTask.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
      expect(compactTask.bodyCommand).toBe("loopany-kernel show large-loop --json");

      const fullOutput = call([...argv, "--full"]).stdout;
      const fullTask = taskOf(JSON.parse(fullOutput));
      expect(fullTask.body).toBe(body);
      expect(fullTask.bodyBytes).toBeUndefined();
      expect(Buffer.byteLength(compactOutput)).toBeLessThan(Buffer.byteLength(fullOutput) / 4);
    }

    // The natural single-record read remains complete without another flag.
    expect(JSON.parse(call(["show", "large-loop", "--json"]).stdout).object.body).toBe(body);
  });

  it("timeline shows meaningful activity, hides no-op checks, honors --task/--json", () => {
    call(["init"]);
    call(["create", "Busy loop", "--id", "busy"]);
    call(["note", "busy", "please review pricing"]); // human note - kept
    call(["note", "busy", "nothing actionable", "--session", "s1", "--actor", "run-noop"]); // agent no-op - hidden
    call(["create", "Side task", "--id", "side"]);

    const out = call(["timeline"]);
    expect(out.stdout).toContain("please review pricing");
    expect(out.stdout).toContain("[task-created]");
    expect(out.stdout).not.toContain("nothing actionable");
    const all = call(["timeline", "--all"]);
    expect(all.stdout).toContain("nothing actionable");

    const scoped = call(["timeline", "--task", "side"]);
    expect(scoped.stdout).not.toContain("pricing");
    const json = JSON.parse(call(["timeline", "--json"]).stdout) as Array<{ kind: string }>;
    expect(json.length).toBeGreaterThan(0);
    expect(json.every((i) => typeof i.kind === "string")).toBe(true);
  });

  it("attributes explicit sessions to an ordinary agent outside a delivered run", () => {
    call(["init"]);
    call(["create", "Agent task"]);
    call(["note", "agent-task", "did the thing", "--session", "sess-abc-123"]);

    const events = readFileSync(join(dir, ".loopany", "events", "agent-task.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; provenance: { entrance: string; sessionId?: string } });
    const noteEvent = events.find((e) => e.kind === "note");
    expect(noteEvent?.provenance.entrance).toBe("agent");
    expect(noteEvent?.provenance.sessionId).toBe("sess-abc-123");

    // The sessionId is NEVER truncated in `show --log` — it is the deep-dive key.
    const show = call(["show", "agent-task", "--log"]);
    expect(show.stdout).toContain("session=sess-abc-123");

    // The env var is the ambient equivalent.
    call(["note", "agent-task", "second thought"], { env: { LOOPANY_SESSION_ID: "sess-env-999" } });
    const show2 = call(["show", "agent-task", "--log"]);
    expect(show2.stdout).toContain("session=sess-env-999");
  });

  it("infers Codex and Claude Code sessions without calling them delivered runs", () => {
    call(["init"]);
    call(["create", "Harness task", "--id", "harness-task"]);
    call(["note", "harness-task", "from codex"], { env: { CODEX_THREAD_ID: "codex-thread-1" } });
    call(["note", "harness-task", "from claude"], { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-session-1" } });

    const show = call(["show", "harness-task", "--log"]);
    expect(show.stdout).toContain("agent:codex");
    expect(show.stdout).toContain("session=codex-thread-1");
    expect(show.stdout).toContain("agent:claude");
    expect(show.stdout).toContain("session=claude-session-1");
  });

  it("the compact event line names actorId, not just entrance (§7)", () => {
    call(["init"]);
    // The default human create — actorId is the default "cli".
    call(["create", "Attributed", "--id", "attributed"]);
    // An agent action carrying an explicit actor id + session.
    call(["note", "attributed", "by the agent", "--actor", "run-99", "--session", "sess-77"]);

    const show = call(["show", "attributed", "--log"]);
    // human events read `human:<actorId>`, agent events `agent-run:<actorId>` —
    // the entrance ALONE would collapse both to "human"/"agent-run" and lose the
    // attributable identity (the bug this fixes).
    expect(show.stdout).toContain("device:shared");
    expect(show.stdout).toContain("agent:run-99");
    // the session key still rides in FULL, unaffected.
    expect(show.stdout).toContain("session=sess-77");
  });

  it("show --json carries triggers + the active run, at text-vs-json parity (§3)", () => {
    call(["init"]);
    // A task with a cron trigger AND an assignee (which dispatches an assignment
    // run) so `show` has BOTH a trigger and an active run to surface.
    call(["create", "Nightly", "--id", "nightly", "--cron", "0 7 * * *", "--assignee", "claude"]);

    const text = call(["show", "nightly"]).stdout;
    // the text view surfaces the trigger AND the active run…
    expect(text).toContain("trigger cron");
    expect(text).toContain("run ");

    const json = call(["show", "nightly", "--json"]).stdout;
    const env = JSON.parse(json) as {
      object: { id: string };
      triggers: { taskId: string; kind: string }[];
      activeRun: { taskId: string; state: string } | null;
    };
    expect(env.object.id).toBe("nightly");
    // …and so does the JSON envelope — no longer strictly weaker than text.
    expect(env.triggers).toHaveLength(1);
    expect(env.triggers[0].taskId).toBe("nightly");
    expect(env.triggers[0].kind).toBe("cron");
    // the assignment run rides the envelope, at parity with the text view.
    expect(env.activeRun).not.toBeNull();
    expect(env.activeRun?.taskId).toBe("nightly");
    expect(["pending", "claimed", "running"]).toContain(env.activeRun?.state);

    // A non-task archetype carries empty trigger/run collections, not undefined.
    const mirror = call(["mirror", "add", "url", "https://acme.dev", "--json"]).stdout;
    const mid = (JSON.parse(mirror) as { result: { id: string } }).result.id;
    const menv = JSON.parse(call(["show", mid, "--json"]).stdout) as {
      triggers: unknown[];
      activeRun: unknown;
    };
    expect(menv.triggers).toEqual([]);
    expect(menv.activeRun).toBeNull();
  });

  it("--dry-run decides without persisting", () => {
    call(["init"]);
    const out = call(["create", "Phantom", "--dry-run"]);
    expect(out.stdout).toContain("dry-run");
    expect(out.stdout).toContain("would write: phantom");
    expect(out.stdout).not.toContain("\nok phantom");
    expect(existsSync(join(dir, ".loopany", "objects", "phantom.md"))).toBe(false);
    // The object dir stays empty.
    expect(readdirSync(join(dir, ".loopany", "objects"))).toHaveLength(0);

    call(["create", "Runnable", "--id", "runnable", "--assignee", "mbp/codex", "--status", "in-progress"]);
    const preview = JSON.parse(call(["run", "runnable", "--dry-run", "--json"]).stdout);
    expect(preview.operationalContext.run.consequence).toBe("created");
    expect(preview.operationalContext.run.createdId).toMatch(/^run-/);
    expect(preview.operationalContext.machine).toEqual({ alias: "mbp", presence: "unavailable" });
  });

  it("renders a human assignee without a duplicate at-sign", () => {
    call(["init"]);
    call(["create", "Human review", "--assignee", "tim@example.com"]);
    const out = call(["list"]);
    expect(out.stdout).toContain(" tim@example.com");
    expect(out.stdout).not.toContain("@tim@example.com");
  });

  it("bounds the default timeline to 20 meaningful items", () => {
    call(["init"]);
    call(["create", "Timeline target", "--id", "timeline-target"]);
    for (let i = 0; i < 25; i++) call(["note", "timeline-target", `note ${i}`]);
    expect(JSON.parse(call(["timeline", "--json"]).stdout)).toHaveLength(20);
    expect(JSON.parse(call(["timeline", "--limit", "25", "--json"]).stdout)).toHaveLength(25);
  });

  it("rejects a zero timeline limit instead of silently using the default", () => {
    call(["init"]);
    const out = run(["timeline", "--limit", "0"], deps());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--limit must be a positive integer");
  });

  it("re-init self-heals a missing table dir instead of crashing on the next write", () => {
    call(["init"]);
    // Manually remove a table dir (a stray `rm -rf`, a partial sync). Before the
    // fix, re-init returned "already initialized" WITHOUT restoring it, then the
    // first write died with an uncaught ENOENT from writeFileAtomic.
    rmSync(join(dir, ".loopany", "objects"), { recursive: true, force: true });
    expect(existsSync(join(dir, ".loopany", "objects"))).toBe(false);

    const reinit = call(["init"]);
    expect(reinit.stdout).toContain("already initialized");
    expect(existsSync(join(dir, ".loopany", "objects"))).toBe(true);

    // The next create now succeeds instead of ENOENT-crashing.
    const created = call(["create", "After heal", "--id", "healed"]);
    expect(created.stdout).toContain("ok healed");
    expect(existsSync(join(dir, ".loopany", "objects", "healed.md"))).toBe(true);
  });

  it("an oversize --body-file renders an exit-1 error, never a raw ArtifactFormatError stack", () => {
    call(["init"]);
    // A body over the codec's 4MiB document ceiling. serializeObject wraps the
    // ArtifactFormatError; the driver renders it as an OBJECT_TOO_LARGE error at
    // the persist seam (before the fix this escaped as an uncaught throw).
    const huge = "x".repeat(5 * 1024 * 1024);
    const path = join(dir, "huge.md");
    writeFileSync(path, huge);
    const out = run(["create", "Too big", "--id", "oversize", "--body-file", path], deps());
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("code: OBJECT_TOO_LARGE");
    // Nothing was persisted.
    expect(existsSync(join(dir, ".loopany", "objects", "oversize.md"))).toBe(false);
  });

  it("doc put with no --file refuses to wipe an existing body (data-loss guard)", () => {
    call(["init"]);
    const bodyPath = writeBody(dir, "# Notes\n\nreal content\n");
    call(["doc", "put", "notes", "--file", bodyPath]);
    // A bare `doc put notes` (no --file) would default the body to "" and blank
    // the doc — confirmed data loss. It must be a usage error naming --file.
    const out = run(["doc", "put", "notes"], deps());
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--file");
    expect(out.stderr.toLowerCase()).toContain("already exists");
    // The stored body is UNTOUCHED.
    const stored = readFileSync(join(dir, ".loopany", "objects", "notes.md"), "utf8");
    expect(stored).toContain("real content");

    // Empty-body CREATION of a NEW key still works (no --file, no existing doc).
    const fresh = call(["doc", "put", "brand-new"]);
    expect(fresh.stdout).toContain("ok brand-new");
  });

  it("doc put derives its title from the body H1 and clears it when the H1 is removed", () => {
    call(["init"]);
    const titled = writeBody(dir, "```md\n# Example only\n```\n\n# Live smoke report #\n\nResults.\n");
    call(["doc", "put", "smoke-report", "--file", titled]);
    let shown = JSON.parse(call(["show", "smoke-report", "--json"]).stdout) as {
      object: { title: string | null };
    };
    expect(shown.object.title).toBe("Live smoke report");

    const untitled = writeBody(dir, "Results without a heading.\n");
    call(["doc", "put", "smoke-report", "--file", untitled]);
    shown = JSON.parse(call(["show", "smoke-report", "--json"]).stdout) as {
      object: { title: string | null };
    };
    expect(shown.object.title).toBeNull();
  });

  // The data-loss guard must run against the LOCKED snapshot, not a pre-lock read
  // in the verb layer. Otherwise a `doc put <key>` whose pre-lock check saw NO doc
  // can be raced by a concurrent create in the window, and then wipe the body
  // written under it (TOCTOU). We prove the guard sees the snapshot loaded inside
  // the write lock: a doc that appears in that window is caught, no wipe.
  it("doc put's existence guard is evaluated against the LOCKED snapshot (TOCTOU)", () => {
    call(["init"]);
    const ws = requireWorkspace(dir);

    // The guard is the doc-put existence check, verbatim in shape: it refuses if
    // the LOCKED snapshot already carries the key.
    const guard = (locked: { objects: Record<string, unknown> }): void => {
      if (locked.objects["notes"] !== undefined) {
        throw new DriverError("USAGE", 'doc "notes" already exists (guard on locked snapshot)');
      }
    };

    // Model the race: the verb layer's pre-lock read saw NO doc and decided to
    // proceed with a bare put (body ""). In the window a concurrent writer creates
    // the doc. By the time runCommand takes the lock the doc EXISTS on disk, so the
    // guard — running on the snapshot loaded UNDER the lock — sees it and refuses
    // BEFORE decide/persist can wipe the body.
    runCommand(ws, { op: "doc-put", key: "notes", body: "# Notes\n\nreal content\n" }, actor(), now());
    expect(() =>
      runCommand(ws, { op: "doc-put", key: "notes", body: "" }, actor(), now(), { guard }),
    ).toThrow(/already exists/);

    // The stored body is untouched by the refused wipe.
    const stored = readFileSync(join(dir, ".loopany", "objects", "notes.md"), "utf8");
    expect(stored).toContain("real content");
  });

  it("--body-file resolves RELATIVE to deps.cwd, not the process CWD", () => {
    call(["init"]);
    // A relative --body-file that exists in deps.cwd (the temp workspace) but NOT
    // next to the process. Before the fix, bare readFileSync(file) looked next to
    // process.cwd() (the repo) and failed with "cannot read --body-file".
    writeFileSync(join(dir, "rel-body.md"), "# Relative\n\nfrom deps.cwd\n");
    // Sanity: the process CWD is NOT the temp dir, so a bare read would miss.
    expect(process.cwd()).not.toBe(dir);
    const out = call(["create", "Rel", "--id", "rel", "--body-file", "rel-body.md"]);
    expect(out.stdout).toContain("ok rel");
    const stored = readFileSync(join(dir, ".loopany", "objects", "rel.md"), "utf8");
    expect(stored).toContain("from deps.cwd");
  });

  it("--if-version parses a non-negative integer to a CAS token (a REAL bogus-version CONFLICT)", () => {
    call(["init"]);
    call(["create", "Versioned", "--id", "versioned"]);
    // A safe integer is compared verbatim: the object is at v0, so v9 is a REAL
    // (bogus-version) CONFLICT — exit 1, not a usage error.
    const atMax = run(["update", "versioned", "status=done", "--if-version", "9007199254740991"], deps());
    expect(atMax.exitCode).toBe(1);
    expect(atMax.stderr).toContain("code: CONFLICT");
    expect(atMax.stderr).toContain("9007199254740991");

    // NON-digit input stays a usage error (exit 2) — the parse guard the kernel
    // relies on to never see NaN/0.
    const bad = run(["update", "versioned", "status=done", "--if-version", "abc"], deps());
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toLowerCase()).toContain("non-negative integer");

    // Unsafe integers (>2^53) are §12-recorded M5 debt: `Number()` silently rounds
    // them, so the compared CAS token is not the one supplied. They are NOT refused
    // here yet — the refusal lands with the zod input-validation pass. Until then a
    // digit string still parses and reaches the kernel as a (rounded) CONFLICT, not
    // a usage error.
    const above = run(["update", "versioned", "status=done", "--if-version", "9007199254740993"], deps());
    expect(above.exitCode).toBe(1);
    expect(above.stderr).toContain("code: CONFLICT");
  });

  it("list --tree renders the tree even alongside a filter (spec §10)", () => {
    call(["init"]);
    call(["create", "Root", "--id", "root", "--assignee", "claude"]);
    call(["create", "Child", "--id", "child", "--parent", "root", "--assignee", "someone-else"]);
    // A bare filtered list would flatten and drop the non-matching root; --tree
    // forces the tree view explicitly and is ACCEPTED (never an exit-2 unknown
    // option, which the M6 golden script would trip over).
    const out = call(["list", "--tree", "--assignee", "claude"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("root");
    // the tree shape nests the child under its parent, unlike a flat filter.
    const rows = out.stdout.split("\n");
    const childRow = rows.find((r) => r.includes("child"));
    expect(childRow).toMatch(/^[├└]─ child/);
  });

  it("the object file round-trips through the codec (parse == serialize inverse)", () => {
    call(["init"]);
    call(["create", "Colon: in the title", "--id", "tricky", "--body-file", writeBody(dir, "# Heading\n\nbody\n")]);
    const raw = readFileSync(join(dir, ".loopany", "objects", "tricky.md"), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain('title: "Colon: in the title"'); // quoted because of the colon
    expect(raw).toContain("# Heading"); // body below the fence, verbatim
  });

  it("update status=follow-up --follow-up <date> lands the date and re-arms the once trigger", () => {
    // The EXACT grammar the CORE prompt (step 4 + once scenario) and SKILL.md
    // teach. It parses (`--follow-up` is in the OPTIONS table), so a swallowed
    // flag would fail closed as FOLLOWUP_NEEDS_DATE — the silent-flag-loss the
    // args header bans, breaking the once scenario's adaptive rescheduling (§8).
    call(["init"]);
    call(["create", "Watch the bet", "--id", "bet", "--assignee", "claude"]);
    const due = "2026-08-20T07:00:00.000Z";
    // Executed through the REAL CLI — no hand-built patch.
    const out = call(["update", "bet", "status=follow-up", "--follow-up", due, "--json"]);
    expect(out.exitCode).toBe(0);

    // The task carries the follow-up date (the flag reached patch.followUpAt).
    const show = JSON.parse(call(["show", "bet", "--json"]).stdout) as {
      object: { status: string; followUpAt: string | null };
      triggers: { kind: string; enabled: boolean; spec: string; nextFireAt: string | null }[];
    };
    expect(show.object.status).toBe("follow-up");
    expect(show.object.followUpAt).toBe(due);

    // The once trigger re-armed against that exact date (the generation IS the
    // value — kernel decide.ts once handling).
    const once = show.triggers.find((t) => t.kind === "once");
    expect(once).toBeDefined();
    expect(once?.enabled).toBe(true);
    expect(once?.spec).toBe(due);
    expect(once?.nextFireAt).toBe(due);
  });

  it("a bare followUpAt=<date> assign still wins over --follow-up if both are given", () => {
    // Precedence guard: the k=v assign is applied first and must not be clobbered
    // by the flag-mapping fallback.
    call(["init"]);
    call(["create", "Watch two", "--id", "two", "--assignee", "claude"]);
    const assignDate = "2026-08-25T07:00:00.000Z";
    const flagDate = "2026-08-20T07:00:00.000Z";
    call(["update", "two", "status=follow-up", `followUpAt=${assignDate}`, "--follow-up", flagDate]);
    const show = JSON.parse(call(["show", "two", "--json"]).stdout) as {
      object: { followUpAt: string | null };
    };
    expect(show.object.followUpAt).toBe(assignDate);
  });
});

/** Write a scratch body file next to the workspace and return its path. */
function writeBody(dir: string, content: string): string {
  const path = join(dir, "body.md");
  writeFileSync(path, content);
  return path;
}
