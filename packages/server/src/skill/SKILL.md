---
name: loopany
description: Create, update, and evolve scheduled Loopany agent loops from a coding session. Use when the user wants to turn a task they just did into a recurring/scheduled loop, edit an existing loop's schedule or instructions, or asks to build a Loopany loop. A loop can carry a goal (a finish line) and completes itself when the goal is met; without one it runs indefinitely as a monitor.
---

# Loopany — build and maintain scheduled loops

Loopany turns a task into a **loop** that runs automatically on a schedule on this
machine. A loop with a **goal** is closed — each run judges the goal and the loop
finishes itself once it's met; without one it's an open monitor that runs
indefinitely. Work end to end; keep questions to quick check-ins, don't run a full
interview. Two check-ins are right: if the session has no real task to loop yet, ask
what to build rather than inventing one (`references/create.md` §1); and when the
user hasn't specified the loop's cadence or per-run output, propose a sensible
default and confirm it before creating (`references/create.md` §2).

Read the reference for the job (they live on disk next to this file, under
`references/`):

- **Creating a loop** (the common case — you just did a task and want it scheduled):
  **`references/create.md`**. It decides what to build, authors the loop's folder +
  task file and an inline config (with an optional goal), and runs `loopany new`.
- **Editing an existing loop** (reschedule, rename, pause, set/clear a goal, or
  change what it does): **`references/update.md`**.
- **How a loop stays coherent and improves over time** (the evolution pass that
  sharpens its **task** and **workflow** from its own run history, then fits its
  dashboard to the data): **`references/evolve.md`**.

The machine is already connected — this skill was installed at user scope
(`~/.claude/skills/loopany/`) when it connected via `loopany up`. Just author the
loop and run the `loopany` CLI; the references cover the exact commands.
