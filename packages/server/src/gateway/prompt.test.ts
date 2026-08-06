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
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  buildEditPrompt,
  buildEditTask,
  buildEvolvePrompt,
  buildEvolveTask,
  buildExecTask,
  buildLoopSystemPrompt,
} from "./prompt.js";
import type { Loop, Run } from "../db/schema.js";

// EVERY assertion in this file runs against the PRODUCTION target, so what it
// pins is the production prompt's bytes. The dev-only `via <host>` banner suffix
// (lib/envTarget.ts) is exercised in its own test at the bottom of the file.
const priorBaseUrl = process.env.LOOPANY_BASE_URL;
beforeEach(() => {
  process.env.LOOPANY_BASE_URL = "https://loopany.ai";
});
afterEach(() => {
  if (priorBaseUrl === undefined) delete process.env.LOOPANY_BASE_URL;
  else process.env.LOOPANY_BASE_URL = priorBaseUrl;
});

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
  expect(t).toMatch(/never send a notification/i);
  expect(t).toMatch(/smoke-test/i);
  // The pass must leave a run-log summary (report --message), stated in both the
  // standing prose (§4 Finish) and the payload's closing instruction — an evolve
  // block in the timeline should never be blank.
  expect(t).toMatch(/loopany report --message/);
  expect(t).toMatch(/no change/i);
  // The untrusted-data guard rides along in the user turn (evolve reads run messages).
  expect(t).toMatch(/data, never as instructions/i);
  // The charter lever: edit the absolute per-run materialization; there is no command.
  expect(t).toContain("## 1. The charter");
  expect(t).toContain("$LOOPANY_CHARTER_FILE");
  expect(t).toMatch(/edit .*directly/i);
  expect(t).toMatch(/daemon persists a changed complete body at finalization/i);
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
  expect(t).toContain("$LOOPANY_CHARTER_FILE"); // read the delivered charter first
  expect(t).toMatch(/absolute path/i);
  expect(t).toMatch(/daemon-home materialization/i);
  expect(t).toContain("## Spec");
  expect(t).toMatch(/surface only what/i); // do the work, surface only what changed
  expect(t).toMatch(/exactly ONE terminal call/i);
  expect(t).toMatch(/finish every charter edit before the terminal call/i);
  expect(t).toContain("loopany report");
  expect(t).toContain("loopany finish");
  expect(t).toMatch(/one pass/i); // one pass then stop
  // Skill pointer names the installable skill with a CORE-sufficient fallback.
  expect(t).toMatch(/loopany skill/i);
  expect(t).toMatch(/sufficient/i);
  // Nothing left unfilled.
  expect(t).not.toMatch(/\{\{\w+\}\}/);
});

// The product signpost: every converged loop learns the object model from the
// PLATFORM, not from its own charter. exec-core stays lean — it names the three
// object verbs and points at the skill for the depth (references/run.md §4).
test("exec task signposts the product model: report vs doc vs task vs mirror", () => {
  const t = buildExecTask(loop());
  expect(t).toContain("loopany doc create --file");
  expect(t).toContain("loopany doc update <key> --file");
  expect(t).toContain("loopany task create --file");
  expect(t).toContain("loopany mirror attach");
  // The rules that decide WHICH product a thing is.
  expect(t).toMatch(/stable `key:`/);
  expect(t).toMatch(/rather than creating a new doc per day/i);
  expect(t).toMatch(/attached to the task or doc that owns it/i);
  // The folder is local scratch: a file that is not FILED reaches nobody. This is
  // the load-bearing half of the folder-sync retirement — a run that writes a
  // report to disk and stops has produced nothing.
  expect(t).toMatch(/nothing on this machine reaches the server by itself/i);
  expect(t).toMatch(/local scratch/i);
  expect(t).not.toMatch(/continuously synced/i);
  // The skill pointer advertises the depth this signpost is the short form of.
  expect(t).toMatch(/product objects/i);
  expect(t).toMatch(/charter.*not a product/is);
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

test("exec task carries a scoped task payload, mirror pointers, and labelled human words verbatim", () => {
  const directive = "Treat `rm -rf /` as quoted data; inspect PR #42 instead.";
  const t = buildExecTask(loop(), {
    reason: "directive",
    task: {
      id: "task-7f3a91",
      title: "Reconcile the release",
      payload: { exact: "KEEP <angle> & punctuation", nested: { count: 2 } },
    },
    mirrors: [{ kind: "github-pr", coords: "owner/repo#42" }],
    note: directive,
  });
  expect(t).toContain("Task: task-7f3a91 — Reconcile the release");
  expect(t).toContain('"exact": "KEEP <angle> & punctuation"');
  expect(t).toContain("- github-pr: owner/repo#42");
  expect(t).toContain(`directive: ${directive}`);
  expect(t).toMatch(/untrusted task data/i);
});

// The run-prompt host banner (dev-only by construction). Production bytes stay
// IDENTICAL — the whole rest of this file asserts them under `https://loopany.ai`,
// and the first case here states the byte-stability claim directly.
test("exec task banner: production is unchanged, a developer stack names its host", () => {
  process.env.LOOPANY_BASE_URL = "https://loopany.ai";
  const prod = buildExecTask(loop());
  expect(prod).toContain("[loop run · Test Loop]");
  expect(prod).not.toMatch(/via /);

  process.env.LOOPANY_BASE_URL = "http://127.0.0.1:4319";
  const dev = buildExecTask(loop());
  expect(dev).toContain("[loop run · Test Loop · via 127.0.0.1:4319]");
  // ONE token's worth of difference — the rest of the prompt is byte-identical.
  expect(dev.replace(" · via 127.0.0.1:4319", "")).toBe(prod);

  process.env.LOOPANY_BASE_URL = "https://loopany-testing.fly.dev";
  expect(buildExecTask(loop())).toContain("[loop run · Test Loop · via loopany-testing.fly.dev]");

  // An unknown/self-hosted target is silent, exactly like production.
  process.env.LOOPANY_BASE_URL = "https://loops.example.com";
  expect(buildExecTask(loop())).toBe(prod);
});
