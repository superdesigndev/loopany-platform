---
name: autopilot
label: "AutoPilot task"
desc: "Long-horizon self-driving task — advance one step per tick from the loop's README.md, self-pace, run to convergence"
tags: [autopilot, agentic, self-pacing, case2]
slots:
  - {name: taskFile, prompt: "Path to the task doc (the loop's README.md) — its Spec and running progress both live there", required: true, kind: path}
  - {name: workdir, prompt: "Which project directory does it run in?", required: true, kind: workdir}
  - {name: cadence, prompt: "How often should it advance a tick? (optional — default every 3 hours)", kind: cron, default: "0 */3 * * *"}
---
You're helping the user build an "AutoPilot" loop (Case 2): long-horizon, self-driving — advance one step each tick until it converges or gets stuck. You only need two things: the task doc {taskFile} (Spec + progress both live there) and where it runs {workdir}. Everything else — the goal, the sub-steps, the cadence — lives in the README.md or is the agent's call.

Compile the intent into a Job:

- No `workflow` — every tick needs the agent to decide the next step.
- Bind `exec` (executor=claude), `workdir` = {workdir}. Use `taskFile` = {taskFile} as-is; don't create another.
- `allowControl` defaults to true: the agent self-paces with `loop reschedule` / `loop set-cron` (tighten as it nears the goal, ease off when stuck), and stops itself with `loop pause` when done.
- `notify` defaults to `auto` (report only on real progress). `cron`: per {cadence}, default every 3 hours.
