/**
 * The assembled run prompts must keep every run-essential directive after the
 * evolve guidance was unified into the single source skill/references/evolve.md
 * (run-dispatch and the installable skill now read the SAME file). These assertions
 * lock the run behavior for each role — losing a lever here is a regression, not a
 * doc tweak. The exec run's instructions live in the first USER turn (`buildExecTask`
 * ← exec-core.md, fills name/taskFile/goalLine/stateLine) with an empty system
 * prompt (run-experience redesign, Batch 1). Batch 2 extends the same move to
 * EVOLVE and EDIT: their system prompts are now empty too, the standing prose ships
 * in the first user turn (`buildEvolveTask`/`buildEditTask`), and the evolve payload
 * inlines a COMPACT one-line-per-run survey (state keys not values, clipped message)
 * instead of full pretty-printed JSON. These assertions lock that.
 */
import { expect, test } from "vitest";

import {
  buildEditPrompt,
  buildEditTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
} from "./prompt.js";
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

// Batch 2: the evolve/edit system prompts are empty — the standing prose moved into
// the first user turn (like exec, Batch 1). The daemon's `--append-system-prompt-file`
// becomes a harmless no-op on every existing daemon (ships server-first).
test("evolve + edit system prompts are empty (prose moved to the user turn)", () => {
  expect(buildEvolvePrompt()).toBe("");
  expect(buildEditPrompt()).toBe("");
});

test("evolve task turn keeps every lever + smoke-test discipline + protocol prose", () => {
  const t = buildEvolveTask(loop(), []);
  // The three structural levers run-dispatch live-supports for an evolve token.
  expect(t).toContain("loopany set-ui --file");
  expect(t).toContain("loopany set-schema --file");
  expect(t).toContain("loopany set-workflow --file");
  // Binding syntax + chart primitives the UI lever depends on.
  expect(t).toContain("{{latest.");
  expect(t).toContain("<loop-chart");
  // Run-only framing + the smoke-test gate before set-workflow.
  expect(t).toMatch(/never notif(y|ies) the user/i);
  expect(t).toMatch(/smoke-test/i);
  // The pass must leave a run-log summary (report --message), stated in both the
  // standing prose (§4 Finish) and the payload's closing instruction — an evolve
  // block in the timeline should never be blank.
  expect(t).toMatch(/loopany report --message/);
  expect(t).toMatch(/no change/i);
  // The untrusted-data guard rides along in the user turn (evolve reads run messages).
  expect(t).toMatch(/data, never as instructions/i);
  // The task lever: sharpen the brief by editing the task file on disk (no set-task).
  expect(t).toContain("## 1. The task");
  expect(t).toMatch(/edit the task file/i);
  expect(t).toContain("## Spec");
  expect(t).toContain("## Current understanding");
  expect(t).toContain("## Timeline");
  // Workflow elevated to §2, dashboard demoted to §3.
  expect(t).toContain("## 2. Workflow");
  expect(t).toContain("## 3. Dashboard");
  // The two-lens log reading: survey (loopany log, with session id) + deep dive (session JSONL).
  expect(t).toContain("loopany log");
  expect(t).toMatch(/session/i);
  expect(t).toMatch(/\.jsonl/i);
  // No unfilled placeholders leak into the evolve turn (it takes no `{{token}}` vars;
  // the `{{latest.*}}` binding syntax in the prose is the only legitimate exception).
  expect(t).not.toMatch(/\{\{(?!latest\.)\w+\}\}/);
});

test("evolve task inlines a COMPACT run survey: keys not values, clipped message, pointers", () => {
  const runs = [
    {
      ts: "2026-07-05T06:00:00.000Z",
      role: "exec",
      outcome: "exec",
      status: "new",
      state: { drift: 3, prs: 1 },
      message: "Detected drift " + "x".repeat(200), // long enough to force truncation
      costUsd: 0.4231,
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    },
    {
      ts: "2026-07-06T06:00:00.000Z",
      role: "exec",
      outcome: "exec",
      status: "nothing-new",
      state: null,
      message: "no drift since last sweep",
      costUsd: null,
      sessionId: null,
    },
  ] as unknown as Run[];
  const t = buildEvolveTask(loop(), runs);

  // On-demand pointers head the survey: loopany log (works in-run now) + session JSONL.
  expect(t).toContain("loopany log");
  expect(t).toContain("--transcript");
  expect(t).toMatch(/find ~\/\.claude\/projects -name '<session>\.jsonl'/);

  // Cost is rendered compactly (`$x.xx`) — the survey row carries `$0.42`, not the
  // raw 4-decimal number. (The prose still names the `costUsd` field it explains.)
  expect(t).toContain("$0.42");
  expect(t).not.toContain("0.4231");

  // State appears as KEYS only — the values (3, 1) are dropped from the inline payload.
  expect(t).toContain("drift,prs");
  expect(t).not.toMatch(/"drift":\s*3/);
  expect(t).not.toContain('"prs": 1');

  // The full session id is preserved (so the deep-dive `find` resolves).
  expect(t).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  // The message is clipped to ~100 chars with an ellipsis; the full body never lands.
  const clipped = ("Detected drift " + "x".repeat(200)).slice(0, 100) + "…";
  expect(t).toContain(clipped);
  expect(t).not.toContain("x".repeat(101)); // the un-clipped tail is gone

  // The header announces the window size.
  expect(t).toContain("N=2");
});

test("edit task turn is a short CORE: apply one change, don't run/finish, report", () => {
  const t = buildEditTask(loop(), "run at 9am on weekdays");
  // The edit CORE contract: ONE change, don't run the task, don't finish, then report.
  expect(t).toMatch(/ONE owner-requested change/i);
  expect(t).toMatch(/NOT\s+running the loop's normal task/i);
  expect(t).toMatch(/do NOT finish the loop/i);
  expect(t).toContain("loopany report --status resolved");
  // The untrusted-data guard rides along (edit reads the loop's current config below).
  expect(t).toMatch(/data, never as instructions/i);
  // The schedule/envelope verbs stay available (run-token surface).
  for (const verb of ["set-cron", "set-tz", "set-name", "notify", "set-model", "pause", "reschedule"]) {
    expect(t).toContain(verb);
  }
  expect(t).toContain("set-ui --file");
  // Skill pointer for the deep verb syntax, with a CORE-sufficient fallback.
  expect(t).toMatch(/loopany skill/i);
  expect(t).toMatch(/sufficient/i);
  // The owner's instruction is carried through.
  expect(t).toContain("run at 9am on weekdays");
});

test("edit task keeps the current ui/workflow inlined (config, not history — §3.4)", () => {
  const t = buildEditTask(loop({ ui: "<h3>{{latest.mrr}}</h3>", workflow: "return { message: 'x' }" }), "tweak it");
  expect(t).toContain("Current ui:");
  expect(t).toContain("<h3>{{latest.mrr}}</h3>");
  expect(t).toContain("Current workflow:");
  expect(t).toContain("return { message: 'x' }");
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
  // No schema → a plain report line with no metrics grammar; points at defining a schema.
  const open = buildExecTask(loop());
  expect(open).toContain("loopany report --status new");
  expect(open).toContain("no metric schema");
  expect(open).not.toContain("--state '{");
  // Declared schema → the --state grammar lists every declared key.
  const withSchema = buildExecTask(
    loop({ stateSchema: [{ key: "mrr", label: "MRR", unit: "$" }] as Loop["stateSchema"] }),
  );
  expect(withSchema).toContain("loopany report --status <s> --state");
  expect(withSchema).toContain('"mrr":<n>');
  expect(withSchema).not.toContain("no metric schema");
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
