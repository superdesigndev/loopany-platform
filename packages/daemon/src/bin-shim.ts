/**
 * The durable `loopany` PATH shim (feedback #4). Users today run
 * `npx @crewlet/loopany@latest …`, paying npx startup per call — and the reference
 * axi tools all live at a real bin (`bin: ~/.local/share/.../bin/gh-axi`). `loopany
 * up` (and `loopany update`) write a tiny exec wrapper named `loopany` into a user
 * bin dir on PATH so subsequent calls (and the SessionStart hook, which runs
 * `loopany` every session open) resolve to a real binary with no npx overhead.
 *
 * The wrapper RE-EXECS this daemon's own launcher (execPath + execArgv + entry),
 * exactly like `callback-bin.ts` — so it stays version-consistent with whatever
 * `loopany up`/`update` was invoked as (`npx @crewlet/loopany@X`, `node dist/cli.js`,
 * `tsx src/cli.ts`). Writing the shim is BEST-EFFORT: any failure degrades to the
 * npx path and never fails `up`.
 *
 * Every external touch (write, mkdir, homedir, PATH) is an injectable seam so tests
 * never write into the real home dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Single-quote a string for safe interpolation into the /bin/sh wrapper. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The re-exec wrapper body (same shape as `callback-bin.ts`'s callback shim). */
export function shimContents(
  execPath = process.execPath,
  execArgv = process.execArgv,
  entry = process.argv[1] ?? "",
): string {
  const parts = [execPath, ...execArgv, entry].map(shQuote);
  return `#!/bin/sh\nexec ${parts.join(" ")} "$@"\n`;
}

export interface BinShimDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** Write the shim; throws (e.g. EACCES) → the caller falls back to ~/.local/bin. */
  writeShim?: (dir: string) => void;
  out?: (s: string) => void;
}

export interface BinShimResult {
  /** Absolute path to the installed `loopany` shim, or null if none could be written. */
  path: string | null;
  /** Whether the shim's dir is on PATH (drives the one-line guidance). */
  onPath: boolean;
}

/** The candidate bin dirs, most-preferred first: the npm GLOBAL bin (when running
 *  under npm/npx, `npm_config_prefix` points at the global prefix, and its `bin` is
 *  already on PATH), else the always-writable `~/.local/bin`. */
export function binDirCandidates(env: NodeJS.ProcessEnv, homedir: string): string[] {
  const dirs: string[] = [];
  const prefix = env.npm_config_prefix;
  if (prefix) dirs.push(path.join(prefix, "bin"));
  dirs.push(path.join(homedir, ".local", "bin"));
  return dirs;
}

/** Is `dir` on `PATH` (exact segment match, normalized)? */
export function dirOnPath(dir: string, pathVar: string | undefined): boolean {
  if (!pathVar) return false;
  const target = path.resolve(dir);
  return pathVar.split(path.delimiter).some((p) => p && path.resolve(p) === target);
}

/** Default writer: mkdir + write the 0755 shim into `dir`. */
function defaultWriteShim(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "loopany"), shimContents(), { mode: 0o755 });
}

/**
 * Write (idempotently) the `loopany` shim to the best writable bin dir and, when that
 * dir is not on PATH, print one copy-pasteable line of guidance. Best-effort: returns
 * `{path:null,onPath:false}` (announced) if every candidate fails to write.
 */
export function ensureBinShim(injected: BinShimDeps = {}): BinShimResult {
  const env = injected.env ?? process.env;
  const homedir = (injected.homedir ?? os.homedir)();
  const writeShim = injected.writeShim ?? defaultWriteShim;
  const out = injected.out ?? ((s: string) => void process.stdout.write(s));

  for (const dir of binDirCandidates(env, homedir)) {
    try {
      writeShim(dir);
    } catch {
      continue; // e.g. EACCES on a root-owned global bin — try the next candidate.
    }
    const shimPath = path.join(dir, "loopany");
    const onPath = dirOnPath(dir, env.PATH);
    if (!onPath) {
      out(`loopany: installed \`loopany\` to ${shimPath} — add it to your PATH: export PATH="${dir}:$PATH"\n`);
    }
    return { path: shimPath, onPath };
  }
  out("loopany: could not write a `loopany` PATH shim (keep using `npx @crewlet/loopany`)\n");
  return { path: null, onPath: false };
}

/** The installed shim's path (for the home view's `bin:` line) WITHOUT writing it —
 *  the first candidate that already has an executable `loopany`. Null when none. */
export function existingBinShim(injected: { env?: NodeJS.ProcessEnv; homedir?: () => string; exists?: (p: string) => boolean } = {}): string | null {
  const env = injected.env ?? process.env;
  const homedir = (injected.homedir ?? os.homedir)();
  const exists = injected.exists ?? ((p: string) => fs.existsSync(p));
  for (const dir of binDirCandidates(env, homedir)) {
    const p = path.join(dir, "loopany");
    if (exists(p)) return p;
  }
  return null;
}
