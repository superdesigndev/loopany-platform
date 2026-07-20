# Support Triage — template reference

On-demand reference for the support-triage template. Fetched by the setup agent at
`<server-url>/api/skill/references/templates/support-triage/reference.md` when it
reaches the dashboard step — it does NOT ride in the paste prompt.

## Artifact contract (read this BEFORE writing any note)

Every artifact opens with flat scalar front matter. Two rules decide whether the
dashboard works at all:

**1. `type` carries the STAGE, not the kind of document.** The kanban boards key their
columns on `type` — a card sits in the column equal to its `type`, and a run "moves" a
card by editing that `type` in place. Anything whose `type` is not a declared column
silently collects in a trailing "Other" column. Writing the document's class
(`type: ticket`) and the stage in a separate `status:` field is the natural-looking
mistake that breaks every board — the boards never read `status`, so **do not write a
`status:` field at all**. The document's class is already carried by its filename
prefix and its `match` glob.

**2. Every artifact links back to its source thread**, so a human can open the real
conversation in one click. Put the deep link in the body's last line, never only in the
front matter.

| File | `type` (= the board column) | Also required |
|---|---|---|
| `SUP-<id>.md` (ticket) | `needs_human` \| `needs_followup` \| `resolved` | `title`, `date`, link line |
| `FB-<slug>.md` (product signal) | `open` \| `mitigated` \| `resolved` | `title` with the frequency count, e.g. `Users expect the bot to be the design agent (7)`; link lines to the threads that raised it |
| `ENG-<slug>.md` (eng bug) | `open` \| `pr-open` \| `shipped` | `title`, `date`, link line + PR URL once opened |
| `report-<date>.md` (run report) | `report` | `title`, `date` |

`resolved` / `open` recur across boards on purpose: each board's `match` glob scopes it
to its own filename prefix, so the values never collide.

```markdown
---
type: needs_human
title: SUP-215475058702855 — recurring $49 charge disputed, three months
date: 2026-07-20
---

One-paragraph summary of what the customer asked and what investigation found.

Source: [Intercom thread](https://app.intercom.com/a/inbox/<workspace>/inbox/shared/all/conversation/215475058702855)
```

Adapt the prefixes/vocabulary to whatever Step 3 agreed — but keep rule 1 and rule 2
whatever you rename things to.

## Dashboard reference layout

A validated composition: tabbed boards (tickets / product signals / eng bugs) at
~2/3 width, a metrics rail beside them, the newest run report full-width below.
It is a REFERENCE, not a mandate — keep the overall shape unless the user wants
something else; substitute the loop name/blurb and whatever ticket prefix /
status vocabulary Step 3 agreed; adapt or drop panels that don't fit the
business. Set it via `loopany set-ui`.

```html
<!-- Reference layout - adapt to the vocabulary agreed in Step 3 -->
<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5">
  <h3 style="margin:0 0 2px">{{LOOP NAME}}</h3>
  <p style="margin:0 0 12px;color:#666">{{One-line blurb: cadence, what auto-sends vs what waits for a human.}}</p>

  <div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">
    <div style="flex:2 1 36rem;min-width:0">
      <loop-tabs tabs="Tickets,Product Signal,Eng fix">
        <section>
          <p style="margin:0 0 4px;color:#94a3b8;font-size:12px">Cards mirror the ticket notes; a card moves when a run changes the ticket's status.</p>
          <loop-kanban columns="needs_human,needs_followup,resolved" match="SUP-*.md"></loop-kanban>
        </section>
        <section>
          <p style="margin:0 0 4px;color:#94a3b8;font-size:12px">Recurring themes, frequency in the title. open = accruing; mitigated = fix in place, still watching.</p>
          <loop-kanban columns="open,mitigated,resolved" match="FB-*.md"></loop-kanban>
        </section>
        <section>
          <p style="margin:0 0 4px;color:#94a3b8;font-size:12px">Bugs the loop filed; fix agents open PRs, humans merge.</p>
          <loop-kanban columns="open,pr-open,shipped" match="ENG-*.md"></loop-kanban>
        </section>
      </loop-tabs>
    </div>
    <div style="flex:1 1 20rem;min-width:0">
      <p style="margin:0 0 8px;font-weight:600">Run metrics</p>
      <div style="display:flex;gap:10px;margin:0 0 12px">
        <div style="flex:1;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px 10px"><b style="font-size:18px">{{latest.needs_human}}</b><br><small style="color:#94a3b8">needs human</small></div>
        <div style="flex:1;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px 10px"><b style="font-size:18px">{{latest.product_signals}}</b><br><small style="color:#94a3b8">product signals</small></div>
        <div style="flex:1;border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:8px 10px"><b style="font-size:18px">{{latest.eng_bugs_open}}</b><br><small style="color:#94a3b8">eng bugs</small></div>
      </div>
      <p style="margin:0 0 2px;color:#94a3b8;font-size:12px">Per-run flow</p>
      <loop-chart series="new_convos:New convos, handled:Auto-handled"></loop-chart>
    </div>
  </div>

  <p style="margin:12px 0 4px;font-weight:600">Latest run report</p>
  <loop-embed match="report-*.md"></loop-embed>
</div>
```

## State schema (declare at creation)

```json
[
  {"key": "needs_human", "label": "Tickets awaiting a human", "unit": "tickets"},
  {"key": "customer_waiting", "label": "Customer-waiting this run", "unit": "convos"},
  {"key": "new_convos", "label": "New convos triaged", "unit": "convos"},
  {"key": "handled", "label": "Auto-handled", "unit": "convos"},
  {"key": "product_signals", "label": "Open product signals", "unit": "signals"},
  {"key": "eng_bugs_open", "label": "Open eng bugs", "unit": "bugs"}
]
```
