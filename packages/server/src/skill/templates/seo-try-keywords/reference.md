# SEO - Try New Keywords — template reference (the Bet Manager)

On-demand reference for the seo-try-keywords template. Fetched by the setup agent at
`<server-url>/api/skill/references/templates/seo-try-keywords/reference.md` — it does
NOT ride in the paste prompt. This is the full task-file TEMPLATE to author the loop's
README from: copy it into the loop folder, fill every `<FILL: …>`, delete the SETUP
block once every box is ticked, then enable.

---

## SEO Bet Manager (TEMPLATE)

This is a TEMPLATE loop. It is paused and will not fire. Everywhere you see `<FILL: …>` is a decision you must make. Fill them, delete the SETUP block, then enable. If you attach a marker-gate pre-run workflow (recommended — copy the pattern from the engine template's loop), it refuses to run while any `<FILL:` remain.

Companion to the engine template (seo-scale-keywords). The two templates split the keyword lifecycle: this loop owns the edges — find a bet, open it, score it daily-series-honest, issue the SCALE / LEAVE verdict, kill or hand off — and an engine clone owns the middle (land-grab → flip gate → harvest → sunset proposal). Clone THIS one first: the engine template's earn-the-engine gate requires a verdict this loop produces, so on a new site the bet manager runs for weeks before any engine exists.

Distilled 2026-07-29 from two live production loops (a weekly scout running since 2026-07-06 and an emerging-keyword scorecard since 2026-07-24), including the scorecard's own recorded failure (the 2026-07-27 trailing-window misread) and the scout's window lessons (RC-lock, watchlist drop-dead). In production those are two separate loops; this template combines them because a new site starts with zero bets — separately each half idles for weeks, and combined, the verdict step naturally gates the mining step. If bet volume ever makes the weekly run unwieldy, split it back into scout + scorecard.

## SETUP — delete this whole block once every box is ticked

- Copy this folder to `<your-repo>/loopany/<your-slug>/` and point taskFile at it.
- If you attach a pre-run workflow, repoint its TASK constant at YOUR README by absolute path — a clone that skips this reads the template master forever (the engine template's known footgun; same fix: edit TASK, `loopany set-workflow`).
- GSC access works. A script returns query-dim, page-dim, and date-dim rows for `sc-domain:<FILL: yourdomain.com>`. The date dimension is non-negotiable — this loop's whole scoring doctrine is the daily series. Run it once by hand before enabling.
- Create the bet ledger at `<FILL: path, e.g. campaigns/content-plan/keyword-targets.md>` — one line per bet: term · one-line thesis · opened date · seed PR · verdict · verdict date. This file is the single source of truth the engine template's earn-the-engine gate reads.
- Name your winning archetypes and proven losers from ≥90 days of GSC page data (§Current understanding). No GSC history yet? Then you have no archetypes: leave the list empty and route EVERY candidate through the approval lane until real click data exists. Do not invent archetypes from theory.
- Name the funnel. The reader's next step after any seed article is `<FILL: course, signup, newsletter, community>`. Without this the CTA test can't run.
- Set the open-bet cap — default 2. More open bets than your human can merge seed PRs for is batch-crank.
- Pick the cadence — weekly, firing before the human's weekly review (`<FILL: cron, e.g. Mon 08:00 before a ~09:00 briefing>`) so the scorecard is fresh when they read it.
- Replace every remaining `<FILL: …>`.

Copy-drift is the accepted price (same rule as the engine template): doctrine changes to the master do NOT propagate. At ≤3 live clones, hand back-port the day a change lands.

## Spec

Mission: own the edges of the emerging-keyword lifecycle for `<FILL: brand>` on `sc-domain:<FILL: yourdomain.com>`. At most one new bet a week; every open bet scored on the daily series with an explicit verdict at day 7. This loop is a monitor that is allowed to ship exactly one thing: the seed article that gives a new bet its GSC signal. It never touches a tracked term's pages after the seed — that is engine / enrichment territory.

Repo: `<FILL: /abs/path/to/content/repo>` · Content lives in: `<FILL: content/blog/*>`

This is an OPEN loop. No goal, no self-completion. "No qualifying keyword this week" and "nothing to verdict this week" are both valid, loggable outcomes — never force a weak seed to have something to show.

Strict run order: SCORE first, MINE second. The verdicts and the open-bet count from Part A are the gate on Part B. A run must never open a new bet while it owes a verdict on an old one.

## Part A — Score (the scorecard half; reports, never acts)

**A1. Read state.** `## Current understanding` + the last `## Timeline` entry here, the previous report in `reports/`, the bet ledger, and — once engines exist — each engine clone's latest report (they score themselves too; you are the cross-check and the verdict authority, not a duplicate).

**A2. Pull LIVE GSC** — never a cached report file (the "check the external system, not the repo" rule). For each tracked term:

- The DAILY head-term position series — this is the score. Pull `dimensions:["date"]` twice, `dataState:"final"` and `"all"`. Compute the 3-day median of finalized days and the 5-day trend.
- Exact head-term clicks + impressions, last 7d and 28d, for week-over-week volume.
- Family footprint: distinct family queries ranking + total family impressions (query-dim contains "<term>", dropping unrelated-intent noise).

🔒 NEVER SCORE A TERM ON A TRAILING WINDOW. This template's parent loop learned it on 2026-07-27: the card reported a term at pos 2.75 and called "SCALE, confirmed" while the actual daily series was 1.42 → 1.56 → 2.27 → 3.70 → 4.86 with preliminary days at 5.33 and 7.06 — seven straight days of decline, clicks 553/day → 33/day. The 7d window didn't save it because the term was younger than the window: its whole life sat inside the average and the launch days masked the collapse. Shortening the window is not the fix; daily is. Bands on the 3-day median: 🟢 ok ≤3 · 🟡 watch ≤4.5 · 🔴 slipping ≤7 · ⛔ critical >7. Two GSC gotchas: zero-impression days report position 0 — exclude them, never average them in; the most recent 1-2 days are preliminary — show them, don't band-trip on them alone. A missing day is missing, never 0 — never write 0 for a failed read.

🔒 Family growth is NOT health. The same 07-27 card reported family footprint growing (35 → 83 queries) as a positive while the head term bled. That was the long tail filling in during a collapse. Never report family growth as the state of a term whose head position is falling — say "family up, head falling" explicitly, and the head is the story.

**A3. Week-over-week.** Diff every term against last week's report. Any term at 🔴/⛔ is the headline of the report, above shipped items and new bets.

**A4. What shipped.** `git log --oneline --since='7 days ago'` on the tracked terms' pages plus the engines' `reports/`. List merged units, and anything unmerged — an unmerged seed isn't live, can't rank, and suspends its bet's day-7 clock (a verdict on a bet whose seed never deployed measures nothing).

**A5. Verdicts — the whole point of Part A.** For every bet whose seed has been live 7+ days and has no verdict in the ledger, issue one, with the numbers behind it:

- SCALE — indexed, family impressions forming, position forming on the daily series → write it in the ledger and recommend spawning an engine (clone of the engine template, per its SETUP checklist). Never spawn it yourself; never scale silently. The human ticks it.
- LEAVE — dud (near-zero impressions, no family forming) → mark the bet closed in the ledger and record the one-line lesson (which part of the thesis failed). Never kill silently. The seed page stays live and folds into enrichment scope; do not delete pages.
- Borderline — a genuinely mixed read gets one 7-day extension, recorded in the ledger with what specifically you're waiting to see. One. A second borderline is a LEAVE.

**A6. Watchlist sweep.** Candidates that were emerging but not yet searchable sit on a watchlist with a drop-dead date. Re-check each against live GSC + a fresh SERP look. A dry item gets at most two re-checks; still dry on its drop-dead date → delete it and log why. Never carry a dry item a third week.

**A7. Write the report NOW — before Part B.** Part B contains the long research steps (2-5 min skill timeouts), and a reclaimed run loses everything not yet on disk. Write `reports/YYYY-MM-DD.md` (front-matter `type: scorecard`, `title:`, `date:`) in the briefing-ready shape below, and emit the state metrics the dashboard charts — `open_bets`, `bets_alerting`, `verdicts_issued`, `seed_prs_unmerged`, `watchlist_items` (with `seed_shipped` 0/1 updated after Part B; a failed read is MISSING, never 0) — then proceed. Append Part B's outcome to the same report at the end.

```
> [!todo]- 📊 SEO bet scorecard — week of <Mon date>
> | term | pos 3d (Δ wk) | daily trend | alert | clicks 7d (Δ) | family imp | state |
> |------|---------------|-------------|-------|---------------|-----------|-------|
>
> `pos 3d` = 3-day median of the DAILY series. `daily trend` = oldest→newest so a slide is
> visible at a glance. A term at 🔴/⛔ goes FIRST. Family up while head falls is not growth.
>
> **Verdicts:** <term> → SCALE (numbers) / LEAVE (numbers) / borderline +7d (waiting on X).
> **Shipped this week:** <merged>. **Unmerged (not live, clock suspended):** <…>.
> **New bet opened:** <term + one-line thesis + lane> / none — <why>.
> **Needs your eye:** <the 1-2 things — a slip, a SCALE to greenlight, a seed PR to merge>.
```

## Part B — Mine (the scout half; gated)

**B0. Mining gates** — if ANY holds, skip ALL of Part B including the research and log which gate closed the week:

- Open bets ≥ `<FILL: cap, default 2>`.
- Any open bet is inside its day-7 window with no verdict yet (you owe a verdict before you owe a new bet).
- ≥ `<FILL: 2>` seed PRs from this loop sit unmerged (drafting onto a blocked queue is batch-crank — the bottleneck is the human merge gate, not production).

**B1. Pick angles adaptively.** 4-6 research angles from what moved in `<FILL: your space>` this week — never the same angles as last run. React to the news.

**B2. Triage, then deep-dive.** Quick web-search each angle; run the heavy research only on the 2-3 with a live pulse. Sourcing order per the engine template §5: the owner's own curated stream first, then broad agent research tools, then a last-30-days sweep as one corroborating input, then diff against your own pages. Timeout gotcha: broad-topic research skills routinely time out — drop to a scoped WebSearch, don't re-run hoping.

**B3. Mine for the pattern.** A new term with search intent visibly forming ("what is X", "how to X") and no dedicated ranking content yet — prefer terms tied to a person, tool, file format, or convention that surfaced in the last ~30 days. Two window lessons, learned the hard way:

- The RC/beta lock date opens the window, not GA. A spec's content wave runs from when it locks; by GA the SERP can hold 10+ dedicated guides. Any pre-planned ship window must be re-checked for SERP fill in the run it comes due — never shipped on the old read.
- Emerging-but-unsearchable goes to the watchlist (with a drop-dead date), not to a seed article. No visible intent = no bet, however good the thesis feels.

**B4. Validate the one candidate:**

- GSC: are impressions already appearing on related queries?
- SERP: is a dedicated, well-optimized article already ranking? Drop it.
- Cannibalization: grep your own content AND live GSC page data — several "emerging" terms are usually already owned as ranking pages. Covered → it's refresh territory (route the finding to enrichment / the human), and a new article would split your own equity.
- Archetype: does it fit a proven winning archetype (§Current understanding)? And is it shaped like a proven loser (news/announcement, generic comparison)? Losers fail here no matter how emerging + rankable — that's GSC confirming the CTA test empirically.

**B5. The CTA test — hard gate, in writing.** "What will the reader DO after this?" If the honest answer is "close the tab," the keyword fails regardless of everything else. The searcher must be mid-workflow (setting up, building, adopting) with a native next step into `<FILL: your funnel>` — not a news consumer. Record the answer in the report and PR body.

**B6. Ship ONE seed, two lanes:**

- Archetype lane (autonomous): fits a proven archetype AND passes the CTA test → write the full article (`<FILL: your content skill/conventions>`; title leads with the bare noun phrase people actually type, not your internal framing), branch off `origin/main`, never commit to main, open the PR. PR body: the keyword, emergence evidence with numbers, SERP assessment, GSC data, the written CTA answer.
- Approval lane (everything else, and ALL bets while you have no proven archetypes): write the article to `drafts/<slug>.md` with front-matter `type: draft-pending-approval`, message the human with the pitch + path, and wait. At the start of every run check `drafts/`: approved → open the PR now; rejected → delete and log why.

Then register the bet in the ledger: term · one-line thesis (what you expect the day-7 read to show — a bet without a thesis can't be verdicted) · opened date · seed PR.

**B7. Notify.** One message: the headline of the scorecard, any verdict needing a tick, the seed PR link + one-line pitch (or which gate closed mining / why nothing qualified), and any drafts still pending from earlier runs.

## HARD RULES

- Never write the human's dashboard/inbox file (`<FILL: e.g. Inbox.md>` — it may be open in an editor that autosaves; a write silently destroys their unsaved notes). Reports go ONLY to this loop's `reports/`; the briefing inlines them from there.
- Never edit a tracked term's pages. The only content this loop ships is the seed article of a NEW bet. Everything after the seed belongs to an engine or enrichment.
- Never score on a trailing window. Never write 0 for a failed read. A missing number is reported as missing.
- Never scale, kill, or extend silently — every verdict lands in the ledger with the numbers that made it.
- Never spawn, pause, or retire an engine yourself. You recommend; the human ticks.
- One seed per week max; zero is valid. Do not force a weak article — thin seeds pollute the archetype evidence every future bet is judged against.
- Never fabricate a metric. Never commit to main.
- Keep heavy work OUT of this synced folder — worktrees, clones, build output go to a temp dir; only reports and drafts land here.

## Current understanding

Seed this before run 1. This section is where the compounding lives — especially the archetype evidence and the ruled-out list.

- Winning archetypes (≥90d GSC evidence, refresh quarterly): `<FILL: each with real numbers — page, clicks, CTR, why it repeats. Empty until you have click data; while empty, every bet takes the approval lane.>`
- Proven losers: `<FILL: with numbers — news/announcement pages (huge impressions, tiny CTR, zero funnel value) and generic model comparisons are two production-verified loser shapes; verify against your own data before assuming.>`
- Open bets: `<FILL: mirror of the ledger — term, thesis, day-7 date.>`
- Watchlist: `<FILL: term · why it's not yet a bet · drop-dead date.>`
- Ruled out, and why: `<FILL: candidates rejected, so a future run doesn't re-pitch them. Half the value of the file.>`
- Environment gotchas: `<FILL: the working GSC invocation verbatim, the research-skill invocation that works on this machine, repo conventions for images/frontmatter.>`

Three runtime gotchas (same as the engine template): a scheduled run dies the instant the agent yields — long steps must be blocking foreground calls; a sleeping machine can still reclaim a long run — keep runs chunked; the report files before the long steps (Part A ends by writing it) — a week of scoring must never depend on Part B finishing.

## Timeline

`<FILL: YYYY-MM-DD>` | Template cloned. No bets open; first run is Part A baseline + Part B first mine.
