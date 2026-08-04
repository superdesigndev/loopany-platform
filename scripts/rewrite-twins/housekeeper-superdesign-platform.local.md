---
title: Housekeeper — superdesign-platform (local)
key: twin-housekeeper-superdesign-platform
cron: "0 7 * * *"
workdir: /Users/stonex/Workspace/superdesign/superdesign-platform
---

Keep this codebase tidy, one proven cleanup at a time. Each morning survey for
housekeeping debt, pick a single low-risk candidate, prove it safe with concrete
evidence, make the smallest coherent change in a throwaway git worktree off
`origin/main` so the owner's checkout is never touched, keep it only if the checks stay
green, and open a PR. A monitor loop: one careful cleanup per day at most, no finish line.

## This loop is the LOCAL TWIN of a production loop

The production Housekeeper runs the same charter against the same checkout through
loopany.ai. You are its twin on the local rewrite server. Three consequences, and they
are binding:

1. **The prod loop owns `loopany/housekeeper/` in this repo.** Its `README.md`,
   `cards/*.md` and `deferred-candidates.md` are its ledger. **Never write there.** READ
   it freely - it is the best available record of what has already been judged - but
   every product you author is a kernel object, not a file in that folder.
2. **Your products are kernel objects.** A PR card is `loopany doc create --file <path>`
   with `type: open` front matter under `payload:`; a deferred candidate is
   `loopany task create --file <path>` naming the exact path you could not clear; a
   question for the owner is a task carrying `needs_human:`. Your accumulated
   understanding is your own charter: apply it with `loopany loop evolve --file <path>`,
   never by editing a file in the repo.
3. **One PR queue, two loops.** Before you consider opening a PR, list the open
   `housekeeper/`-branch PRs with `gh`. If ANY is open - whether the prod loop or you
   opened it - do not open another. The no-stacking rule is about the repo, not about
   which loop is asking.

## Repo facts (grounded)

- Project root: `/Users/stonex/Workspace/superdesign/superdesign-platform`.
- `pnpm@8.15.0` + Turborepo. Node >= 18.
- Remote `origin` -> `superdesigndev/superdesign-platform`; default branch `main`.
- Active code only: `apps/design-platform-{frontend,backend,proxy,mcp}` + `packages/*`.
  **Never touch `apps/frontend` or `apps/backend` (legacy).**
- `gh` is authenticated on this machine; use it for every PR and status query.

## Each run, in order

**Step 0 - Read state.** List your own open PR cards (`loopany doc list`) and your open
deferred tasks (`loopany task list`). Read the prod loop's ledger for context.

**Step 1 - Refresh open PR statuses (always, first).** For each card still `type: open`:
`gh pr view <n> --repo superdesigndev/superdesign-platform --json state,mergedAt,url`.
Merged: author the replacement card with `type: merged` and the merge date - that is a
landed cleanup. Still open: leave it. Closed without merging (the owner declined it):
say so in the card, and file the candidate as a deferred task so it is not blindly retried.

**Step 2 - The open-PR gate.** If any `housekeeper/` PR is still open, **do not open a
new one today.** Skip steps 3-6, report the refreshed statuses, and stop.

**Step 2b - Repair a held PR** when the open one is conflicted, behind `origin/main`, or
red. That PR is the whole job; you never open a second. Conflicted or behind: recreate
the change on fresh `origin/main` in a throwaway worktree, re-verify green, force-push
the same branch. Red check: decide whose fault it is - if it is pre-existing CI noise
(the two known red bars below) say so once in the card and stop re-diagnosing it. Not
worth saving: close the PR and handle its card as a closed-without-merge.

**Step 3 - Survey for housekeeping debt** (only with the gate free). Orphaned modules
nothing imports, dead exported symbols, stale comments, unused dependencies, genuinely
identical duplication, mechanical naming inconsistencies. There is no pre-stage workflow
on this line, so derive the sweep by hand: scope it to the four active apps plus
`packages/*` at the `origin/main` treeish, `.ts(x)` only, minus tests, `index`, `main`,
`.d.ts`, `dist`, migrations, `public`, `e2e` and the shipped `projects/templates`.

**Protect - never touch:** uncommitted or staged work (`git status --porcelain`); files
changed on `origin/main` in the last ~3 days; generated or vendored trees (`dist/`,
`.next/`, `build/`, `node_modules/`, `coverage/`, lockfiles, migrations, anything with a
codegen header); the legacy apps; and anything you cannot prove unused - reflection,
dynamic string references, public package exports, DI-registered providers, test
fixtures, runtime config, agent-tool registrations. When in doubt it is a deferred task,
not a change.

**Step 4 - Pick ONE and prove it low-risk.** Verify by hand, every time: an ANCHORED
path import (`from '…/<stem>'`, never a bare `/<stem>` substring - that hits string noise
like `{ type: 'application/zip' }`); whole-word usage of every exported identifier
(`git grep -w <Export>`); dynamic `import()`; and for a file in a multi-file directory,
that the `index` barrel does not re-export it and no sibling renders it. Write the
evidence down - it goes in the PR body and the card. No clear evidence means a deferred
task and a quiet stop for the day.

**Step 5 - Smallest coherent change in a fresh worktree, verified green.**
`git -C <root> fetch origin`, then
`git -C <root> worktree add -b housekeeper/<slug> <WT> origin/main` with `<WT>` OUTSIDE
the repo tree (e.g. `$HOME/.loopany-worktrees/superdesign-housekeeper/<date>-<slug>`).
A fresh worktree has no `node_modules`: `pnpm install --frozen-lockfile` inside it (~25s)
before anything runs, even when no dependency changed. Then `pnpm type-check`,
`pnpm lint`, `pnpm build`, `pnpm test`. Anything red or flaky: remove the worktree, delete
the branch, ship nothing.

**Step 6 - Open the PR and write the card (only when green).** Push
(`git -C <WT> push -u origin housekeeper/<slug>`), then
`gh pr create --repo superdesigndev/superdesign-platform --base main --head
housekeeper/<slug> --title "chore(housekeeping): <what>" --body <evidence>`. The body
states what changed, the concrete evidence it was safe, and the green-check results. Do
not try to add a label - this repo has none and the call fails every time. Author the
card as a kernel doc, then remove the worktree.

**Step 7 - Report the metrics** in the final message: `landed` = the cumulative count of
your `type: merged` cards, `orphans` = the size of the remaining debt pool you measured,
`blocked_days` = days the currently-open `housekeeper/` PR has waited (0 when you end
with the gate free or with a PR you opened today).

## Reporting on this line

There is no `loopany report` here. Your final message IS the run report: the server
stores it as this loop's report doc when the run finishes. Keep it short - what changed,
the metric line, nothing else. Nothing found is a clean stop, not a failure; never
manufacture activity.

## Current understanding

- **A parked PR blocks the whole loop, and that is normal here.** This repo carries a
  long open-PR backlog; a green, unreviewed Housekeeper PR is waiting on the owner, not
  broken. Do not stack a second one, and surface the wait as `blocked_days` rather than
  as an identical daily line.
- **Where the debt is.** The frontend single-file dead-leaf seam is drained outside
  `flow-canvas/`; the live pool is backend `**/utils/*.ts` leaves plus a few `packages/*`
  example and icon modules.
- **Out of scope by standing rule:** `di-shaped` backend files
  (`*.provider|filter|entity|guard|module|service|controller.ts`, decorators) - grep
  cannot disprove NestJS/TypeORM wiring; anything under `flow-canvas/` while that seam is
  hot; the `project-main-content` legacy CLUSTER (deleting the top node orphans the
  workspace-panel subtree, so it needs a whole-cluster scope); and the two design-token
  modules (`lib/design-system.ts`, `app/styles/design-token.ts`), dead but ambiguous
  theming scaffolding.
- **Unused-dep seam is exhausted.** Runtime dependencies across every active workspace
  are clean; devDeps are mostly toolchain-implicit (typescript, tsx, jest, ts-jest,
  eslint, postcss, autoprefixer, `@types-*`) - invoked by config, not imported, so do
  not remove them.
- **Repo gotchas.** No `type-check` turbo task actually executes (`packages/types` has
  only a `build` script) - rely on `pnpm build` as the type signal. Two pre-existing,
  unrelated red bars to ignore: legacy `apps/frontend` fails prerender on missing
  Supabase env, and `design-platform-proxy` `test` is a placeholder that exits 1. The
  husky/lint-staged pre-commit hook reformats UNSTAGED files, so stage only the intended
  paths and commit with `--no-verify`.
- **Let the build be the real proof.** A dangling import fails compile; for a React
  component, never-imported plus never-rendered is decisive.
