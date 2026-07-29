---
type: draft
format: x-article
title: "31 dependency alerts. 5 of them needed a person."
status: awaiting-review
created: 2026-07-29
updated: 2026-07-29
---
Last month, Dependency Triage took in 31 alerts and updates. It handled 8 safe updates in one review session, escalated 5, and closed the other 18 with a reason for each.

![One run's triage report: the safe batch, the five that need a person, and every close with the reason it was closed](assets/triage-report.png)

It checks reachability first. A CVE in a dependency does not mean our code can reach it. Most alarming notices stop at the real import surface, with the evidence kept on file.

Low-risk patches join the same review only after the diff, release notes, advisory, and CI at the current PR head all make sense. Major, breaking, and security-sensitive changes stay separate for a person.

Every ignored alert also gets a note in the ledger, which the next run reads first. That keeps us from retrying the same argument every week. Security is not reading all 31 alerts. It is knowing which 5 need a person, with a clear account of why the other 26 could be handled or closed.
