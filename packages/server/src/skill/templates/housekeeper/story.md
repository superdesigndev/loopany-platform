---
type: draft
format: x-article
title: "Housekeeper reads the codebase every morning at 7am"
status: awaiting-review
created: 2026-07-29
updated: 2026-07-29
---
Housekeeper reads the codebase every morning at 7am. It is not looking for unused imports. A linter is better at that. It looks for things that no longer make sense: two implementations of the same idea, one pattern expressed three different ways, or a structure nobody can explain anymore.

It picks one, proves the case, and opens the smallest cleanup PR it can. After 8 weeks, that was 21 small cleanups, 20 of them already merged. None deserved a sprint. Together they made the codebase argue with itself less.

![8 weeks of cleanups, one per PR: dead components, orphaned leaves, a leftover scratch file](assets/pr-list.png)

The boundary is simple: do not change runtime behavior. If the loop is unsure, it reports the candidate and stops. The value is not deleting more lines than a linter. It is noticing when the codebase has stopped agreeing with itself.
