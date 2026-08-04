# Housekeeper twins — STAGED, not created

Two local twins of the production Housekeeper loops, prepared for the rewrite line as
part of landing unit 10. **Neither has been created.** Both carry outward side effects
(git pushes and GitHub PR writes), so under the unit's arming policy they wait for the
captain's decision; only an inward-only loop is armed without one.

Each twin binds the SAME workdir as its production counterpart and keeps the same
`0 7 * * *` cadence — that is the dual-run the captain asked for: production keeps
running against loopany.ai, the twin runs for real against the local rewrite server.

## Side-effect inventory

Read from the production charters (`<repo>/loopany/housekeeper/README.md`) on
2026-08-04. `LOCAL` = never leaves the machine. `OUTWARD` = visible to someone else.

### A — `loopany-platform` (`/Users/stonex/Workspace/loopany-platform`)

| # | Action class | Direction | What it actually does |
|---|---|---|---|
| 1 | Local file reads | LOCAL | Repo-wide `rg`/`grep`, `git log`/`git blame`, `package.json`, the loop folder's own cards and deferred list |
| 2 | Local file writes, in the loop folder | LOCAL | `prs/pr-<n>.md` cards, `deferred-candidates.md`, `workflow-setup-<date>.md`, and the task file's own Current-understanding + Timeline sections |
| 3 | Local file writes, outside it | LOCAL | A throwaway git worktree (`/tmp/hk-<date>` or `../`) plus the source edits inside it |
| 4 | Git, local | LOCAL | `worktree add`/`remove`, branch `housekeeper/<date>-<slug>`, commits |
| 5 | **Git, remote** | **OUTWARD** | **`git push` of the branch to `origin`** |
| 6 | **GitHub API writes** | **OUTWARD** | **`gh pr create`** (title prefix `housekeeper:`). Reads (`gh pr list`/`view`) are local-only in effect |
| 7 | Build and test execution | LOCAL | `pnpm -r typecheck`, `pnpm --filter … test`; arbitrary repo code runs during tests |
| 8 | Notifications | OUTWARD in prod, **inert here** | Prod is `notify: auto` and pushes a line when a PR opens. The rewrite line has no notifier wired — `finishRun` writes a report doc and stops |
| 9 | Network reads | LOCAL-ish | `git fetch`, `gh` API reads |

### B — `superdesign-platform` (`/Users/stonex/Workspace/superdesign/superdesign-platform`)

| # | Action class | Direction | What it actually does |
|---|---|---|---|
| 1 | Local file reads | LOCAL | Repo sweep over the four active apps + `packages/*`, `git status`, `git log`, the loop folder's cards |
| 2 | Local file writes, in the loop folder | LOCAL | `cards/<date>-<slug>.md`, `deferred-candidates.md`, the task file's own sections — **including deleting a card** for a PR closed without merging |
| 3 | Local file writes, outside it | LOCAL | A worktree under `$HOME/.loopany-worktrees/…`, `pnpm install --frozen-lockfile` inside it (writes `node_modules`), source edits |
| 4 | Git, local | LOCAL | `fetch`, `worktree add`/`remove`, branch, commit `--no-verify` |
| 5 | **Git, remote** | **OUTWARD** | **`git push -u origin housekeeper/<slug>`** |
| 6 | **GitHub API writes** | **OUTWARD** | **`gh pr create`**, and in the repair branch **`gh pr close`** |
| 7 | Build and test execution | LOCAL | `pnpm type-check`, `pnpm lint`, `pnpm build`, `pnpm test`, turbo |
| 8 | **Package-registry fetch** | **OUTWARD-ish** | `pnpm install` in each fresh worktree — a real registry fetch every run that reaches step 5 |
| 9 | Notifications | OUTWARD in prod, **inert here** | Same as A |

**Verdict: neither twin is inward-only.** Both push branches and open PRs, and B also
closes PRs and installs from the registry. Both are staged.

## The dual-run collision, which is the real decision

Both twins bind the SAME checkout their production counterpart binds, so once armed each
repo has two Housekeepers. Three concrete collisions, and how each twin's charter handles
them:

1. **The PR queue.** The no-stacking rule is per repo, not per loop, so each twin checks
   for ANY open `housekeeper` PR — including one the prod loop opened — and stands down.
   Two loops still race within the same minute; the gate narrows the window, it does not
   close it.
2. **The ledger.** The prod loop's `loopany/housekeeper/` folder is its state. A twin
   writing there would corrupt it, so each twin is told to READ it and never write it:
   on the rewrite line a product is a kernel doc or task, which is where they belong
   anyway. This is an adaptation to the local server, not a softening.
3. **The worktrees.** Both use dated, slugged branch names outside the repo tree, so a
   collision shows up as a branch-name clash rather than as interleaved edits.

Residual risk the captain owns: two agents may survey the same repo the same morning and
open near-duplicate PRs, and the twin's `git push` and `gh pr create` are real writes to
a real repository.

## What was adapted, and what was not

Adapted, because the local server genuinely differs:

- **`loopany report --state '{…}'` is gone.** It is not a verb on this line — the
  daemon reports the run itself and stores the agent's final message as the run's report
  doc. Both twins put the metric line in that final message instead.
- **Products are kernel objects** (`loopany doc create` / `task create`) rather than
  files in the prod loop's folder — see collision 2.
- **The charter is the loop body**, so "maintain this file" becomes
  `loopany loop evolve --file <path>`. Evolve refuses a differing `cron:` or `workdir:`
  as governance, so a run can deepen its understanding but never move its own cadence
  or its bound directory.
- **No workflow pre-survey.** Both prod loops carry a deterministic pre-stage workflow;
  the rewrite claim carries no workflow for these twins, so each charter says to run the
  scans by hand and keeps the durable lessons those workflows encode.

NOT adapted: the safety rules, the proof bar, the no-stacking gate, the protected-path
lists, the one-cleanup-per-day limit, the cadence, and the bound workdir. No behaviour
was softened.

## Exact create commands

Run them from a shell that has sourced the isolated stack (see
`scripts/rewrite-local-run.env.sh`), with the server up:

```sh
source scripts/rewrite-local-run.env.sh

# A — loopany-platform
curl -sS -X POST "$LOOPANY_SERVER_URL/api/loops" \
  -H 'content-type: text/markdown' \
  --data-binary @scripts/rewrite-twins/housekeeper-loopany-platform.local.md

# B — superdesign-platform
curl -sS -X POST "$LOOPANY_SERVER_URL/api/loops" \
  -H 'content-type: text/markdown' \
  --data-binary @scripts/rewrite-twins/housekeeper-superdesign-platform.local.md
```

Equivalently through the rewrite CLI, from `packages/daemon`:

```sh
./node_modules/.bin/tsx src/cli.ts loop create --file ../../scripts/rewrite-twins/housekeeper-loopany-platform.local.md
./node_modules/.bin/tsx src/cli.ts loop create --file ../../scripts/rewrite-twins/housekeeper-superdesign-platform.local.md
```

Both carry a `key:`, so a repeated create is an idempotent replay, never a twin of a twin.
Each is created ARMED (it has a `cron:`); to stage one without arming it, create it and
immediately `POST /api/loops/<id>/pause`, then `resume` when the captain says go.
`POST /api/loops/<id>/run-now` fires one off-cadence without waiting for 07:00.
