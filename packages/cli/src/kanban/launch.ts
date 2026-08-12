import { selectBackend } from "../backend.js";
import { readGlobalConnect } from "../connect.js";
import { execFileSync } from "node:child_process";

interface TtyInput {
  isTTY?: boolean;
}

interface TtyOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface KanbanLaunchOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: TtyInput;
  stdout: TtyOutput;
  stderr: TtyOutput;
  /** `--remote`: force the global `connect` binding (same flag as every verb). */
  remote?: boolean;
}

function localGitEmail(cwd: string): string | null {
  try {
    const email = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return email || null;
  } catch {
    return null;
  }
}

/** TTY refusal runs before the dynamic import, so pipes never load React/Ink. */
export async function launchKanban(options: KanbanLaunchOptions): Promise<number> {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    options.stderr.write("loopany-kernel kanban requires an interactive TTY\n");
    return 1;
  }
  const backend = selectBackend(options.cwd, options.env, undefined, { remote: options.remote ?? false });
  const me = options.env.LOOPANY_ACTOR ?? options.env.LOOPANY_INBOX ?? (
    backend.kind === "remote" ? readGlobalConnect(options.env)?.me ?? null : localGitEmail(options.cwd)
  );
  const { startKanban } = await import("./app.js");
  await startKanban(backend, me);
  return 0;
}
