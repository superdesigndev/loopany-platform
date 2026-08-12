import { selectBackend } from "../backend.js";

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

/** TTY refusal runs before the dynamic import, so pipes never load React/Ink. */
export async function launchKanban(options: KanbanLaunchOptions): Promise<number> {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    options.stderr.write("loopany-kernel kanban requires an interactive TTY\n");
    return 1;
  }
  const backend = selectBackend(options.cwd, options.env, undefined, { remote: options.remote ?? false });
  const { startKanban } = await import("./app.js");
  await startKanban(backend);
  return 0;
}
