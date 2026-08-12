#!/usr/bin/env node
import { launchKanban } from "./launch.js";

const exitCode = await launchKanban({
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  remote: process.argv.includes("--remote"),
});
process.exit(exitCode);
