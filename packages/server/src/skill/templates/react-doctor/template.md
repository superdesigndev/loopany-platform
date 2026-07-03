# Template — React Doctor

You are setting up a **React Doctor** loop for the user from the Loopany template
market. This is a productized recipe: a standing daily guardian that scans this
React project with [`react-doctor`](https://www.npmjs.com/package/react-doctor),
fixes the single most severe issue it finds, and opens a PR — while tracking the
health-score trend and a merged/open PR board on the dashboard.

The user pasted a snippet that carries a few config lines. Read them, run the
preconditions, then author and create the loop. You are capable — this doc gives
you the rules that are genuinely non-obvious (no-stacking, the PR board convention,
score reporting, notify); handle the ordinary work with your own judgement. Keep the
loop lean and true to what follows.

## 0 · Config lines from the snippet

The pasted snippet looks like:

```
Fetch <server-url>/api/template/react-doctor and help me set it up.

server-url: https://…
connect-key: dk_…
run-at: 05:00
```

- **server-url** / **connect-key** — the machine handshake. If a `loopany-cli:` line
  is present, use that exact CLI prefix; otherwise the default is
  `npx @crewlet/loopany@latest`. If no daemon is running yet, `<loopany-cli> up` with
  the pasted `server-url`/`connect-key` first (bootstrap flow), then continue.
- **run-at** — the daily run time in **this machine's local timezone**, `HH:MM`
  (default `05:00` if the line is absent). Turn it into a cron `M H * * *` (e.g.
  `05:00` → `0 5 * * *`). `loopany new` detects and stamps the machine's IANA
  timezone, so you do NOT pass `--tz` — local time is the default.

## 1 · Preconditions — verify, or stop politely

Do these **first**. If either fails, do NOT create the loop; tell the user in one or
two plain lines what to fix, then stop.

1. **This is a React project where `react-doctor` runs.** The current working
   directory is the repo to guard. Confirm it's a React app (a `package.json` with
   `react` in its dependencies) and that the scanner actually runs here:
   `npx react-doctor@latest --score -y` should print a 0–100 score without prompting.
   If it can't (not a React project, scanner errors), stop and say so.
2. **`gh` is authed with push rights.** `gh auth status` succeeds and the user can
   push branches / open PRs on this repo (`gh repo view` resolves). If not, stop and
   point them at `gh auth login`.

Only continue once both hold.

## 2 · Create the loop folder and task file

Make `<project>/loopany/react-doctor/` and write its task file at
`<project>/loopany/react-doctor/README.md`. This task file is the loop's standing
brief — **every scheduled run reads its `## Spec`** and follows it. Write it exactly
along these lines (fill in the real project name; keep the Spec's rules intact):

```markdown
# React Doctor

## Spec
A daily guardian for this React project. Each scheduled run:

1. **Diagnose.** Run `npx react-doctor@latest --json -y` from the project root. Parse
   the report: capture the overall 0–100 health score and the list of issues with
   their severities.
2. **No-stacking check.** Before opening anything, check whether a previous React
   Doctor PR is still open (unmerged) via `gh pr list --author "@me" --state open`
   (React Doctor PRs use the branch prefix `react-doctor/` and are labeled — see
   below). **If any React Doctor PR is still open, do NOT open a new one today.**
   Still finish steps 4 and 5 (refresh the board, report the score) and stop there.
   Rationale: every fix must build on `main` including the previous merge — never
   stack PRs.
3. **Fix the worst issue (only when nothing is pending).** Pick the SINGLE most
   severe issue from the report. Create a branch `react-doctor/<short-slug>` off the
   current `main`, fix that one issue, and verify with whatever the project has:
   typecheck, tests, and build (run the ones that exist; a fix must not break them).
   Then open a PR with `gh pr create` — title = a clear one-line description of the
   fix, body = the issue, the change, and the verification you ran. Label it so it's
   findable next run: `gh pr create --label react-doctor` (create the label once with
   `gh label create react-doctor` if it doesn't exist). Keep each PR to one issue.
4. **Refresh the PR board.** The board is a set of markdown artifacts, one per PR,
   under `loopany/react-doctor/prs/`. Each file opens with a fenced front-matter
   block (three dashes, flat scalars): `type:` = `open` or `merged`, `title:` = the PR
   title, `date:` = the `YYYY-MM-DD` the PR was opened. For example, a file's first
   lines are: `---` / `type: open` / `title: Fix unstable useEffect dep` /
   `date: 2026-07-03` / `---`.
   Body: PR link, the issue it fixes, and the react-doctor score at open time. When
   you open a new PR (step 3), write its artifact with `type: open`. Every run, use
   `gh pr view <n> --json state,mergedAt` on each tracked PR and, for any that has
   merged, edit its artifact's front matter `type: merged` **in place** (leave the
   rest). This is what moves the card from the "open" column to "merged" on the
   dashboard board — the daily statuses stay live without any manual step.
5. **Report the score — every day.** End the run with
   `loopany report --status <new|nothing-new> --state '{"score": <0-100>}'`, reporting
   today's react-doctor score on EVERY run (PR day, skip day, or clean day) so the
   trend chart has a point each day. On a day you opened a PR, set `--status new` and
   put the **PR link** in `--message` — notify is on, so the user is pushed the link.
   On skip/clean days, `--status nothing-new` (no message needed).

This is an open monitor loop — there is no goal and it never self-finishes; score 100
is an asymptote. The user pauses or stops it manually if they ever want to.

## Current understanding
Baseline captured at setup: react-doctor score = <the score from the precondition
run>. No React Doctor PRs open yet.

## Timeline
<!-- one dated entry per run, appended below by the loop -->
```

Keep the absolute path to that `README.md` — it's the config `taskFile`.

## 3 · Author and create the loop

Author the config inline and create it. This is an **open** loop (no `goal`),
notify **on**, with a pre-baked dashboard (score chart + open/merged PR board):

```bash
<loopany-cli> new --json '{
  "name": "React Doctor",
  "cron": "0 5 * * *",
  "workdir": "<absolute project dir>",
  "taskFile": "<absolute path to loopany/react-doctor/README.md>",
  "notify": "auto",
  "stateSchema": [{ "key": "score", "label": "Red Dot Score", "unit": "" }],
  "ui": "<h3>React Doctor</h3><p>Daily react-doctor health score and the PR pipeline.</p><loop-chart series=\"score:Red Dot Score\"></loop-chart><loop-kanban columns=\"open,merged\"></loop-kanban>"
}' --connect-key <connect-key> --agent claude-code
```

Notes:
- Replace `0 5 * * *` with the cron you built from `run-at` (§0).
- `notify: "auto"` pushes the user only when a run has something to say — i.e. the
  PR link on PR days; silent on skip/clean days. That is the intended behavior.
- The `ui` bakes in both dashboard primitives: `<loop-chart series="score:Red Dot
  Score">` renders the score trend, and `<loop-kanban columns="open,merged">` groups
  the `prs/` artifacts by their front-matter `type` into an **open** and a **merged**
  column. No goal, no `workflow` — every run is the coding agent following the Spec.
- Preview with `--dry-run` first if you want to confirm the cron and that it reads as
  `open: runs until paused`, then create for real.

On success, tell the user: the React Doctor loop is scheduled (name + daily time),
the first run comes automatically, and they can watch the score trend and PR board on
the Loopany dashboard.
