# Reddit Karma — template reference

On-demand reference for the reddit-karma template. Fetched by the setup agent at
`<server-url>/api/skill/references/templates/reddit-karma/reference.md` when it reaches
the loop-flow / dashboard step — it does NOT ride in the paste prompt.

## The loop flow (what one run does, in order)

The workflow may fire the agent on many slots; each escalated run runs this pipeline
exactly once, then stops. Zero posts is a valid run.

1. **Verify session** — `opencli reddit whoami`. Not logged in as `<account>` → notify
   and stop. Never half-post.
2. **Check the ledger** — read `<ledger-file>` and enforce, before anything else, the
   `>=21`-min gap against the account's last post from ANY source and the `<=5`/day
   combined cap. If a promo/AEO batch is going out, yield the slot.
3. **Pick an expertise angle** — route via the knowledge base index; cite a position the
   owner has actually DOCUMENTED (read the page, never reconstruct from memory).
4. **Find a live pain point** — `opencli reddit search`/`subreddit --sort new` across the
   boundary (avoid / broaden-into); score topic-fit × freshness × "can my real experience
   answer this well". Prefer "how do I / why does X keep happening / what's your workflow".
5. **Quality gate** — top-level post `< ~48h` old; room temperature OK (skip pile-on /
   hostile); a concrete, non-generic answer grounded in a KB fact; not already commented
   by `<account>`; zero is fine.
6. **Write ONE comment** — follow the writing rules (no em-dashes, no LLM cadence, sound
   like the owner typing on their phone). Then post (`opencli reddit comment`/`reply`), or
   in draft-for-review mode write the draft and hold.
7. **Record** — write/update the comment's `RC-*.md` card (set its `type`), append one
   `<ledger-file>` line immediately, and append a dated `## Timeline` line.
8. **Report** — an escalated run that acted writes the dated `report-*.md` and reports the
   metrics below; a skipped slot is a single log line.

## Artifact contract

One card per candidate comment, plus one dated report per acting run. `type` carries the
STAGE (the kanban keys its columns on `type`; a run moves a card by editing `type` in
place) — do NOT add a separate `status:` field.

| File | `type` (= the board column) | Also required |
|---|---|---|
| `RC-<id>.md` (a comment) | `drafted` \| `posted` \| `skipped` | `title` = `r/<sub> — <thread title>`; the angle + the comment text in the body; a link line to the thread |
| `report-<date>.md` (run report) | `report` | `title`, `date` |

In auto-post mode a comment goes straight to `posted`; in draft-for-review mode it sits
in `drafted` until the owner posts it (then a later run flips it to `posted`). Threads
that never cleared the bar are a `## Timeline` "skipped: reason" line, not a card, unless
you want them tracked — then write `type: skipped`.

```markdown
---
type: drafted
title: r/LLMDevs — Most agentic pipeline bugs aren't in the prompt
date: 2026-07-20
---

Angle: structured output at the tool boundary (constrain what each step may emit).

<the 2-6 sentence comment, written to the writing rules — no em-dashes, no links>

Source: https://www.reddit.com/r/LLMDevs/comments/<id>/
```

## Dashboard reference layout

A validated composition: the comment pipeline (kanban) at ~2/3 width, a metrics rail +
karma chart beside it, the newest run report full-width below. A REFERENCE, not a
mandate — keep the shape unless the owner wants something else; in auto-post mode the
`drafted` column will simply stay near-empty. Set it via `loopany set-ui`.

```html
<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5">
  <h3 style="margin:0 0 2px">{{LOOP NAME}}</h3>
  <p style="margin:0 0 12px;color:#666">{{One-line blurb: account, cadence, auto-post vs draft-for-review.}}</p>

  <div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">
    <div style="flex:2 1 36rem;min-width:0">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:12px">Each card is a candidate comment; it moves drafted → posted, or lands in skipped.</p>
      <loop-kanban columns="drafted,posted,skipped" match="RC-*.md"></loop-kanban>
    </div>
    <div style="flex:1 1 20rem;min-width:0">
      <p style="margin:0 0 8px;font-weight:600">Karma</p>
      <div style="display:flex;gap:10px;margin:0 0 12px">
        <div style="flex:1;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px 10px"><b style="font-size:18px">{{latest.comment_karma}}</b><br><small style="color:#94a3b8">comment karma</small></div>
        <div style="flex:1;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px 10px"><b style="font-size:18px">{{latest.posted_today}}</b><br><small style="color:#94a3b8">posted today</small></div>
      </div>
      <p style="margin:0 0 2px;color:#94a3b8;font-size:12px">Comment karma over time</p>
      <loop-chart series="comment_karma:Comment karma"></loop-chart>
    </div>
  </div>

  <p style="margin:12px 0 4px;font-weight:600">Latest run report</p>
  <loop-embed match="report-*.md"></loop-embed>
</div>
```

## State schema (declare at creation)

```json
[
  {"key": "comment_karma", "label": "Comment karma (from whoami)", "unit": "karma"},
  {"key": "posted_today", "label": "Comments posted today", "unit": "comments"},
  {"key": "drafted_waiting", "label": "Drafts waiting to post", "unit": "drafts"}
]
```
