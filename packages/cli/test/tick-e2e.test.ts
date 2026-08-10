/**
 * M3 acceptance — time and dispatch wired into the LOCAL file driver, end to end
 * against a REAL temp `.loopany/` workspace (§13 M3).
 *
 * The flow exercises the whole milestone:
 *   init → create a follow-up task → `tick --now <due>` flips it todo, dispatches a
 *   run(pending), and stamps a CLOCK-provenance status-changed event on disk →
 *   `run <id>` refuses while that run is active (one-active-run) →
 *   the ②/②' symmetry: a loop taken done disarms its cron by invariant, revived to
 *   todo re-arms it with the LOUD `re-armed cron` echo →
 *   the run-claim / run-finish lifecycle (pending → running → done) recorded on the
 *   run row and the task's event stream.
 *
 * The clock is INJECTED via `--now` (and `LOOPANY_NOW`) so every fire is
 * deterministic with no wall-clock read.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliDeps,
  type CliOutcome,
  requireWorkspace,
  run,
  runCommand,
} from "../src/index.js";

const CREATE_AT = "2026-08-09T12:00:00.000Z";
const DUE = "2026-08-10T07:00:00.000Z";
const AFTER_DUE = "2026-08-10T09:30:00.000Z";

describe("M3 time & dispatch (temp-dir E2E)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-m3-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // registryHome/probe isolate `init`'s registry write + PATH seed (test hazard).
  const deps = (over?: Partial<CliDeps>): CliDeps => ({ cwd: dir, now: CREATE_AT, env: {}, registryHome: dir, probe: () => false, ...over });

  const call = (argv: string[], over?: Partial<CliDeps>): CliOutcome => {
    const out = run(argv, deps(over));
    if (out.exitCode !== 0) throw new Error(`\`${argv.join(" ")}\` exited ${out.exitCode}: ${out.stderr}`);
    return out;
  };

  const readRun = (id: string) =>
    JSON.parse(readFileSync(join(dir, ".loopany", "runs", `${id}.json`), "utf8")) as {
      id: string;
      state: string;
      sessionId?: string | null;
      note?: string | null;
    };

  const readEvents = (objId: string) =>
    readFileSync(join(dir, ".loopany", "events", `${objId}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; provenance: { entrance: string; actorId: string } });

  it("a follow-up floats back to todo on tick, with a run(pending) and a clock event", () => {
    call(["init"]);
    // A follow-up task waiting until DUE, assigned to an agent so the fire dispatches.
    call(["create", "Check the bet", "--id", "bet", "--follow-up", DUE, "--assignee", "claude"]);

    // Not yet due: a tick before DUE fires nothing.
    const early = call(["tick", "--now", "2026-08-10T06:00:00.000Z", "--json"]);
    expect(JSON.parse(early.stdout).applied).toBe(0);

    // The clock reaches the due instant (injected, deterministic).
    const ticked = call(["tick", "--now", AFTER_DUE]);
    expect(ticked.stdout).toContain("fire");

    // The task flipped follow-up -> todo and cleared its slot.
    const show = call(["show", "bet", "--json"]);
    const env = JSON.parse(show.stdout) as {
      object: { status: string; followUpAt: string | null };
      activeRun: { cause: string; state: string } | null;
    };
    expect(env.object.status).toBe("todo");
    expect(env.object.followUpAt).toBeNull();

    // A run(pending) was dispatched (the once fire).
    expect(env.activeRun?.cause).toBe("once");
    expect(env.activeRun?.state).toBe("pending");

    // The flip event on disk carries CLOCK provenance (entrance=clock, actorId=the
    // trigger id) — the run was born of the clock, not a human/agent.
    const flip = readEvents("bet").find((e) => e.kind === "status-changed");
    expect(flip?.provenance.entrance).toBe("clock");
    expect(flip?.provenance.actorId).toBe("trg-bet-once");

    // `run bet` refuses while that dispatched run is still active (one-active-run).
    const refused = run(["run", "bet"], deps());
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("code: RUN_ACTIVE");
  });

  it("LOOPANY_NOW pins the clock the same way --now does", () => {
    call(["init"]);
    call(["create", "Waiter", "--id", "waiter", "--follow-up", DUE, "--assignee", "claude"]);
    call(["tick"], { env: { LOOPANY_NOW: AFTER_DUE } });
    const env = JSON.parse(call(["show", "waiter", "--json"]).stdout) as { object: { status: string } };
    expect(env.object.status).toBe("todo");
  });

  it("done → todo revival re-arms the cron with the loud ②' echo", () => {
    call(["init"]);
    call(["create", "Nightly", "--id", "nightly", "--cron", "0 7 * * *", "--assignee", "claude", "--status", "in-progress"]);

    // Taken done: invariant ② disables (not deletes) the cron.
    call(["update", "nightly", "status=done"]);
    const trigDone = JSON.parse(
      readFileSync(join(dir, ".loopany", "triggers", "trg-nightly-cron.json"), "utf8"),
    ) as { enabled: boolean; disabledBy: string };
    expect(trigDone.enabled).toBe(false);
    expect(trigDone.disabledBy).toBe("invariant");

    // Revived to todo: ②' re-arms it and the CLI echoes LOUDLY (» re-armed cron …).
    const revive = call(["update", "nightly", "status=todo"]);
    expect(revive.stdout).toContain("»");
    expect(revive.stdout.toLowerCase()).toContain("re-armed cron");
    const trigLive = JSON.parse(
      readFileSync(join(dir, ".loopany", "triggers", "trg-nightly-cron.json"), "utf8"),
    ) as { enabled: boolean; disabledBy: string | null };
    expect(trigLive.enabled).toBe(true);
    expect(trigLive.disabledBy).toBeNull();
  });

  it("run <id> is the third dispatch entrance and refuses a second active run", () => {
    call(["init"]);
    call(["create", "Ad-hoc", "--id", "adhoc", "--assignee", "claude", "--status", "in-progress"]);
    // No dispatchable auto-run yet (status is in-progress, not todo), so `run` mints one.
    const dispatched = call(["run", "adhoc", "--wait"]); // --wait is an accepted no-op in M3
    expect(dispatched.stdout).toContain("ok adhoc");
    const active = JSON.parse(call(["show", "adhoc", "--json"]).stdout) as {
      activeRun: { cause: string; state: string } | null;
    };
    expect(active.activeRun?.cause).toBe("manual");
    expect(active.activeRun?.state).toBe("pending");

    // A second `run` refuses — one active run per task.
    const again = run(["run", "adhoc"], deps());
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("code: RUN_ACTIVE");
  });

  it("the run-claim / run-finish lifecycle drives a run pending → running → done", () => {
    call(["init"]);
    // A todo task with an agent assignee auto-dispatches an assignment run.
    call(["create", "Wire header", "--id", "wire", "--assignee", "claude", "--status", "todo"]);
    const ws = requireWorkspace(dir);
    const pending = JSON.parse(call(["show", "wire", "--json"]).stdout) as {
      activeRun: { id: string; state: string };
    };
    expect(pending.activeRun.state).toBe("pending");
    const runId = pending.activeRun.id;

    // Claim it: pending → running, sessionId captured, and the one-shot task flips
    // todo → in-progress + a run-started rides the task stream. (Driven through the
    // driver's runCommand, the same seam every verb uses — run-claim/run-finish are
    // host lifecycle verbs, not part of the M3 CLI-verb scope.)
    const agent = { entrance: "agent-run" as const, actorId: "run-99", sessionId: "sess-77" };
    runCommand(ws, { op: "run-claim", runId, sessionId: "sess-77" }, agent, AFTER_DUE);
    expect(readRun(runId).state).toBe("running");
    expect(readRun(runId).sessionId).toBe("sess-77");
    const afterClaim = JSON.parse(call(["show", "wire", "--json"]).stdout) as { object: { status: string } };
    expect(afterClaim.object.status).toBe("in-progress");
    expect(readEvents("wire").map((e) => e.kind)).toContain("run-started");

    // Finish it: running → done, note recorded, run-returned on the stream.
    runCommand(ws, { op: "run-finish", runId, outcome: "done", note: "shipped it" }, agent, AFTER_DUE);
    expect(readRun(runId).state).toBe("done");
    expect(readRun(runId).note).toBe("shipped it");
    // The claim's sessionId must SURVIVE the finish. run-finish reloads the run and
    // spreads it ({...run, state, note}); a driver that dropped sessionId on reload
    // would silently write sessionId:undefined here, destroying the transcript
    // deep-dive key (§3 run record · §7 context-ladder rung ⑤).
    expect(readRun(runId).sessionId).toBe("sess-77");
    const returned = readEvents("wire").find((e) => e.kind === "run-returned");
    expect(returned).toBeDefined();
    expect(returned?.provenance.actorId).toBe("run-99");

    // The finished run is no longer active, so `show` surfaces no active run.
    const settled = JSON.parse(call(["show", "wire", "--json"]).stdout) as { activeRun: unknown };
    expect(settled.activeRun).toBeNull();
  });

  it("a failed one-shot run re-arms the follow-up alarm (haiku-5, never strands)", () => {
    call(["init"]);
    call(["create", "Risky", "--id", "risky", "--assignee", "claude", "--status", "todo"]);
    const ws = requireWorkspace(dir);
    const runId = (JSON.parse(call(["show", "risky", "--json"]).stdout) as { activeRun: { id: string } }).activeRun.id;
    const agent = { entrance: "agent-run" as const, actorId: "run-1" };
    runCommand(ws, { op: "run-claim", runId }, agent, AFTER_DUE); // todo -> in-progress
    runCommand(ws, { op: "run-finish", runId, outcome: "failed", note: "crashed" }, agent, AFTER_DUE);
    expect(readRun(runId).state).toBe("failed");
    // The stranded task is re-armed: follow-up +1h (first backoff rung), so the
    // executor hiccup costs one hour, not the task's whole schedule. The full
    // ladder/park policy is pinned in the kernel's failedRunResilience tests.
    const env = JSON.parse(call(["show", "risky", "--json"]).stdout) as {
      object: { status: string; followUpAt: string };
    };
    expect(env.object.status).toBe("follow-up");
    expect(env.object.followUpAt).toBe(new Date(Date.parse(AFTER_DUE) + 3_600_000).toISOString());
  });

  it("--now / LOOPANY_NOW steers the list --due and inbox READ paths (not just tick)", () => {
    call(["init"]);
    // A follow-up dated between deps.now (CREATE_AT) and the injected read clock.
    call(["create", "Later", "--id", "later", "--follow-up", "2026-08-15T00:00:00.000Z", "--assignee", "claude"]);

    // With the ambient wall clock (deps.now = CREATE_AT, before the follow-up), the
    // task is NOT yet due — list --due finds nothing.
    const notYet = JSON.parse(call(["list", "--due", "--json"]).stdout) as { id: string }[];
    expect(notYet.map((t) => t.id)).not.toContain("later");

    // Pin the read clock PAST the follow-up via --now: the same query now matches.
    // A driver that parsed --now but passed the raw deps.now (the bug) would still
    // print "(no matches)" here.
    const dueNow = JSON.parse(
      call(["list", "--due", "--now", "2026-08-20T00:00:00.000Z", "--json"]).stdout,
    ) as { id: string }[];
    expect(dueNow.map((t) => t.id)).toContain("later");

    // LOOPANY_NOW steers the same read path identically.
    const dueEnv = JSON.parse(
      call(["list", "--due", "--json"], { env: { LOOPANY_NOW: "2026-08-20T00:00:00.000Z" } }).stdout,
    ) as { id: string }[];
    expect(dueEnv.map((t) => t.id)).toContain("later");

    // inbox reads "now" for its due buckets too — --now must reach it.
    const inboxNow = JSON.parse(
      call(["inbox", "--assignee", "claude", "--now", "2026-08-20T00:00:00.000Z", "--json"]).stdout,
    ) as { id: string }[];
    expect(JSON.stringify(inboxNow)).toContain("later");
  });

  it("an invalid --now is a usage error, not a silent wall-clock fall-through", () => {
    call(["init"]);
    const out = run(["tick", "--now", "not-a-date"], deps());
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toLowerCase()).toContain("iso instant");
    // Ensure it never fell through to the wall clock: no workspace mutation happened.
    expect(existsSync(join(dir, ".loopany", "runs"))).toBe(true);
  });
});
