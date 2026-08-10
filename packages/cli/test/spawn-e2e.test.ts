/**
 * M4 acceptance — the LOCAL agent loop, end to end with a FAKE agent (§13 M4).
 *
 * The flow is the whole milestone's promise ("一个 follow-up 任务被 agent 自主完成"):
 *   init → config a profile for the "claude" assignee pointing at a real fake-agent
 *   fixture → create a follow-up task due at DUE → `tick --spawn --now <after>`
 *   fires the once trigger (follow-up → todo → run(pending)), then CONSUMES that
 *   pending run: claims it (sessionId captured), spawns the fixture with the CORE
 *   prompt on stdin, the fixture drives the REAL CLI to note + update status=done,
 *   and the host finishes the run done from exit 0.
 *
 * Assertions: the task ends `done`; the run row is `done` with the spawn session
 * id; the events carry AGENT-RUN provenance stamped with that same session id
 * (the fixture's note/update rode the session), proving agent-run provenance +
 * sessionId flow end to end. Real-claude demos stay manual — this uses a fixture.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliDeps, type CliOutcome, run } from "../src/index.js";

// Keep both paths in VARIABLES — the literal `new URL('./x', import.meta.url)`
// form is statically rewritten by vite into an http asset URL that fileURLToPath
// then rejects (repo-wide guard idiom).
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRel = "./fixtures/fake-agent.mjs";
const fixturePath = join(here, fixtureRel);
const binRel = "../bin/loopany-kernel.mjs";
const binPath = join(here, binRel);

const CREATE_AT = "2026-08-09T12:00:00.000Z";
const DUE = "2026-08-10T07:00:00.000Z";
const AFTER_DUE = "2026-08-10T09:30:00.000Z";

describe("M4 local agent loop (fake-agent E2E)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loopany-m4-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (over?: Partial<CliDeps>): CliDeps => ({
    cwd: dir,
    now: CREATE_AT,
    // The fixture drives the real CLI against THIS workspace; it reads the bin +
    // cwd from env (never a hard-coded path).
    env: { LOOPANY_BIN: binPath, LOOPANY_WS_CWD: dir },
    // Isolate the workspace registry + PATH probe so `init` never writes the real
    // ~/.loopany or seeds a profile from the host's installed agents - these tests
    // configure the "claude" profile EXPLICITLY (or assert it is absent).
    registryHome: dir,
    probe: () => false,
    ...over,
  });

  const call = (argv: string[], over?: Partial<CliDeps>): CliOutcome => {
    const out = run(argv, deps(over));
    if (out.exitCode !== 0) throw new Error(`\`${argv.join(" ")}\` exited ${out.exitCode}: ${out.stderr}`);
    return out;
  };

  /** Write a `profiles` block into config.json binding "claude" -> the fixture.
   *  No `{{prompt}}` token, so the CORE prompt is delivered on stdin (§8). */
  const configProfile = () => {
    const cfgPath = join(dir, ".loopany", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.profiles = {
      claude: { cmd: process.execPath, args: [fixturePath], cwd: dir },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  };

  const readRun = (id: string) =>
    JSON.parse(readFileSync(join(dir, ".loopany", "runs", `${id}.json`), "utf8")) as {
      state: string;
      sessionId?: string | null;
      note?: string | null;
    };

  const readEvents = (objId: string) =>
    readFileSync(join(dir, ".loopany", "events", `${objId}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; note?: string; provenance: { entrance: string; actorId: string; sessionId?: string } });

  it("a due follow-up is fired and autonomously completed by the spawned agent", () => {
    call(["init"]);
    configProfile();
    call(["create", "Check the bet", "--id", "bet", "--follow-up", DUE, "--assignee", "claude"]);

    // tick --spawn at the due instant: fire the once trigger AND run the pending
    // run through the fixture. The real subprocess spawn (realSpawn) is used —
    // deps.spawn is left unset so the default seam launches the fixture for real.
    const out = call(["tick", "--spawn", "--now", AFTER_DUE, "--json"]);
    const report = JSON.parse(out.stdout) as {
      applied: number;
      spawned: { runId: string; taskId: string; outcome: string; assignee: string }[];
    };
    expect(report.applied).toBe(1); // the once fire flipped follow-up -> todo + dispatched
    expect(report.spawned).toHaveLength(1);
    expect(report.spawned[0].outcome).toBe("done");
    expect(report.spawned[0].assignee).toBe("claude");

    // The task ended DONE — the fake agent closed it via `update status=done`.
    const show = JSON.parse(call(["show", "bet", "--json"]).stdout) as {
      object: { status: string };
      activeRun: unknown;
    };
    expect(show.object.status).toBe("done");
    expect(show.activeRun).toBeNull(); // the run is finished, no longer active

    // The run row is DONE and carries the spawn session id (captured at claim).
    const runId = report.spawned[0].runId;
    const runRow = readRun(runId);
    expect(runRow.state).toBe("done");
    const sessionId = runRow.sessionId;
    expect(sessionId).toBe(`spawn-${runId}`);

    // Agent-run provenance flows end to end: the fixture's note/update events
    // carry entrance=agent-run stamped with the SAME session id the spawn captured.
    const events = readEvents("bet");
    const agentEvents = events.filter((e) => e.provenance.entrance === "agent-run");
    expect(agentEvents.length).toBeGreaterThan(0);
    // The fixture's own note rode the session id (LOOPANY_SESSION_ID).
    const fixtureNote = agentEvents.find((e) => e.kind === "note" && e.note?.includes("fake agent"));
    expect(fixtureNote).toBeDefined();
    expect(fixtureNote?.provenance.sessionId).toBe(sessionId);
    // §3 provenance: the agent's own callbacks are attributed to the RUN id, not
    // a generic "agent" — the CORE spawn seeds LOOPANY_ACTOR=run.id so every agent
    // callback stamps actorId=run-<id>, matching the host's own claim/finish
    // events (events are immutable — a degenerate actorId would bake in forever).
    expect(fixtureNote?.provenance.actorId).toBe(runId);
    for (const e of agentEvents) expect(e.provenance.actorId).toBe(runId);
    // The host's own run-started/run-returned events are attributed to the run.
    expect(events.map((e) => e.kind)).toContain("run-started");
    expect(events.map((e) => e.kind)).toContain("run-returned");
    const runStarted = events.find((e) => e.kind === "run-started");
    expect(runStarted?.provenance.actorId).toBe(runId); // host and agent agree
  });

  it("a brand-new task's first pass gets the new-task scenario (real spawn path)", () => {
    // Regression: on the REAL path the events file ALWAYS exists (creation +
    // the just-claimed run's own events), so a bare existsSync would force the
    // `reassigned` scenario for every fresh assignment run — §8's new-task
    // scenario would be dead code in production. Assert the RENDERED prompt.
    call(["init"]);
    // A profile that captures the CORE prompt (delivered on stdin) to a file so
    // the test can assert what the agent actually received. Exits 0 → done.
    const captureFile = join(dir, "prompt.txt");
    const cfgPath = join(dir, ".loopany", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.profiles = {
      claude: {
        cmd: process.execPath,
        args: ["-e", `require("fs").writeFileSync(process.env.CAP, require("fs").readFileSync(0, "utf8"))`],
        cwd: dir,
      },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    // A fresh task, version 1, never worked — the create auto-dispatches an
    // assignment run(pending) which tick --spawn then consumes.
    call(["create", "Fresh work", "--id", "fresh", "--assignee", "claude", "--status", "todo"], {
      env: { LOOPANY_BIN: binPath, LOOPANY_WS_CWD: dir, CAP: captureFile },
    });
    const out = call(["tick", "--spawn", "--now", AFTER_DUE, "--json"], {
      env: { LOOPANY_BIN: binPath, LOOPANY_WS_CWD: dir, CAP: captureFile },
    });
    const report = JSON.parse(out.stdout) as { spawned: { outcome: string }[] };
    expect(report.spawned).toHaveLength(1);
    expect(report.spawned[0].outcome).toBe("done");

    const prompt = readFileSync(captureFile, "utf8");
    expect(prompt).toContain("SCENARIO — a new task, first pass:");
    expect(prompt).not.toContain("SCENARIO — handed back to you:");
  });

  it("a re-queued task with prior work gets the reassigned scenario (real spawn path)", () => {
    // The mirror of the above: a task that has ALREADY been worked (a prior
    // finished run + notes) and is then re-queued must read as `reassigned`, so
    // the derivation is not simply "always new-task".
    call(["init"]);
    const captureFile = join(dir, "prompt.txt");
    const cfgPath = join(dir, ".loopany", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.profiles = {
      claude: {
        cmd: process.execPath,
        args: ["-e", `require("fs").writeFileSync(process.env.CAP, require("fs").readFileSync(0, "utf8"))`],
        cwd: dir,
      },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    const capEnv = { env: { LOOPANY_BIN: binPath, LOOPANY_WS_CWD: dir, CAP: captureFile } };

    // First pass: create + spawn to completion (leaves a finished run + a note).
    call(["create", "Recurring check", "--id", "rec", "--assignee", "claude", "--status", "todo"], capEnv);
    call(["tick", "--spawn", "--now", AFTER_DUE, "--json"], capEnv);
    // The first pass ended done → re-open by re-queuing to the loop (a human
    // answer). A distinct `--now` so the new assignment run's deterministic id
    // does not collide with the first pass's (uniqueness IS the dispatch dedup).
    call(["update", "rec", "status=todo", "assignee=claude", "--note", "please look again", "--now", "2026-08-10T10:30:00.000Z"]);

    // Second pass: this run must see prior history → reassigned.
    call(["tick", "--spawn", "--now", "2026-08-10T11:00:00.000Z", "--json"], capEnv);
    const prompt = readFileSync(captureFile, "utf8");
    expect(prompt).toContain("SCENARIO — handed back to you:");
    expect(prompt).not.toContain("SCENARIO — a new task, first pass:");
  });

  it("a run whose assignee has no profile is left pending, never spawned", () => {
    call(["init"]);
    // No profile configured for "claude".
    call(["create", "Unbound", "--id", "unbound", "--assignee", "claude", "--status", "todo"]);
    const out = call(["tick", "--spawn", "--now", AFTER_DUE, "--json"]);
    const report = JSON.parse(out.stdout) as { spawned: unknown[]; spawnNotices: string[] };
    expect(report.spawned).toHaveLength(0);
    expect(report.spawnNotices.join("\n")).toContain("no profile for assignee");
    // The pending run is still there, unclaimed.
    const show = JSON.parse(call(["show", "unbound", "--json"]).stdout) as {
      activeRun: { state: string } | null;
    };
    expect(show.activeRun?.state).toBe("pending");
    // The workspace was not corrupted.
    expect(existsSync(join(dir, ".loopany", "runs"))).toBe(true);
  });

  it("a failing agent (non-zero exit) finishes the run as failed", () => {
    call(["init"]);
    // A profile whose cmd exits non-zero (node -e 'process.exit(5)').
    const cfgPath = join(dir, ".loopany", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.profiles = { claude: { cmd: process.execPath, args: ["-e", "process.exit(5)"], cwd: dir } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    call(["create", "Risky", "--id", "risky", "--assignee", "claude", "--status", "todo"]);
    const out = call(["tick", "--spawn", "--now", AFTER_DUE, "--json"]);
    const report = JSON.parse(out.stdout) as { spawned: { runId: string; outcome: string; status: number }[] };
    expect(report.spawned[0].outcome).toBe("failed");
    expect(report.spawned[0].status).toBe(5);
    expect(readRun(report.spawned[0].runId).state).toBe("failed");
  });

  it("a nonzero child is retried once - a flaky agent recovers within the same run", () => {
    call(["init"]);
    // A child that fails the FIRST invocation and succeeds the second, keyed on a
    // marker file (the retry is a fresh process; state must live outside it).
    const marker = join(dir, "first-try");
    const flaky =
      `const fs=require("fs");` +
      `if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},"1");process.exit(1)}` +
      `process.exit(0)`;
    const cfgPath = join(dir, ".loopany", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.profiles = { claude: { cmd: process.execPath, args: ["-e", flaky], cwd: dir } };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    call(["create", "Flaky", "--id", "flaky", "--assignee", "claude", "--status", "todo"]);
    const out = call(["tick", "--spawn", "--now", AFTER_DUE, "--json"]);
    const report = JSON.parse(out.stdout) as { spawned: { runId: string; outcome: string; status: number }[] };
    expect(report.spawned[0].outcome).toBe("done");
    expect(report.spawned[0].status).toBe(0);
    expect(readRun(report.spawned[0].runId).state).toBe("done");
    expect(readRun(report.spawned[0].runId).note).toContain("after one retry");
  });
});
