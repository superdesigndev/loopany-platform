# Create a Task or recurring Loop

Use this reference after the human CLI session and destination team are selected.
Never accept or pass a machine key, session token, `dk_` value, or connect key.

## 1. Understand the intent

Read the current conversation and repository before asking questions. If the user
just completed a repeatable task, propose turning that observed workflow into a
Loop. Otherwise ask what outcome should recur. A template description in the
capture prompt is the intended workflow and its hard rules, not optional flavor.

Confirm:

- the standing outcome and important boundaries
- whether this is a one-time Task or recurring Loop
- the cadence and IANA timezone for a Loop
- the execution assignment, normally `<machine>/<agent>`
- the durable outputs and the clean nothing-found behavior
- the finish line when the work is goal-bound

Do not create anything until the user confirms these material choices.

## 2. Verify the observation and execution path

For monitoring work, identify a concrete source and smoke-test access once. Never
create a blind Loop. For code work, keep repositories, worktrees, dependencies,
and build output outside the Loopany content folder. Use a fresh worktree from
`main`, one PR at a time, and do not stack work on an unmerged PR.

Never copy credentials, tokens, PII, or large raw transcripts into a Task, Doc,
report, dashboard, or PR.

## 3. Write the standing body

Author a Markdown file with the stable specification. Include the per-Run
workflow, hard rules, boundaries, quality gates, expected products, and the
honest nothing-found stop. Do not put an execution diary in the body. Events and
notes record what happened.

Use front matter on durable report Docs when useful:

```markdown
---
type: report
title: <human title>
date: YYYY-MM-DD
---
```

## 4. Preview

Use the human CLI session and selected team. Preview the exact command first:

```bash
lk create "<title>" \
  --id <stable-id> \
  --assignee <machine>/<agent> \
  --status todo \
  --body-file <spec.md> \
  --dry-run
```

For a recurring Loop add:

```bash
  --cron '<five-field-cron>' --timezone '<IANA-timezone>'
```

For goal-bound work add `--goal '<finish line>'`. Use `--team <team-id>` as an
explicit one-command override when the selected team should not be persisted.

Show the normalized preview to the user and resolve every refusal before writing.

## 5. Create and verify

Run the same `lk create` command without `--dry-run`. Then run:

```bash
lk show <task-id>
```

Verify the canonical assignment, status, body, cadence, timezone, and goal. Human
emails and names are only input aliases. The stored value must be a stable
`person:<user-id>` identity. If a name is ambiguous, stop and ask the user to
choose a specific team member.

For a recurring Loop, confirm its assigned machine is enrolled and online with
the daemon. Machine authority is execution-only. All Task and Kernel writes must
continue through the human session or the least-privilege Run credential.
