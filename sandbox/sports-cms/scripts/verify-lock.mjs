import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const imageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(imageDir, "image.lock.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(imageDir, "package-lock.json"), "utf8"));
const aptLock = await readFile(path.join(imageDir, "apt-packages.lock"));
const dockerfile = await readFile(path.join(imageDir, "Dockerfile"), "utf8");
const seccomp = await readFile(path.join(imageDir, "playwright-seccomp.json"));

assert.equal(lock.schemaVersion, 1);
assert.equal(lock.image.platform, "linux/amd64");
assert.match(lock.base.ref, /@sha256:[a-f0-9]{64}$/);
assert.equal(lock.runtime.uid, 10001);
assert.equal(lock.runtime.gid, 10001);
assert.match(lock.sportsCms.syntheticConfigSha256, /^[a-f0-9]{64}$/);
assert.equal(createHash("sha256").update(seccomp).digest("hex"), lock.runtime.playwrightSeccompSha256);
assert.equal(
  createHash("sha256").update(aptLock).digest("hex"),
  lock.ubuntu.packagesLockSha256,
  "apt package lock digest drifted",
);

for (const line of aptLock.toString("utf8").trim().split("\n")) {
  assert.match(line, /^[a-z0-9.+-]+=[^=\s]+$/, `unversioned apt entry: ${line}`);
}

const rootDependencies = packageLock.packages?.[""]?.dependencies ?? {};
for (const [name, expected] of Object.entries(lock.npmPackages)) {
  assert.equal(rootDependencies[name], expected.version, `${name} root pin drifted`);
  const entry = packageLock.packages?.[`node_modules/${name}`];
  assert(entry, `${name} missing from package-lock.json`);
  assert.equal(entry.version, expected.version, `${name} resolved version drifted`);
  if (expected.integrity) assert.equal(entry.integrity, expected.integrity, `${name} integrity drifted`);
}

assert(!/^FROM\s+\S+:(?:latest|master|main)(?:\s|$)/im.test(dockerfile), "Dockerfile contains a mutable base ref");
assert(!/(?:npm|pnpm)\s+(?:add|install)\s+\S+@(?:latest|next|\*)/i.test(dockerfile), "Dockerfile contains a mutable package ref");
assert(dockerfile.includes(lock.base.ref), "Dockerfile base does not match image.lock.json");
assert(dockerfile.includes("USER 10001:10001"));
assert(dockerfile.includes("AS negative-control"));
assert(!dockerfile.includes("apt-get upgrade"));

for (const ref of Object.values(lock.supplyChain)) {
  assert.match(ref, /@sha256:[a-f0-9]{64}$/);
}

process.stdout.write("image lock contract: ok\n");
