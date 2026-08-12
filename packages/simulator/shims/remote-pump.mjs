#!/usr/bin/env node
/**
 * The REMOTE PUMP - the simulator's miniature daemon (remote tier). When a
 * scenario runs against a DEPLOYED server, `tick --spawn` is off the table by
 * design (the local host loop refuses a remote backend); the production path is
 * poll -> rk_ delivery -> spawn -> run-finish, owned by the real daemon. This
 * shim replays exactly that loop, synchronously per engine tick, so the engine
 * stays a sync day-driver and the daemon boundary stays out-of-process.
 *
 * Modes (argv[2]):
 *   enroll   one clean poll (registers the machine + its alias); prints ok
 *   pump     poll for kernel deliveries; for each: spawn the profile for the
 *            delivered agent segment (prompt via {{prompt}} argv token or
 *            stdin), then run-finish on the delivered rk_ credential with the
 *            VIRTUAL now (requires the LOOPANY_KERNEL_SIM_AUTHORITY capability
 *            matching the server's LOOPANY_KERNEL_SIM_SECRET).
 *            Repeats until a poll delivers nothing (a run's own writes may mint
 *            follow-on runs). Prints a JSON report.
 *   read     dump the remote read body (snapshot + events + machinePresence) -
 *            the per-day remote state capture.
 *
 * Env contract (the engine threads all of these):
 *   LOOPANY_KERNEL_BACKEND  server base URL (required)
 *   LOOPANY_KERNEL_TOKEN    the dk_ DEVICE credential (poll + read); children
 *                           get the per-run rk_ overriding this
 *   LOOPANY_SIM_ALIAS       the machine alias (assignee machine segment)
 *   LOOPANY_NOW             the virtual instant (finish + read `now`)
 *   cwd                     the sandbox workspace (profiles from .loopany/config.json)
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.LOOPANY_KERNEL_BACKEND;
const TOKEN = process.env.LOOPANY_KERNEL_TOKEN;
const ALIAS = process.env.LOOPANY_SIM_ALIAS ?? "sim";
const NOW = process.env.LOOPANY_NOW;
const mode = process.argv[2];

if (!BASE || !TOKEN || !mode) {
  process.stderr.write("remote-pump: needs LOOPANY_KERNEL_BACKEND + LOOPANY_KERNEL_TOKEN + a mode\n");
  process.exit(2);
}

async function poll() {
  const res = await fetch(`${BASE}/api/machine/poll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "sim.local", alias: ALIAS, kernelInFlight: [] }),
  });
  if (!res.ok) throw new Error(`poll -> ${res.status}`);
  return res.json();
}

async function kernelCli(credential, body) {
  // The sim time authority (kernel-authority-clock-seam): a virtual `now` on a
  // run credential is honored ONLY with this capability presented.
  const simAuthority = process.env.LOOPANY_KERNEL_SIM_AUTHORITY;
  const res = await fetch(`${BASE}/api/kernel/cli`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify(simAuthority ? { ...body, simAuthority } : body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function readProfiles() {
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".loopany", "config.json"), "utf8"));
    return cfg.profiles ?? {};
  } catch {
    return {};
  }
}

/** Spawn one delivered run through its profile; mirror spawn.ts semantics:
 *  {{prompt}} on argv else stdin, one immediate retry, exit 0 = done. */
function spawnDelivery(d, profile) {
  const args = (profile.args ?? []).map((a) => (a === "{{prompt}}" ? d.prompt : a));
  const onArgv = (profile.args ?? []).includes("{{prompt}}");
  const env = {
    ...process.env,
    LOOPANY_KERNEL_TOKEN: d.runToken, // the rk_ lease - in-run callbacks ride it
    LOOPANY_TASK_ID: d.taskId,
    LOOPANY_RUN_ID: d.runId,
    LOOPANY_SESSION_ID: `spawn-${d.runId}`,
    LOOPANY_ACTOR: d.runId,
  };
  const run = () =>
    spawnSync(profile.cmd, args, {
      cwd: d.workdir ?? process.cwd(),
      env,
      input: onArgv ? undefined : d.prompt,
      encoding: "utf8",
    });
  let res = run();
  let retried = false;
  if ((res.status ?? 1) !== 0) {
    retried = true;
    res = run();
  }
  return { status: res.status ?? 1, retried, stderr: res.stderr ?? "" };
}

if (mode === "enroll") {
  await poll();
  process.stdout.write(`enrolled ${ALIAS}\n`);
  process.exit(0);
}

if (mode === "read") {
  const { status, body } = await kernelCli(TOKEN, { read: true, now: NOW });
  if (status !== 200) {
    process.stderr.write(`read -> ${status}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

if (mode !== "pump") {
  process.stderr.write(`remote-pump: unknown mode "${mode}"\n`);
  process.exit(2);
}

const profiles = readProfiles();
const spawned = [];
const notices = [];

// Poll until dry: a spawned run may reassign/create, minting follow-on runs.
for (let round = 0; round < 8; round++) {
  const body = await poll();
  const deliveries = Array.isArray(body.kernelRuns) ? body.kernelRuns : [];
  if (deliveries.length === 0) break;
  for (const d of deliveries) {
    const profile = profiles[d.agent];
    if (!profile) {
      // The server already claimed the run at delivery; a missing profile is a
      // FAILED run with a clear note (parity with the daemon's behavior), never
      // a silently-lost claim.
      notices.push(`no profile for agent "${d.agent}" - run ${d.runId} finished failed`);
      await kernelCli(d.runToken, {
        command: { op: "run-finish", runId: d.runId, outcome: "failed", note: `no executor profile for "${d.agent}" on this machine` },
        now: NOW,
      });
      continue;
    }
    const res = spawnDelivery(d, profile);
    const outcome = res.status === 0 ? "done" : "failed";
    const note =
      outcome === "done"
        ? `agent run completed (exit 0${res.retried ? ", after one retry" : ""})`
        : `agent run failed (exit ${res.status}, incl. one retry)${res.stderr ? `: ${res.stderr.slice(-300)}` : ""}`;
    const fin = await kernelCli(d.runToken, {
      command: { op: "run-finish", runId: d.runId, outcome, note },
      now: NOW,
    });
    if (fin.status !== 200) notices.push(`run-finish ${d.runId} -> ${fin.status}`);
    spawned.push({ runId: d.runId, taskId: d.taskId, agent: d.agent, outcome, status: res.status });
  }
}

process.stdout.write(JSON.stringify({ spawned, notices }) + "\n");
process.exit(0);
