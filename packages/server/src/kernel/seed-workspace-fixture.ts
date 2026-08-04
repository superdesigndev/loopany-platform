/**
 * A LOCAL FIXTURE for driving the workspace screens in a browser.
 *
 *   pnpm --filter @loopany/server workspace:seed
 *
 * It writes through the kernel (`createObject` / `applyUpdate` /
 * `applyTransition`), never raw SQL, so every row it makes carries the same
 * events, diffs and provenance a real run would leave — which is the whole point
 * of seeding rather than mocking: the screens are then exercised against real
 * shapes, including the event timeline and the charter diff.
 *
 * pglite is single-writer, so run this BEFORE starting the dev server against
 * the same `LOOPANY_DATA_DIR`.
 *
 * Content covers: two loops, a task in each of the three archetypal lives, a
 * task HANDED OFF between the two loops (the one remaining graph edge), tasks
 * that are due and not-yet-due, the near misses that must stay OUT of the inbox
 * (which is now the question branch alone), one markdown doc and one html doc,
 * and a run history.
 *
 * EVERY TASK IT WRITES NAMES A WATCHER, because every task in the system does
 * (`kernel/types.ts` WATCHER_HINT). The kernel would refuse an unwatched one, so
 * this is not a convention the fixture keeps by hand — it could not break it.
 */
import { db, runMigrations } from "../db/index.js";
import { runs } from "../db/schema.js";
import { applyTransition, applyUpdate, createObject } from "./applyTransition.js";
import * as store from "../db/kernelStore.js";
import type { Actor } from "./types.js";

const TEAM = process.env.LOOPANY_SEED_TEAM ?? "team-shared";
const HUMAN: Actor = { entrance: "human", actorId: "u-fixture" };
const agent = (runId: string): Actor => ({ entrance: "agent", actorId: runId });

const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const ahead = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

async function object(input: Record<string, unknown>): Promise<string> {
  const result = await createObject({ teamId: TEAM, actor: HUMAN, now: ago(200), ...input } as never);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.object.id;
}

async function main() {
  await runMigrations();

  const housekeeper = await object({
    kind: "loop", key: "fixture-housekeeper", title: "Housekeeper", cron: "0 7 * * *",
    body: "You are the Housekeeper.\n\nEach morning: sweep the repo, open one PR at a time, and file a task for anything you could not verify yourself.\n",
  });
  const steward = await object({
    kind: "loop", key: "fixture-followup", title: "FollowUp", cron: "30 8 * * *",
    body: "You are FollowUp — the loop other loops hand verification work to.\n\nWork the tasks you watch: verify the ones that have come due, close what is done, and ask when you cannot tell.\n",
  });

  // The charter history the loop page renders: one evolve pass, by a run.
  await applyUpdate({
    objectId: housekeeper, actor: agent("run-evolve-01"), now: ago(26), eventKind: "charter-evolved",
    fields: { body: "You are the Housekeeper.\n\nEach morning: sweep the repo, open one PR at a time, and file a task for anything you could not verify yourself.\n\n## Lessons\n\n- Never stack a second PR while the first is unmerged.\n" },
  } as never);

  // Life 1 — fully automatic: watched, due later, never asks.
  await object({
    kind: "task", key: "fixture-pr-201", title: "Observe the impact of PR #201", createdByLoop: housekeeper, createdByRun: "run-hk-0731",
    watcher: steward, followUpAt: ahead(20), now: ago(28),
    payload: { pr: "superdesigndev/loopany-platform#201", merged_at: ago(27) },
    body: "PR #201 halves the dashboard payload. Watch error rate and p95 for three days before calling it good.\n",
  });

  // Life 2 — born gated: created WITH a question, watched by its creator.
  await object({
    kind: "task", key: "fixture-reddit", title: "Reddit reply to r/selfhosted", createdByLoop: housekeeper, createdByRun: "run-hk-0731",
    watcher: housekeeper, pendingQuestion: "post as drafted, or soften the pitch?", now: ago(9),
    payload: { subreddit: "selfhosted", parent: "t1_abc123", draft: "We built Loopany because cron jobs cannot read a diff. Happy to answer setup questions." },
    body: "They asked how people run scheduled agents without a hosted runner. Our answer is on-topic and the sub allows self-promo in replies.\n",
  });

  // Life 3 — automatic until an anomaly made a run attach a question.
  const anomaly = await object({
    kind: "task", key: "fixture-error-rate", title: "Watch the error rate after #198", createdByLoop: housekeeper, createdByRun: "run-hk-0730",
    watcher: housekeeper, followUpAt: ago(2), now: ago(52),
    payload: { errorRate: { before: 0.004, after: 0.009 }, dashboard: "https://example.invalid/errors" },
    body: "Routine verification of #198. Three clean days closes it.\n",
  });
  await applyUpdate({
    objectId: anomaly, actor: agent("run-hk-0803"), now: ago(3),
    fields: { pendingQuestion: "error rate doubled since #198 landed — (a) revert (b) give it one more day" },
  } as never);

  // Watcher DEFAULTED to the creating loop: neither of these names one, so the
  // kernel put the Housekeeper on the hook for its own work.
  await object({ kind: "task", key: "fixture-faq", title: "Draft the pricing FAQ", createdByLoop: housekeeper, followUpAt: ago(4), now: ago(30), body: "Three support threads asked the same question about seat pricing.\n" });
  await object({ kind: "task", key: "fixture-nodate", title: "Reply to the packaging thread", createdByLoop: housekeeper, now: ago(80), body: "Watched, but with no follow-up date: nothing wakes its loop for this one, so it waits for the loop's own cadence to pick it up.\n" });

  // Near misses — visible in the task list, never in the inbox.
  await object({ kind: "task", key: "fixture-watched-due", title: "Verify the nightly backup", createdByLoop: housekeeper, watcher: steward, followUpAt: ago(5), now: ago(40) });
  await object({ kind: "task", key: "fixture-fresh", title: "Skim today's issue queue", createdByLoop: housekeeper, now: ago(2) });

  const closed = await object({ kind: "task", key: "fixture-closed", title: "Ship the docs typo fix", createdByLoop: housekeeper, now: ago(120), body: "One-line fix, merged.\n" });
  await applyTransition({ objectId: closed, transition: "close", actor: agent("run-hk-0729"), now: ago(100), note: "Merged as #197; nothing left to watch." } as never);

  // A HAND-OFF: the Housekeeper filed it (so it started on its own desk) and a
  // later run transferred it to FollowUp. Transfer is the surviving watcher
  // write — release is gone — and it is what draws the graph's `hands-off` edge.
  const handed = await object({ kind: "task", key: "fixture-handed-off", title: "Chase the flaky machine-poll test", createdByLoop: housekeeper, now: ago(34) });
  await applyUpdate({ objectId: handed, actor: agent("run-fu-0803"), now: ago(24), fields: { watcher: steward, followUpAt: ahead(48) } } as never);

  await object({
    kind: "doc", key: "fixture-report", title: "Housekeeper — daily report", format: "markdown", createdByLoop: housekeeper, createdByRun: "run-hk-0803", now: ago(3),
    body: "# Housekeeper — 07:00\n\nHanded off **2**, closed **3**, asked **1**.\n\n| what | count |\n| --- | --- |\n| PRs opened | 1 |\n| tasks closed | 3 |\n\n> The error rate on #198 doubled overnight; a question is waiting in the inbox.\n\n<script>alert('this raw HTML must not render')</script>\n",
  });
  await object({
    kind: "doc", key: "fixture-board", title: "Weekly board (html)", format: "html", createdByLoop: steward, now: ago(6),
    body: `<!doctype html><style>body{font:14px/1.5 system-ui;margin:0;padding:18px;background:#fff}h1{font-size:16px;margin:0 0 12px}.card{border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin-bottom:8px}#probe{margin-top:14px;padding:8px 10px;border-radius:6px;background:#f6f6f6;font:12px ui-monospace,monospace}</style><h1>Weekly board</h1><div class="card">Handed off 2 · closed 3 · asked 1</div><div class="card">Oldest open task: 80h</div><div id="probe">containment probe running…</div><script>
      // A doc's script runs — in an OPAQUE origin. Both of these must fail.
      var cookie = 'unreadable';
      try { cookie = document.cookie === '' ? 'empty (opaque origin)' : 'READABLE — CONTAINMENT BROKEN'; } catch (e) { cookie = 'threw: ' + e.name; }
      var parentReach = 'unreachable';
      try { parentReach = parent.location.href ? 'READABLE — CONTAINMENT BROKEN' : 'blocked'; } catch (e) { parentReach = 'blocked (' + e.name + ')'; }
      document.getElementById('probe').textContent = 'origin: ' + String(location.origin) + ' · app cookies: ' + cookie + ' · parent.location: ' + parentReach;
    </script>`,
  });

  const history = [
    { id: "run-hk-0803", loopId: housekeeper, at: 3, state: "success" as const, summary: "Handed off 2, closed 3, asked 1.", cost: 0.62 },
    { id: "run-hk-0802", loopId: housekeeper, at: 27, state: "failure" as const, summary: "gh auth expired mid-sweep", cost: 0.08 },
    { id: "run-hk-0801", loopId: housekeeper, at: 51, state: "success" as const, summary: "Opened PR #201.", cost: 0.71 },
    { id: "run-fu-0803", loopId: steward, at: 24, state: "success" as const, summary: "Verified 1 hand-off, closed it.", cost: 0.19 },
  ];
  for (const run of history) {
    await db.insert(runs).values({
      id: run.id, loopId: run.loopId, userId: "u-fixture", machineId: "m-fixture",
      phase: run.state === "success" ? "done" : "error", role: "exec", ts: ago(run.at),
      queueState: run.state, scope: "routine", reason: "clock", entrance: "clock",
      startedAt: ago(run.at), finishedAt: ago(run.at - 0.05), outcomeSummary: run.summary, costUsd: run.cost, attempts: 1,
    } as never).onConflictDoNothing();
  }

  const tail = await store.getObject(undefined, housekeeper);
  console.log(`seeded team ${TEAM}: loops ${housekeeper} / ${steward} (charter updated ${tail?.updatedAt})`);
  console.log("open http://127.0.0.1:3000/dev/workspace");
}

await main();
process.exit(0);
