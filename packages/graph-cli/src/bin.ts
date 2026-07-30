#!/usr/bin/env node
/**
 * The `graph` entry point. Everything real is in `cli.ts` behind injectable
 * seams, so this file is only the wiring - which is what lets the whole argv path
 * be probed without a network, a filesystem or a subprocess.
 */
import { defaultDeps, run } from "./cli.js";

const code = await run(process.argv.slice(2), defaultDeps());
process.exit(code);
