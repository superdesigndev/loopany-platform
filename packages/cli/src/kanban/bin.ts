#!/usr/bin/env node
import { launchKanban } from "./launch.js";

if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv[2] === "help") {
  process.stdout.write(
    "usage: lk kanban [--remote]\n\n" +
      "Open the interactive Board and Inbox. Auto-refreshes every 5s; press R to refresh now.\n",
  );
  process.exit(0);
}

const exitCode = await launchKanban({
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  remote: process.argv.includes("--remote"),
});
process.exit(exitCode);
