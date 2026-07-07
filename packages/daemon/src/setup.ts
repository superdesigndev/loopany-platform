/**
 * `loopany setup hooks [--remove]` — install (idempotent, best-effort) a SessionStart
 * hook for each coding agent in `SKILL_TARGET_AGENTS`, mirroring gh-axi's `setup hooks`
 * UX (P7). The hook runs `loopany` (the bare home view) at every session open, so its
 * TOON dashboard lands as ambient context — the machine's live loops + recent runs,
 * or the definitive "run `loopany up`" line when it isn't connected (so the hook is
 * never noise; it self-heals). `loopany up` invokes this best-effort, exactly like the
 * skill install, and it NEVER blocks/fails `up`.
 *
 * Today only Claude Code has a concrete SessionStart mechanism
 * (`~/.claude/settings.json`); other target agents are reported as skipped until an
 * installer is added (the map is keyed by the same agent ids as `SKILL_TARGET_AGENTS`,
 * so covering a new agent is a one-entry addition, never a router change).
 *
 * Every filesystem touch is an injectable seam so tests never read/write the real home.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { existingBinShim } from "./bin-shim.js";
import { SKILL_TARGET_AGENTS } from "./skill-install.js";

export interface SetupDeps {
  /** Read a file's text; throws (ENOENT) when absent — the installer treats that as
   *  "no settings yet" and starts from an empty object. */
  readFile?: (p: string) => string;
  writeFile?: (p: string, s: string) => void;
  mkdir?: (p: string) => void;
  homedir?: () => string;
  /** The command the hook runs — defaults to the installed PATH shim, else `loopany`. */
  command?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

type Seams = {
  readFile: (p: string) => string;
  writeFile: (p: string, s: string) => void;
  mkdir: (p: string) => void;
  homedir: () => string;
  command: string;
  out: (s: string) => void;
  err: (s: string) => void;
};

function seams(d: SetupDeps): Seams {
  return {
    readFile: d.readFile ?? ((p) => fs.readFileSync(p, "utf8")),
    writeFile: d.writeFile ?? ((p, s) => fs.writeFileSync(p, s)),
    mkdir: d.mkdir ?? ((p) => void fs.mkdirSync(p, { recursive: true })),
    homedir: d.homedir ?? os.homedir,
    command: d.command ?? existingBinShim() ?? "loopany",
    out: d.out ?? ((s) => void process.stdout.write(s)),
    err: d.err ?? ((s) => void process.stderr.write(s)),
  };
}

type AgentOutcome = { agent: string; status: string };

/** A per-agent SessionStart hook installer. `remove` uninstalls our entry instead of
 *  adding it. Returns a short status token for the report. Best-effort — a thrown
 *  error is caught by the caller and reported as `skipped (…)`. */
type HookInstaller = (s: Seams, remove: boolean) => string;

/** Whether a Claude Code SessionStart entry is OURS — matches the bare `loopany`
 *  command (our exact command, or any `…/loopany`/`loopany` command), so an idempotent
 *  re-install replaces it and `--remove` finds it regardless of the shim path. */
function isOurHookCommand(command: unknown, ours: string): boolean {
  if (typeof command !== "string") return false;
  const c = command.trim();
  return c === ours || c === "loopany" || c.endsWith("/loopany") || c === "loopany home";
}

/** Claude Code: a SessionStart command hook in `~/.claude/settings.json`. */
const installClaudeCodeHook: HookInstaller = (s, remove) => {
  const dir = path.join(s.homedir(), ".claude");
  const file = path.join(dir, "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(s.readFile(file)) as Record<string, unknown>;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  } catch {
    settings = {}; // absent or unparseable → start fresh (we only touch SessionStart)
  }

  const hooks = (typeof settings.hooks === "object" && settings.hooks && !Array.isArray(settings.hooks)
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const sessionStart = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];

  // Drop any prior loopany entry (idempotent install; the remove path stops here).
  const withoutOurs = sessionStart.filter((entry) => {
    const inner = entry && typeof entry === "object" ? (entry as { hooks?: unknown }).hooks : undefined;
    if (!Array.isArray(inner)) return true;
    return !inner.some((h) => isOurHookCommand((h as { command?: unknown })?.command, s.command));
  });

  const already = withoutOurs.length !== sessionStart.length;
  if (remove) {
    if (!already) return "not installed";
    hooks.SessionStart = withoutOurs;
    if (Array.isArray(hooks.SessionStart) && (hooks.SessionStart as unknown[]).length === 0) delete hooks.SessionStart;
    settings.hooks = hooks;
    s.mkdir(dir);
    s.writeFile(file, JSON.stringify(settings, null, 2) + "\n");
    return "removed";
  }

  withoutOurs.push({ hooks: [{ type: "command", command: s.command }] });
  hooks.SessionStart = withoutOurs;
  settings.hooks = hooks;
  s.mkdir(dir);
  s.writeFile(file, JSON.stringify(settings, null, 2) + "\n");
  return already ? "refreshed" : "installed";
};

/** Installers keyed by the same agent ids as `SKILL_TARGET_AGENTS`. An agent with no
 *  entry is reported `skipped (no session-hook integration yet)`. */
const HOOK_INSTALLERS: Record<string, HookInstaller> = {
  "claude-code": installClaudeCodeHook,
};

export async function runSetup(args: string[], injected: SetupDeps = {}): Promise<number> {
  const s = seams(injected);
  const sub = args[0];

  if (sub === undefined) {
    // Bare `loopany setup` — what it does + the one sub-action (mirrors gh-axi).
    s.out(
      "setup: configure Loopany's ambient integrations for this machine.\n" +
        "help[1]:\n" +
        "  Run `loopany setup hooks` to install the SessionStart hook (home view as ambient context)\n",
    );
    return 0;
  }
  if (sub !== "hooks") {
    s.err(`loopany: unknown setup command "${sub}" — try \`loopany setup hooks\`\n`);
    return 2;
  }

  const remove = args.includes("--remove");
  const outcomes = installHooks(s, remove);
  reportHooks(s, outcomes, remove);
  return 0;
}

/** Run every target agent's installer, catching per-agent failures (best-effort). */
export function installHooks(s: Seams, remove: boolean): AgentOutcome[] {
  return SKILL_TARGET_AGENTS.map((a) => {
    const installer = HOOK_INSTALLERS[a.id];
    if (!installer) return { agent: a.label, status: "skipped (no session-hook integration yet)" };
    try {
      return { agent: a.label, status: installer(s, remove) };
    } catch (err) {
      return { agent: a.label, status: `skipped (${err instanceof Error ? err.message : String(err)})` };
    }
  });
}

/**
 * Best-effort hook refresh for `loopany up`/`update` — installs the SessionStart hook
 * for every target agent and prints ONE concise line, swallowing every error (like the
 * skill refresh, it must never block or fail `up`). Idempotent: a fresh install and a
 * re-install both converge on the same single entry per agent.
 */
export async function refreshHooks(injected: SetupDeps = {}): Promise<void> {
  try {
    const s = seams(injected);
    const outcomes = installHooks(s, false);
    const done = outcomes.filter((o) => o.status === "installed" || o.status === "refreshed").map((o) => o.agent);
    s.out(done.length ? `loopany hooks: SessionStart home view → ${done.join(", ")}\n` : "loopany hooks: up to date\n");
  } catch {
    /* never let a hook refresh fail `up` */
  }
}

/** Print the gh-axi-style status report: a per-agent list + a restart-your-session
 *  hint (a freshly-installed hook only takes effect next session). */
function reportHooks(s: Seams, outcomes: AgentOutcome[], remove: boolean): void {
  s.out(`setup hooks: ${remove ? "removed" : "installed"}\n`);
  s.out(`integrations[${outcomes.length}]{agent,status}:\n`);
  for (const o of outcomes) s.out(`  ${o.agent},${o.status}\n`);
  s.out("help[1]:\n");
  s.out(
    remove
      ? "  Run `loopany setup hooks` to reinstall the SessionStart home view\n"
      : "  Restart your coding-agent session so the SessionStart home view takes effect\n",
  );
}
