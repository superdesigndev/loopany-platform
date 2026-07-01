/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. evolve/edit carry no `{{token}}`; exec-loop fills name/taskFile/
 * stateLine (§4 is now ONE static section for every loop — no allowControl branch),
 * so it also guards that placeholder filling still works against the (now
 * skill-sourced) evolve import sitting alongside it.
 */
import { expect, test } from "vitest";

import { buildEditPrompt, buildEvolvePrompt, buildExecTask, buildLoopSystemPrompt } from "./prompt.js";
import type { Loop } from "../db/schema.js";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-test",
    name: "Test Loop",
    cron: "0 8 * * *",
    timezone: "America/New_York",
    task: "Check the thing and report.",
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

test("exec system prompt fills every placeholder", () => {
  const p = buildLoopSystemPrompt(loop());
  expect(p).toContain("This run: Test Loop");
  expect(p).toContain("/work/loopany/test/README.md");
  expect(p).toContain("loopany report");
  // Nothing left unfilled.
  expect(p).not.toMatch(/\{\{\w+\}\}/);
});

// §4 is now ONE static section for every loop — the prompt does NOT branch on
// allowControl. It offers only the cadence nudges (reschedule + set-cron), tells the
// run to consult `loopany show` for its actual capability, and never offers a run
// pause/resume/notify. The old on/off control variants are gone.
for (const allowControl of [true, false]) {
  test(`exec system prompt §4 is uniform (allowControl=${allowControl})`, () => {
    const p = buildLoopSystemPrompt(loop({ allowControl }));
    // The judge → show → adjust section, identical regardless of the loop flag.
    expect(p).toContain("## 4. Adjust your schedule — only if this run warrants it");
    expect(p).toContain("loopany show");
    // The two cadence levers a run may use.
    expect(p).toContain("loopany reschedule --next");
    expect(p).toContain("loopany set-cron");
    // A run is NOT offered pause/resume/notify anymore, and the old control markers
    // and off-variant heading are gone entirely.
    expect(p).not.toContain("loopany pause");
    expect(p).not.toContain("loopany resume");
    expect(p).not.toContain("loopany notify");
    expect(p).not.toContain("## 4. Change your own schedule");
    expect(p).not.toContain("<!-- control");
    expect(p).not.toMatch(/\{\{\w+\}\}/);
  });
}

test("exec system prompt lists declared metrics in the report line", () => {
  const p = buildLoopSystemPrompt(loop({ stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }] as Loop["stateSchema"] }));
  expect(p).toContain('loopany report --status <s> --state');
  expect(p).toContain("mrr");
});

test("exec task points the agent at its standing instructions + report", () => {
  const t = buildExecTask(loop());
  expect(t).toContain("[loop run · Test Loop]");
  expect(t).toContain("Check the thing and report.");
  expect(t).toContain("loopany report");
});
