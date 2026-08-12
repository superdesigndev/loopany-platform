#!/usr/bin/env node
/**
 * REMOTE GATEWAY shim - honest name for what it is (kernel-real-daemon-simulator):
 * gateway PROTOCOL calls only, ZERO run-lifecycle ownership. The run lifecycle
 * (poll/dispatch/spawn/retry/finish) lives in the daemon's shared
 * kernel-lifecycle module, driven by src/remoteDaemon.ts - never here.
 *
 * Modes (argv[2]):
 *   enroll   one clean poll (registers the machine + its alias); prints ok
 *   read     dump the remote read body (snapshot + events + machinePresence) -
 *            the per-day remote state capture
 *
 * Env: LOOPANY_KERNEL_BACKEND, LOOPANY_KERNEL_TOKEN (dk_ device),
 *      LOOPANY_SIM_ALIAS, LOOPANY_NOW, LOOPANY_KERNEL_SIM_AUTHORITY.
 */

const BASE = process.env.LOOPANY_KERNEL_BACKEND;
const TOKEN = process.env.LOOPANY_KERNEL_TOKEN;
const ALIAS = process.env.LOOPANY_SIM_ALIAS ?? "sim";
const NOW = process.env.LOOPANY_NOW;
const mode = process.argv[2];

if (!BASE || !TOKEN || !mode) {
  process.stderr.write("remote-gateway: needs LOOPANY_KERNEL_BACKEND + LOOPANY_KERNEL_TOKEN + a mode\n");
  process.exit(2);
}

if (mode === "enroll") {
  const res = await fetch(`${BASE}/api/machine/poll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "sim.local", alias: ALIAS, kernelInFlight: [] }),
  });
  if (!res.ok) {
    process.stderr.write(`enroll -> ${res.status}\n`);
    process.exit(1);
  }
  process.stdout.write(`enrolled ${ALIAS}\n`);
  process.exit(0);
}

if (mode === "read") {
  const simAuthority = process.env.LOOPANY_KERNEL_SIM_AUTHORITY;
  const res = await fetch(`${BASE}/api/kernel/cli`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ read: true, now: NOW, ...(simAuthority ? { simAuthority } : {}) }),
  });
  if (res.status !== 200) {
    process.stderr.write(`read -> ${res.status}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(await res.json()));
  process.exit(0);
}

process.stderr.write(`remote-gateway: unknown mode "${mode}"\n`);
process.exit(2);
