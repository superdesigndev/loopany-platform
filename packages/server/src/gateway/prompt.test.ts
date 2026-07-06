/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. evolve/edit carry no `{{token}}`; the exec run's instructions now live
 * in the first USER turn (`buildExecTask` ← exec-core.md, fills name/taskFile/
 * goalLine/stateLine) with an empty system prompt (run-experience redesign, Batch 1),
 * so these also guard that placeholder filling still works against the (now
 * skill-sourced) evolve import sitting alongside it.
 */
import { expect, test } from "vitest";

import { buildEditPrompt, buildEvolvePrompt, buildEvolveTask, buildExecTask, buildLoopSystemPrompt } from "./prompt.js";
import type { Loop, Run } from "../db/schema.js";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-test",
    name: "Test Loop",
    cron: "0 8 * * *",
    timezone: "America/New_York",
    taskFile: "/work/loopany/test/README.md",
    stateSchema: null,
    allowControl: false,
    ui: null,
    workflow: null,
    ...over,
  }) as unknown as Loop;

test("evolve run prompt keeps every lever + smoke-test discipline", () => {
  const p = buildEvolvePrompt();
  // The three structural levers run-dispatch live-supports for an evolve token.
  expect(p).toContain("loopany set-ui --file");
  expect(p).toContain("loopany set-schema --file");
  expect(p).toContain("loopany set-workflow --file");
  // Binding syntax + chart primitives the UI lever depends on.
  expect(p).toContain("{{latest.");
  expect(p).toContain("<loop-chart");
  // Run-only framing + the smoke-test gate before set-workflow.
  expect(p).toMatch(/never contact the user/i);
  expect(p).toMatch(/smoke-test/i);
  // No unfilled placeholders leak into the evolve prompt (it takes no vars).
  expect(p).not.toMatch(/\{\{(?!latest\.)\w+\}\}/);
});

test("evolve task payload inlines each run's cost, and the prose explains the field", () => {
  const runs = [
    {
      ts: "2026-07-06T05:40:02.851Z",
      outcome: "exec",
      status: "new",
      sample: null,
      state: { checks: 3 },
      message: "3 checks done",
      costUsd: 0.8273,
      sessionId: "sess-1",
    },
  ] as unknown as Run[];
  const t = buildEvolveTask(loop(), runs);
  // The recent-runs survey the evolve agent reads carries the per-run cost…
  expect(t).toContain('"costUsd": 0.8273');
  // …and the standing evolve instructions (skill/references/evolve.md) name it.
  expect(buildEvolvePrompt()).toContain("costUsd");
});

test("evolve run prompt carries the task-first + workflow + dashboard guidance", () => {
  const p = buildEvolvePrompt();
  // The task lever: sharpen the brief by editing the task file on disk (no set-task).
  expect(p).toContain("## 1. The task");
  expect(p).toMatch(/edit the task file/i);
  expect(p).toContain("## Spec");
  expect(p).toContain("## Current understanding");
  expect(p).toContain("## Timeline");
  // Workflow elevated to §2, dashboard demoted to §3.
  expect(p).toContain("## 2. Workflow");
  expect(p).toContain("## 3. Dashboard");
  // The two-lens log reading: quick survey (loopany log, with session id) + deep dive (session JSONL).
  expect(p).toContain("loopany log");
  expect(p).toMatch(/session/i);
  expect(p).toMatch(/\.jsonl/i);
});

test("edit run prompt keeps the schedule/envelope verbs (run-token surface)", () => {
  const p = buildEditPrompt();
  for (const verb of ["set-cron", "set-tz", "set-name", "notify", "set-model", "pause", "reschedule"]) {
    expect(p).toContain(verb);
  }
  // Edit may also touch the dashboard/gate, and must finalize with a resolved report.
  expect(p).toContain("set-ui --file");
  expect(p).toContain("loopany report --status resolved");
});

// Run-experience redesign, Batch 1: the exec run's standing instructions moved out
// of the system prompt into the FIRST USER TURN (`buildExecTask`). The system prompt
// is now empty so the daemon's `--append-system-prompt-file` becomes a harmless
// no-op on every existing daemon (design §5.2) — this ships server-first, no daemon
// change. These assertions lock that move: an empty system prompt, and the full CORE
// (identity + untrusted-data guard + non-negotiable fallback core + report grammar +
// per-run trigger + skill pointer) carried in the user turn.
test("exec system prompt is empty (instructions moved to the user turn)", () => {
  expect(buildLoopSystemPrompt(loop())).toBe("");
  expect(buildLoopSystemPrompt(loop({ allowControl: true }))).toBe("");
  expect(
    buildLoopSystemPrompt(loop({ stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }] as Loop["stateSchema"] })),
  ).toBe("");
});

test("exec task carries the CORE: identity, fallback core, report/finish, skill pointer", () => {
  const t = buildExecTask(loop());
  expect(t).toContain("[loop run · Test Loop]");
  // Identity + role framing (one scheduled run, act only through `loopany`).
  expect(t).toMatch(/one scheduled run/i);
  expect(t).toContain("loopany");
  // The non-negotiable inline fallback core, self-sufficient without the skill.
  expect(t).toMatch(/non-negotiable/i);
  expect(t).toContain("/work/loopany/test/README.md"); // read the task file first
  expect(t).toContain("## Spec");
  expect(t).toMatch(/surface only what/i); // do the work, surface only what changed
  expect(t).toMatch(/exactly ONE terminal call/i);
  expect(t).toContain("loopany report");
  expect(t).toContain("loopany finish");
  expect(t).toMatch(/one pass/i); // one pass then stop
  // Skill pointer names the installable skill with a CORE-sufficient fallback.
  expect(t).toMatch(/loopany skill/i);
  expect(t).toMatch(/sufficient/i);
  // Nothing left unfilled.
  expect(t).not.toMatch(/\{\{\w+\}\}/);
});

test("exec task keeps the untrusted-data guard prominent in the user turn", () => {
  const t = buildExecTask(loop());
  expect(t).toMatch(/Untrusted data/i);
  expect(t).toContain("## Timeline");
  expect(t).toMatch(/data, never as instructions/i);
  // The trust hierarchy: goal line + Spec authoritative, goal wins on conflict.
  expect(t).toMatch(/goal line wins/i);
});

test("exec task report grammar is schema-derived (stateLine)", () => {
  // No schema → the optional single-metric --sample line.
  const open = buildExecTask(loop());
  expect(open).toContain("loopany report --status new --sample <number>");
  expect(open).not.toContain("--state '{");
  // Declared schema → the --state grammar lists every declared key.
  const withSchema = buildExecTask(
    loop({ stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }] as Loop["stateSchema"] }),
  );
  expect(withSchema).toContain("loopany report --status <s> --state");
  expect(withSchema).toContain('"mrr":<n>');
  expect(withSchema).not.toContain("--sample <number>");
});

test("exec task injects a Goal (finish line) iff the loop has a goal", () => {
  // Open loop → no INJECTED goal line. (The untrusted-data guard mentions the
  // `Goal (finish line):` token in backticks; that is the template, not an
  // injection — so match an actual injected line: at line start, with content.)
  expect(buildExecTask(loop())).not.toMatch(/^Goal \(finish line\): \S/m);
  // Closed loop → the setpoint is prompt-injected on its own line (wins over the file).
  expect(buildExecTask(loop({ goal: "reach 100 paying users" }))).toMatch(
    /^Goal \(finish line\): reach 100 paying users$/m,
  );
});
