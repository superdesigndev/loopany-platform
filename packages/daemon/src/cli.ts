#!/usr/bin/env node
/**
 * adScaile daemon — one binary, many roles (BYOA MINIMAL_DAEMON §1):
 *
 *   adscaile                    → the content-first HOME (P8): a live machine
 *                                dashboard on the device credential (in a run, the
 *                                run's own-loop context). NO LONGER the poll loop.
 *   adscaile up [--foreground]  → setup mode: ensure a daemon is running for this
 *                                machine (idempotent; installs the session hook + PATH
 *                                shim). `--foreground` runs the poll loop attached in
 *                                this terminal (the old bare-`adscaile` behavior).
 *   adscaile setup hooks        → install/refresh the SessionStart hook that lands the
 *     [--remove]                 home view as ambient context each session (P7).
 *   adscaile new --config […]   → setup mode: create a loop from a config file,
 *                                filling timezone/claim/auth — folds SKILL.md §3–4.
 *   adscaile skill [status|install] → install the adscaile agent skill at USER scope
 *                                via `npx skills` (best-effort; the manual escape hatch
 *                                — `adscaile up`/`new` also refresh ~/.claude/skills).
 *   adscaile update             → setup mode: hand the running daemon over to this
 *                                (newer) CLI — stop the old daemon, start this one,
 *                                refresh the skill (this CLI is already the new version).
 *   adscaile status             → setup mode: report whether THIS machine's daemon
 *                                is running (local pid) + its connection state.
 *   adscaile down               → setup mode: stop the detached daemon `up` started.
 *   adscaile log [<loop>]       → read mode: print a loop's recent run history
 *                                (status + transcript) for the loop in this workdir.
 *   adscaile --help | -h | help → print usage (leads with the version) and exit
 *                                (NEVER start the daemon).
 *   adscaile --version | -v     → print just the daemon version and exit.
 *   adscaile loops|edit […]     → interactive mode: the owner edits a loop from
 *                                their own coding agent, reusing the persisted
 *                                device token.
 *   adscaile <verb> [...flags]  → callback mode (when ADSCAILE_RUN_TOKEN is set;
 *                                claude calls this via the PATH wrapper).
 *
 * The loop verbs (report, finish, show, log, set-cron, reschedule, loops, edit,
 * new, …) no longer split into two worlds: they all funnel through the shared CLI client
 * (`cli-client.ts` `postCli`), which attaches whatever credential the env carries —
 * the run token if `ADSCAILE_RUN_TOKEN` is set, else the persisted device token — and
 * POSTs `{argv}` to the ONE unified dispatch `/api/machine/cli`, falling back to the
 * legacy per-credential endpoints on a 404 (old server). Only the LOCAL verbs below
 * (up/down/update/skill/status/help/version/bare-daemon) keep their own fast-paths.
 */
import { classify } from "./route.js";

// Lazy-import per branch: claude re-execs this CLI for every `adscaile report …`
// callback, so keep that path from loading the daemon/interactive modules. The
// routing decision itself lives in the pure `route.ts` (unit-tested); this just maps
// each Route to its lazily-imported handler.
async function main(): Promise<number> {
  const r = classify(process.argv.slice(2), process.env);
  switch (r.kind) {
    case "callback":
      return (await import("./callback.js")).runCallback(r.argv);
    case "help": {
      const help = await import("./help.js");
      return r.verb ? help.printVerbHelp(r.verb) : help.printHelp();
    }
    case "version":
      return (await import("./help.js")).printVersion();
    case "daemon":
      return (await import("./daemon.js")).runDaemon();
    case "ensure":
      return (await import("./ensure.js")).runEnsure(r.args);
    case "create":
      return (await import("./create.js")).runCreate(r.args);
    case "skill":
      return (await import("./skill-cli.js")).runSkill(r.args);
    case "setup":
      return (await import("./setup.js")).runSetup(r.args);
    case "update":
      return (await import("./update.js")).runUpdate(r.args);
    case "status":
      return (await import("./control.js")).runStatus(r.args);
    case "down":
      return (await import("./control.js")).runDown(r.args);
    case "log":
      return (await import("./log.js")).runLog(r.args);
    case "show":
      return (await import("./show.js")).runShow(r.args);
    case "interactive":
      return (await import("./interactive.js")).runInteractive(r.argv);
    case "forward":
      return (await import("./callback.js")).runCallback(r.argv);
    case "home":
      return (await import("./home.js")).runHome();
    case "unknown":
      process.stderr.write(`adscaile: unknown command '${r.verb}' — try \`adscaile --help\`\n`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`adscaile: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
