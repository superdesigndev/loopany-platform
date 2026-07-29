---
type: draft
format: x-article
title: "The morning report looked like two regressions. It was one."
status: awaiting-review
created: 2026-07-29
updated: 2026-07-29
---
The morning report looked like two regressions. Error Sweep read the traces, pulled the sessions, and found one problem: Safari 16.1 could not parse a new regex. 16 occurrences, 3 real users, modern browsers clean.

It did not hand me another dashboard. It asked whether we should transpile the syntax and keep supporting the old browser, or make Safari 16.4 the floor. One reply was enough.

![The loop's working file: what already shipped, what stays watch-only, and the one item waiting on a human decision](assets/triage-ledger.png)

That is the useful part. The loop groups errors by the boundary they share, then puts occurrences, users, and sessions next to each other. The output is not a todo. It is either a fix we can take or a question whose investigation is already done.
