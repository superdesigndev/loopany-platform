# Workflow

A Workflow is optional executable configuration on a Task, not a separate
object. It runs on the assigned daemon before the Coding Agent. The server never
executes it.

The only format is `loopany-js-v1`: an async function body with `prev`, `fetch`,
`tools.call(name, args)`, and `agent(message?, data?)`. Top-level `await` and
`return` are valid. Static `import` and `export` are not; use dynamic `import()`.

```bash
lk workflow validate --file workflow.js
lk workflow set <task-id> --file workflow.js --if-version <version>
lk workflow show <task-id>
lk workflow clear <task-id> --if-version <version>
```

Return `{ message?, state? }`. `state` becomes the next Run's `prev`. Calling
`agent()` starts the assigned agent with the Workflow signal. Without it, a
message completes directly and no message is a silent Run. Failure does not
advance `state`; the original Task falls back to the agent with diagnostics.

The default wall-clock limit is 180 seconds. Keep secrets out of Workflow source.
