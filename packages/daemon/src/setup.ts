/**
 * `loopany setup hooks [--remove]` — install (idempotent, best-effort) a SessionStart
 * hook for each coding agent in `SKILL_TARGET_AGENTS`, mirroring gh-axi's `setup hooks`
 * UX (P7). The hook runs `loopany` (the bare home view) at every session open, so its
 * TOON dashboard lands as ambient context — the machine's live loops + recent runs,
 * or the definitive "run `loopany up`" line when it isn't connected (so the hook is
 * never noise; it self-heals). `loopany up` invokes this best-effort, exactly like the
 * skill install, and it NEVER blocks/fails `up`.
 *
 * Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`), and Grok Build
 * (`~/.grok/hooks/loopany.json`) all have a concrete SessionStart mechanism, keyed by
 * `CodingAgent` id via `HOOK_TARGET_AGENTS`. All store hooks under the IDENTICAL
 * `{ hooks: { SessionStart: [...] } }` JSON shape, so they share one merge routine
 * (`installJsonSessionStartHook`) and covering a further agent is a one-entry addition,
 * never a router change. Any target agent without an installer is reported as skipped.
 * `HOOK_TARGET_AGENTS` is a SUPERSET of `SKILL_TARGET_AGENTS` (grok gets a hook but is
 * not a skill-install target — it reads Claude's skills dir; see that list's comment).
 *
 * CODEX DISCREPANCY (verified against codex-cli 0.143.0 + the /openai/codex source):
 * Codex additionally gates hooks behind `hooks = true` in `~/.codex/config.toml` AND a
 * per-hook TRUST layer — every entry in `hooks.json` needs a matching
 * `[hooks.state."<file>:<event>:<i>:<j>"] trusted_hash = "sha256:…"` in config.toml, where
 * the hash is a SHA256 over a CANONICAL-TOML normalization of the hook identity computed
 * inside Codex (`codex-rs/hooks/.../discovery.rs command_hook_hash`). That hash is
 * internal + version-sensitive, so this installer deliberately does NOT synthesize it —
 * it only writes the `hooks.json` entry (exactly as gh-axi/chrome-devtools-axi/lavish-axi
 * already register themselves there) and surfaces that Codex will prompt to TRUST the
 * hook (and needs `hooks = true`) on first session. This keeps the blast radius to a
 * single JSON file, mirroring the Claude installer, and never mutates the user's TOML.
 *
 * The hook only installs when a DURABLE `loopany` command is resolvable
 * (`resolveDurableCommand`: our PATH shim OR a global install). The automatic
 * up/update path (`refreshHooks`) SKIPS the hook with one line of guidance when only a
 * bare, non-PATH `loopany` would result (the common `npx … up` flow with no global
 * install) — a hook pointing at a missing binary would fail EVERY subsequent session.
 * The explicit `loopany setup hooks` verb still installs (the user asked for it) but
 * warns before falling back to bare `loopany`.
 *
 * Every filesystem touch is an injectable seam so tests never read/write the real home.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDurableCommand } from "./bin-shim.js";
import { SKILL_TARGET_AGENTS } from "./skill-install.js";

export interface SetupDeps {
  /** Read a file's text; throws (ENOENT) when absent — the installer treats that as
   *  "no settings yet" and starts from an empty object. */
  readFile?: (p: string) => string;
  writeFile?: (p: string, s: string) => void;
  mkdir?: (p: string) => void;
  homedir?: () => string;
  /** The command the hook runs. When set it is used verbatim (and treated as durable);
   *  when absent it is resolved via `resolveCommand`. */
  command?: string;
  /** Resolve the DURABLE hook command (our shim path or a PATH-resolvable `loopany`),
   *  null when only a bare, non-PATH `loopany` would result. Injectable for tests. */
  resolveCommand?: () => string | null;
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

function seams(d: SetupDeps, command: string): Seams {
  return {
    readFile: d.readFile ?? ((p) => fs.readFileSync(p, "utf8")),
    writeFile: d.writeFile ?? ((p, s) => fs.writeFileSync(p, s)),
    mkdir: d.mkdir ?? ((p) => void fs.mkdirSync(p, { recursive: true })),
    homedir: d.homedir ?? os.homedir,
    command,
    out: d.out ?? ((s) => void process.stdout.write(s)),
    err: d.err ?? ((s) => void process.stderr.write(s)),
  };
}

/** Resolve the DURABLE hook command: an explicitly-injected `command` (treated as
 *  durable), else `resolveCommand()`. Null ⇒ only a bare, non-PATH `loopany` exists. */
function durableCommand(d: SetupDeps): string | null {
  if (d.command !== undefined) return d.command;
  return (d.resolveCommand ?? resolveDurableCommand)();
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

/** Merge our bare-`loopany` SessionStart command hook into a JSON hooks file whose
 *  root carries `{ hooks: { SessionStart: [...] } }`. Shared by Claude Code
 *  (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`): identical shape, so
 *  one routine owns the idempotent add / preserve-everyone-else / `--remove` logic and
 *  the two surfaces cannot drift. Only OUR entry is ever touched; other SessionStart
 *  entries, other events, and other root keys are preserved verbatim. */
function installJsonSessionStartHook(s: Seams, remove: boolean, dir: string, file: string): string {
  let root: Record<string, unknown> = {};
  try {
    root = JSON.parse(s.readFile(file)) as Record<string, unknown>;
    if (!root || typeof root !== "object" || Array.isArray(root)) root = {};
  } catch {
    root = {}; // absent or unparseable → start fresh (we only touch SessionStart)
  }

  const hooks = (typeof root.hooks === "object" && root.hooks && !Array.isArray(root.hooks)
    ? (root.hooks as Record<string, unknown>)
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
    root.hooks = hooks;
    s.mkdir(dir);
    s.writeFile(file, JSON.stringify(root, null, 2) + "\n");
    return "removed";
  }

  withoutOurs.push({ hooks: [{ type: "command", command: s.command }] });
  hooks.SessionStart = withoutOurs;
  root.hooks = hooks;
  s.mkdir(dir);
  s.writeFile(file, JSON.stringify(root, null, 2) + "\n");
  return already ? "refreshed" : "installed";
}

/** Claude Code: a SessionStart command hook in `~/.claude/settings.json`. */
const installClaudeCodeHook: HookInstaller = (s, remove) => {
  const dir = path.join(s.homedir(), ".claude");
  return installJsonSessionStartHook(s, remove, dir, path.join(dir, "settings.json"));
};

/** Codex: a SessionStart command hook in `~/.codex/hooks.json` — the JSON hooks file
 *  Codex discovers alongside `config.toml` (same `{ hooks: { SessionStart } }` schema as
 *  Claude's settings.json). Codex ALSO requires hooks to be enabled (`hooks = true`) and
 *  the entry to be TRUSTED on first session; we surface that in the report rather than
 *  reaching into the user's TOML (see the module header). */
const installCodexHook: HookInstaller = (s, remove) => {
  const dir = path.join(s.homedir(), ".codex");
  return installJsonSessionStartHook(s, remove, dir, path.join(dir, "hooks.json"));
};

/** Grok Build: a SessionStart command hook in `~/.grok/hooks/loopany.json`. Grok's
 *  hook schema is byte-identical to Claude's `{ hooks: { SessionStart } }`, and grok
 *  loads GLOBAL hooks as one-file-per-tool under `~/.grok/hooks/*.json` that are ALWAYS
 *  TRUSTED — no `hooks = true` config gate and no per-hook trust-hash like Codex — so
 *  writing our dedicated `loopany.json` makes the hook live immediately (no enable/trust
 *  note needed). The shared merge routine still owns the idempotent add / `--remove`. */
const installGrokHook: HookInstaller = (s, remove) => {
  const dir = path.join(s.homedir(), ".grok", "hooks");
  return installJsonSessionStartHook(s, remove, dir, path.join(dir, "loopany.json"));
};

/** Installers keyed by `CodingAgent` id. An agent in `HOOK_TARGET_AGENTS` with no
 *  entry is reported `skipped (no session-hook integration yet)`. */
const HOOK_INSTALLERS: Record<string, HookInstaller> = {
  "claude-code": installClaudeCodeHook,
  codex: installCodexHook,
  grok: installGrokHook,
};

/** Agents that get a SessionStart hook. A SUPERSET of `SKILL_TARGET_AGENTS`: grok
 *  additionally gets a hook but is deliberately NOT a skill-install target — grok
 *  reads Claude's `~/.claude/skills`, and `skills add -a grok` is not a known `skills`
 *  CLI agent id, so bundling it would risk breaking the shared `skills add` for every
 *  agent. Extend this list (plus a `HOOK_INSTALLERS` entry) to cover a new agent. */
const HOOK_TARGET_AGENTS: ReadonlyArray<{ id: string; label: string }> = [
  ...SKILL_TARGET_AGENTS.map((a) => ({ id: a.id, label: a.label })),
  { id: "grok", label: "Grok Build" },
];

/** Whether Codex is a target with an installer — gates the Codex trust/enable note in
 *  the report (so it never appears if Codex is dropped from `SKILL_TARGET_AGENTS`). */
function codexInstalled(outcomes: AgentOutcome[]): boolean {
  return (
    HOOK_INSTALLERS.codex !== undefined &&
    outcomes.some((o) => o.agent === "Codex" && (o.status === "installed" || o.status === "refreshed"))
  );
}

export async function runSetup(args: string[], injected: SetupDeps = {}): Promise<number> {
  const durable = durableCommand(injected);
  const s = seams(injected, durable ?? "loopany");
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
  // The explicit verb still installs (the user asked for it), but a bare, non-PATH
  // `loopany` hook fails every session — warn before falling back to it.
  if (!remove && durable === null) {
    s.err(
      "loopany: no durable `loopany` on PATH — the SessionStart hook will run bare `loopany`; install globally for a stable bin: npm i -g @crewlet/loopany\n",
    );
  }
  const outcomes = installHooks(s, remove);
  reportHooks(s, outcomes, remove);
  return 0;
}

/** Run every target agent's installer, catching per-agent failures (best-effort). */
export function installHooks(s: Seams, remove: boolean): AgentOutcome[] {
  return HOOK_TARGET_AGENTS.map((a) => {
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
    const command = durableCommand(injected);
    // No durable `loopany` (npx-without-global): DON'T write a hook that would fail
    // every session — skip with one line of guidance, mirroring the PATH shim's skip.
    if (command === null) {
      const out = injected.out ?? ((s: string) => void process.stdout.write(s));
      out(
        "loopany: skipped the SessionStart hook (no durable `loopany` on PATH); install globally for the ambient home view: npm i -g @crewlet/loopany\n",
      );
      return;
    }
    const s = seams(injected, command);
    const outcomes = installHooks(s, false);
    const done = outcomes.filter((o) => o.status === "installed" || o.status === "refreshed").map((o) => o.agent);
    s.out(done.length ? `loopany hooks: SessionStart home view → ${done.join(", ")}\n` : "loopany hooks: up to date\n");
    // Codex gates hooks behind `hooks = true` + a first-session trust prompt; the
    // installer only writes the entry, so surface the enable/trust step here too (not
    // just the explicit `setup hooks` verb) — matching loopany's never-silent pattern.
    if (codexInstalled(outcomes)) {
      s.out(
        "loopany hooks: Codex needs `hooks = true` in ~/.codex/config.toml and the loopany hook trusted on first session\n",
      );
    }
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
  // Codex gates hooks behind `hooks = true` + a per-hook trust prompt; the installer
  // only writes the entry, so tell the user about the one-time enable/trust step.
  const codexNote = !remove && codexInstalled(outcomes);
  s.out(`help[${codexNote ? 2 : 1}]:\n`);
  s.out(
    remove
      ? "  Run `loopany setup hooks` to reinstall the SessionStart home view\n"
      : "  Restart your coding-agent session so the SessionStart home view takes effect\n",
  );
  if (codexNote) {
    s.out(
      "  Codex only: set `hooks = true` in ~/.codex/config.toml and trust the loopany hook when Codex prompts on first session\n",
    );
  }
}
