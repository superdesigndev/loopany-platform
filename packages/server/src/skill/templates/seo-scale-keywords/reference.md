# SEO - Scale Proven Keywords — template reference (the Engine)

On-demand reference for the seo-scale-keywords template. Fetched by the setup agent at
`<server-url>/api/skill/references/templates/seo-scale-keywords/reference.md` — it does
NOT ride in the paste prompt. This is the full task-file TEMPLATE to author the loop's
README from: copy it into the loop folder, fill every `<FILL: …>`, delete the SETUP
block once every box is ticked, then enable.

---

## SEO Engine (TEMPLATE)

This is a TEMPLATE loop. It is paused and will not fire. Everywhere you see `<FILL: …>` is a decision you must make. The pre-run workflow counts those markers and refuses to escalate to the agent while any remain, so a half-configured clone cannot ship anything. Fill them, delete the SETUP block, then `loopany edit <id> --json '{"enabled":true}'`.

Distilled from two live production fleets (running since 2026-07-05). Updated 2026-07-29 with the doctrine the fleet validated: an engine is earned (a bet-manager day-7 SCALE verdict — see the companion seo-try-keywords template) and sunsets itself by proposal (§Lifecycle); position is scored on the DAILY series, never a trailing window (§2); merged is not live (§2b); and the report files before any long blocking step (§runtime gotchas).

## SETUP — delete this whole block once every box is ticked

- **Earn the engine before you clone it.** An engine exists per bet, and a bet must be proven first: it cleared the qualifying bar of your bet-manager loop (clone of the companion seo-try-keywords template — clone that one FIRST on a new site), entered the bet ledger with a one-line thesis, and got a day-7 SCALE verdict on the daily series. No SCALE verdict → no engine; the bet stays with the bet manager. This is the gate that keeps engine count flat — the fleet's bottleneck is the human merge gate, so never spawn a producer an unproven bet doesn't pay for.
- Copy this folder to `<your-repo>/loopany/<your-slug>/` and point taskFile at it.
- **Repoint the workflow at YOUR README.** The pre-run workflow reads the task file by absolute path, held in a TASK constant at the top of its body — nothing passes it the loop's taskFile. A clone that skips this reads the template master forever: the gate blocks on the master's unfilled markers no matter how complete your own file is. Fix: edit TASK, then `loopany set-workflow --file <path>`. The gate message prints the path it read, so check it against your clone's README on run 1.
- GSC access works. You have a script that returns query-dim and page-dim rows for `sc-domain:<FILL: yourdomain.com>`. Run it once by hand before enabling.
- Pick the regime (§Regime below). Delete the branch you are not in.
- Name your breadwinner — the page earning ≥30% of clicks. If you don't know it, you are not ready; run your bet-manager loop for a week first.
- Write your fan-out carve-out — the query families that will never click. Do this BEFORE run 1 or the KPI will lie to you (§4).
- Name the sibling loops and their carve-outs, or write "none yet."
- Decide the ship lane — PR-only (start here) or auto-apply (earn it later, §10).
- Replace every remaining `<FILL: …>`. The workflow will tell you how many are left.

Copy-drift is the accepted price. This template is copy-based: doctrine changes to the master do NOT propagate to clones. At ≤3 live engines, hand back-port the change to each clone the day it lands — that is cheaper than any retro/collector machinery. If the fleet ever grows past 3 live engines, revisit; not before.

## Spec

Mission: `<FILL: own head term X / grow clicks on surface Y>` for `<FILL: brand>`. The reader's next step is `<FILL: the funnel destination — course, signup, newsletter>`.

Site: `sc-domain:<FILL: yourdomain.com>` · Repo: `<FILL: /abs/path/to/content/repo>` · Content lives in: `<FILL: content/blog/*.md>`

Runs `0 9 * * *` — `<FILL: staggered off which sibling loops, so GSC load and the repo working tree don't collide>`.

This is an OPEN monitor, not a closed loop. No goal, no `loopany finish`. Each run reports the score against its target and flags movement in or out of it; it never self-completes. If runs degenerate into measure-and-skip with nothing to ship, slow the cadence rather than forcing thin work.

## Regime — pick ONE, delete the other

The single most consequential decision in the file. Scoring an emerging term on clicks tells the loop to abandon the land-grab exactly as the ground becomes valuable; scoring a mature page on position lets a page rank at pos 6 and convert 0.5% for a month with nothing marking it a failure.

**[ ] LAND-GRAB** — the head term is emerging, the SERP is thin, demand is still forming.

- North star: exact-head position (hold ≤3) + family footprint (how many family queries you rank for, and the impressions they throw).
- Default per-run unit: ship ONE new cluster article.
- Clicks are demoted to a graduation tripwire (`kpi_clicks_28d`): when the term starts throwing real click volume it has matured — that is the trigger to shift weight toward conversion, not a per-run score.
- Regime-flip gate (computable — state these three numbers in EVERY run report): flip to HARVEST when `family_top3_share ≥ 85%` AND `family_queries` grew <10% vs the prior run AND `family_weak ≤ 2`. Until all three hold, stay in land-grab. Never re-argue the regime from a vibe.
- Emit all three as METRICS, not just prose — `family_top3_share`, `family_queries`, `family_weak` are in the state schema. "Grew <10% vs the prior run" is a comparison against the last run's number; if it only ever lived in a Timeline sentence, every run re-reads prose to recover it and the gate quietly softens into a vibe. Reported, the dashboard does the diff for you.

**[ ] HARVEST** — pages are live, demand is established, the job is earning the clicks.

- North star: `kpi_clicks_28d`. Position is a diagnostic, kept for trend continuity; it does not decide the work.
- Default per-run unit: one enrichment on the highest click-opportunity page.
- The KPI's successor is `<FILL: clicks → signups, or whatever your real conversion is>`. It is currently not instrumented because `<FILL: why>`. Do not fake it from what GSC can reach.
- Trim the schema: `family_queries` and `family_weak` are land-grab instruments for the flip gate. In HARVEST they decide nothing — drop them via `loopany set-schema` so runs aren't told to report numbers you don't use (and the dashboard isn't half blank). Keep `family_top3_share` only if you still track footprint.

## Lifecycle — every engine ends; sunset is a proposal, never a self-execution

Keywords have lifecycles: scout bet → day-7 SCALE → land-grab → flip gate → harvest → sunset. The spawn end is the SETUP block's first checkbox. The sunset end is this engine's own job to detect and propose:

- Propose your own closing when either holds:
  - Flatline: the KPI has been flat for 21+ consecutive daily reads with zero unmerged PRs pending (unmerged PRs make flat EXPECTED — §2b — so they suspend the clock, not the engine), OR
  - Migration: the daily series shows demand visibly moving to a successor term — your family's impressions decaying while a sibling phrasing's grow.
- The proposal is a flagged run report, not an action: name the trigger with the numbers, the successor term if one is visible, and the recommended disposition of your pages. Never pause yourself, never stop shipping while the proposal is open — the human ticks it.
- On the ticked close: the loop is paused, its pages fold into the enrichment loop's scope (update the enrichment carve-out list the same day), the ledger records the verdict and the successor, and the successor term goes back to the scout as a brand new bet — it does not inherit this engine.

## ⚠️ Carve-out — query families that score zero BY DESIGN. Do NOT optimize these away.

`<FILL: list your verified non-clicking families with real numbers>`

Four categories to screen against before calling any page a CTR problem:

1. LLM fan-out — an assistant decomposed a user's question into sub-searches. There is no human to click. Ranking well here means assistants are citing you; it is a win that scores zero forever.
2. Competitor-navigational — "<thing> by <competitor>" means they want the competitor's own site. Unwinnable.
3. Brand-navigational — your homepage should win it, not this page.
4. Anonymized tail — a page whose visible impressions are <10% of its total is undiagnosable. Leave it.

Never delete, retitle, or count these against a page. They belong on your bet-manager loop, not here.

## Scope

Owns: `<FILL: which pages>`. NEVER touches: `<FILL: enumerate the sibling loop's slugs — the carve-out list. Include your crown-jewel page if another loop actively edits it.>`

Standing coordination check, before editing ANY page: grep `../<FILL: sibling>/reports/` and `git log --oneline -20` for a branch touching that slug in the last 7 days. If touched, skip it. Two loops editing one page destroys attribution.

## Each run, in order

**0. Reconcile state against the LIVE system.** `<FILL: what drifts — draft status: vs live URLs, a published ledger, whatever your setup hand-maintains>`. Key on URL, not title — titles get rewritten at publish. If drift is non-empty, fix it FIRST; every later step is meaningless on a false world model. Emit `status_drift_found` (should be 0).

**0b. Verification ledger — the ship is not the outcome.** Every change this loop applied carries `applied: YYYY-MM-DD` and `verify_after: <applied + 14d>` in its front matter. For each whose `verify_after` has passed and isn't yet `verified:`, pull that page's clicks 7d-after vs 7d-before the apply date. If a page with real HUMAN traffic dropped >30%, flag a REVERT recommendation — name the change, the page, the numbers, and the exact commit/PR to revert. Never revert yourself. Otherwise stamp `verified: YYYY-MM-DD ok`. An applied change that was never verified is an open loop, not a done item. Land-grab variant: also check (a) did the shipped article's target family form? near-zero after ~4 weeks → flag REFRESH or MERGE-into-pillar; (b) did it hurt the pillar? head position degraded >2 AND page-dim shows the new page absorbing the pillar's queries → flag CONSOLIDATION.

**1. Read state.** This file's `## Current understanding` + the last `## Timeline` entry, `<FILL: the pillar's current target keywords / your live-page list>`, and `git log --oneline -20`. Never re-ship a keyword already covered or in flight.

**2. Read the score.** `<FILL: your GSC command, or "pre-staged by the workflow">`. Do NOT re-pull data the pre-stage already fetched — that is the single largest cost sink a loop like this has. Query yourself only for a follow-up your judgment actually needs, or if the staged block carries an error. Report the KPI and its movement vs the last Timeline entry. Bind each metric explicitly — a mis-bound key (page-dim total where the exact-query number was meant) spiked one real dashboard 10×.

Position is read on the DAILY series — never a trailing window. Score head-term position as a 3-day median of daily values against alert bands (ok / watch / slipping / critical). A 7d or 21d blend once reported "SCALE confirmed" while the head term slid from pos 1.4 to 7.06 across those same seven days — trailing averages hide slides by construction. Two GSC gotchas when reading the daily series: zero-impression days report position 0 (exclude them, never average them in), and the most recent 1-2 days are preliminary and noisy — treat them as provisional, don't band-trip on them alone.

**2b. Check deployment.** Count THIS loop's unmerged PRs (`prs_unmerged`). An unmerged article is not live — it cannot rank or pass link equity. While any are unmerged, a flat position is EXPECTED, not failure, and not grounds for a strategy change. Always surface the count; merging is the human's call, never the loop's. And merged is not live either. For anything merged since the last run, verify the production URL serves 200 before counting it shipped. Only `<FILL: the production deploy check that matters>` decides; a pending-then-failed deploy is usually transient infra — reproduce the build locally before blaming the content.

**2c. Canary + cooldowns — a winning page is production.** The breadwinner is `<FILL: slug>`, currently `<FILL: %>` of clicks (any page ≥30% qualifies).

- Canary: breadwinner position drop ≥3, or clicks drop >30% window-over-window → flag it FIRST in the notify and queue NO edits against it today.
- Cooldowns: breadwinner 14 days, every other live page 7 days since its last queued or applied edit. One edit per page per window, so step 0b can attribute the before/after cleanly. A page inside its cooldown is off-limits even for a "small" tweak — route the idea elsewhere or hold it.
- It is correct to leave clicks on the table rather than perturb the page that earns half of them.

**3. Pick the run's unit from the regime**, and log WHICH and WHY the data picked it. Improvement menu, roughly by leverage:

- Link equity — one contextual, intent-matched link from a high-impression page INTO the page you're compounding. When your winner is position-limited rather than snippet-limited, this is the highest-leverage move available, and it's not on the page itself.
- Query-match the title / H1 / meta to the exact human query the page ranks for but never names. Highest-leverage pure-CTR fix.
- Fresh PAA FAQ in question-form heading + a tight extractable answer.
- Tighten the answer into the first 30% so the snippet matches intent.
- Extraction structuring — definition block, honest JSON-LD, question headings.
- Step-0b follow-through — execute a refresh/consolidation a verification flagged.

Double-down beats breadth. One page earning ~45% of clicks is normal, not a problem to diversify away. Compound the winner first; breadth gets the day only after.

**4. Screen the candidate for HUMAN intent before touching it.** Pull its query mix and apply the four carve-out categories above. Non-human → drop to the next candidate. Do not "fix" a sink that has no human in it.

**5. Mine the freshness gap.** Grounding only on your own pages and your own GSC is a closed loop: it produces internal reshuffles that never move an unwon term. Order, every research run:

1. `<FILL: the owner's own curated stream — bookmarks, saved links, reading list>`. FIRST, not optional — this is the freshest signal you have and it's often where the term shift itself shows up before it's anywhere else.
2. Broad agent research — trending repos + releases, threads and framings from the last ~2 weeks.
3. A last-30-days sweep as ONE corroborating input.
4. Diff → gap. Grep your own pages; the delta IS the target. Cite the source in the report.

Saturation cooldown: do not re-mine a topic that already read saturated within 14 days. Saturation is a valid steady state, not a shortfall. Timeout gotcha: broad-topic research skills routinely time out (2–5 min) — drop straight to a scoped WebSearch, don't re-run hoping it finishes.

**6. Gates — ALL must hold, or ship nothing.**

- Cannibalization pre-check. Query GSC by page for the head term you intend to target. If one of your own pages already ranks pos <15, do NOT target it with a new page — you'd split your own click equity. Pick a long-tail the existing page doesn't own, and link to it instead of competing.
- The CTA test. Answer in writing: "What will the reader DO after this?" If the honest answer is "close the tab," it fails — no matter how emerging or rankable. Record the answer in the report and the PR body.
- Fact-check gate. The moment you assert a NEW verifiable specific — a CLI flag, env var, param, default, version behavior, price — verify it against a primary source THIS RUN and record the doc URL in the PR. Grounding in the page's own existing body is NOT verification — the body can be stale. A wrong flag in a query-targeted FAQ actively misleads the exact searcher you're trying to win.
- Queue gate. If `queue_depth ≥ <FILL: 4 — one week of your publish capacity>`, SKIP the drafting step entirely, including the research, and put the run into improvement. Drafting onto a blocked queue is batch-crank.
- Voice gate. A queued note's prose is a brief, not final copy. Re-read it against `<FILL: your voice rules>` at apply time.
- Quality valve. If nothing clears the bar, ship nothing and log "no qualifying candidate" with the rejected options and why. Thin pages actively hurt the pillar.

**7. Ship.** `git fetch origin main` and branch off `origin/main`, never local main (local goes stale between runs, and a stale base means you dedupe against pages that have since changed). NEVER commit to main. PR body carries: the target, the evidence, the GSC numbers, the CTA answer, the exact before→after, and the primary-doc URL you fact-checked. Stamp `applied:` / `verify_after: <+14d>` on whatever ships.

Repo-hygiene variant — pick the one that matches reality:

- Repo is usually clean: assert `git status --porcelain` is empty on main, else skip and flag. A dirty tree drags unrelated changes into the PR.
- Repo is never clean: do NOT gate on a clean tree — that gate skips every run. Ship from an isolated worktree: stage your single-file change as a patch, `git worktree add -b <branch> /tmp/<slug>-wt origin/main`, apply, commit, push, PR, remove the worktree, restore the file.

**8. Report + notify.** Write `reports/YYYY-MM-DD.md` with flat front matter — `type:` one of `shipped | improved | skipped | flagged`, `title:` what the run did, `date:`. Append a dated `## Timeline` entry here. Emit the state metrics. Notify with what changed, what's queued, and any flag: KPI fell vs last run, drift found, canary tripped, a REVERT recommendation, or nothing cleared the gate for 3+ runs.

## HARD RULES

- Never auto-publish `<FILL: long-form / anything human-gated>`. Never commit to main.
- Never fabricate a metric, quote, or testimonial — use `[NEED: …]` placeholders.
- Never date-bump without a real change (artificial freshness is a ranking risk). But DO bump `dateModified` when the change IS real — Google defines it as the date the article was last genuinely modified.
- Never target a head term one of your own pages already ranks pos <15 for.
- Respect the cooldowns. One edit per page per window.
- Keep heavy work OUT of this synced folder — worktrees, clones, node_modules, build output go in a temp dir; only the finished report lands here.

## AUTO-APPLY LANE — leave OFF until the safety nets have run for a few weeks

Start PR-only. Earn this later. Once §0b (verification ledger) and §2c (canary + cooldowns) are genuinely running, a change may apply itself without a human iff ALL hold:

- It is a small additive enrichment — an FAQ, a title/description fix, an internal link, honest JSON-LD. Never a long-form draft, a retitle-of-intent, a deletion, or a structural rewrite.
- The target is not the breadwinner and is outside its cooldown.
- The production build passes locally after the change. Build fails → nothing ships, the change stays queued.
- At most ONE auto-apply per run.

Anything failing a condition stays queued and gets flagged. Fail-safe is always "leave it queued," never "force it."

## Current understanding

Seed this before run 1, and never let a run leave it stale. This section — not the automation — is where the compounding lives. A loop that re-derives its conclusions every run is just an expensive cron job.

- Baseline (set `<FILL: date>`): KPI = `<FILL: n>`, head position = `<FILL: n>`, breadwinner = `<FILL: slug>` at `<FILL: %>`.
- Verified non-human sinks — do NOT re-triage: `<FILL: the pages you have already confirmed are fan-out / brand-nav / anonymized. Every run will otherwise rediscover them.>`
- Ruled out, and why: `<FILL: candidates you rejected, so a future run doesn't re-pitch them. This is half the value of the file.>`
- Ledger of applied changes: `<FILL: what shipped, when, its verify date, its verdict.>`
- Environment gotchas: `<FILL: the API that returns stderr on stdout, the script whose JSON has no top-level key, the repo that's never clean. Each one costs a run to rediscover.>`

Three runtime gotchas that are true for every loop of this shape:

1. A scheduled run dies the instant the agent yields the turn. Backgrounded tasks and notification-waits die with it — "it will notify me when done" is FALSE in a scheduled run. Long steps must be blocking foreground calls.
2. A long blocking run can still lose its lease if the machine sleeps. Keep runs short, chunk anything lengthy, and consider caffeinate.
3. The report files BEFORE any long blocking step, then gets appended. A reclaimed run loses everything not yet on disk: a machine-asleep reclaim once ate six Monday loops' run messages, and the on-disk reports were all that survived. So write `reports/YYYY-MM-DD.md` with the score, the state metrics, and the intended unit as soon as §2 completes — before research skills (2-5 min timeouts), polls, or builds — and append the outcome at the end. A week of metrics must never depend on the run finishing.

## Timeline

`<FILL: YYYY-MM-DD>` | Template cloned. Baseline not yet set — run the bet manager first.
