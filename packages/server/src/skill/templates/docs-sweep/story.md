---
type: draft
format: x-article
title: "This month, Docs Sweep caught two stale claims"
status: awaiting-review
created: 2026-07-29
updated: 2026-07-29
---
This month, Docs Sweep caught two stale claims. The contributing guide still named a database driver we no longer use, and it described a migration flow we had replaced. A new contributor following either one would waste a fair amount of time.

Every Monday, the loop checks only claims it can verify. It runs commands and checks flags, environment variables, paths, and version numbers against the repository. It leaves opinions and writing style alone.

![The loop's dashboard: every Monday accounted for, and the latest sweep showing what the docs say against what is true now](assets/dashboard.png)

Each lie becomes a small PR showing what the docs say and what is true now. The loop fixed 6 in the last two months, with median review under a minute. Docs do not stay trustworthy because someone wrote them well. They stay trustworthy because someone keeps checking.
