---
type: draft
format: x-article
title: "React Doctor filed 35 fix PRs against our production app"
status: awaiting-review
created: 2026-07-29
updated: 2026-07-29
---
Over the last 3 months, React Doctor filed 35 fix PRs against our production app. Missing JSX keys, a locale-sensitive month bug, an impure state updater, and unlabeled form controls. 31 are already merged, 4 are still open. Most reviews took under a minute. The few trickier ones took three to five minutes.

![The PR list, filtered to the loop's own work: 31 closed, 4 open, one defect class per PR](assets/pr-list.png)

The trick is one defect class per PR. A 60-second review merges that morning. A 40-file PR called "lint fixes" can be perfectly correct and still sit forever. Small is the method.

For now, a person still clicks merge. If the loop keeps sending clean diffs for a while, we can try giving it a little more room. Automation should follow a record of good decisions.

It runs at 6am. The PR is there when I wake up. A fix in the afternoon is an interruption. A fix in the morning feels like the codebase tidied itself up.
