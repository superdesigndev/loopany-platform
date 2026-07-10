import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const imageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(imageDir, file), "utf8");

test("machine-readable lock is internally consistent", () => {
  const output = execFileSync(process.execPath, [path.join(imageDir, "scripts/verify-lock.mjs")], { encoding: "utf8" });
  assert.match(output, /contract: ok/);
});

test("runtime wrappers are fail-closed and do not persist credentials", async () => {
  const wrapper = await read("runtime/run-agent");
  const askpass = await read("runtime/git-askpass");
  assert.match(wrapper, /unsupported worker alias/);
  assert.doesNotMatch(wrapper, /eval|sh -c/);
  assert.match(askpass, /ADSCAILE_GIT_TOKEN_FILE/);
  assert.doesNotMatch(askpass, /git config|extraHeader|credential\.helper/);
});

test("image build encodes hardened non-root runtime", async () => {
  const dockerfile = await read("Dockerfile");
  for (const value of [
    "USER 10001:10001",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "AS negative-control",
    "sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6",
  ]) assert(dockerfile.includes(value), `missing ${value}`);
  assert.doesNotMatch(dockerfile, /--no-sandbox|SYS_ADMIN|apt-get upgrade/);
});

test("all shell entrypoints parse as POSIX shell", () => {
  const scripts = [
    "runtime/adscaile", "runtime/run-agent", "runtime/git-askpass", "runtime/sandbox-entrypoint",
    "runtime/drupal-smoke.sh", "scripts/sanitize-project.sh", "scripts/prepare-context.sh",
    "scripts/build-image.sh", "scripts/smoke-image.sh", "scripts/scan-image.sh",
    "scripts/scan-layers.sh", "scripts/verify-negative-control.sh", "scripts/reproducible-build.sh",
    "scripts/pinned-builder.sh",
  ];
  for (const script of scripts) execFileSync("sh", ["-n", path.join(imageDir, script)]);
});

test("scanner does not skip large or binary credential-shaped input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adscaile-scanner-test-"));
  try {
    const prefix = Buffer.alloc(9 * 1024 * 1024, 0);
    await writeFile(path.join(root, "large.bin"), Buffer.concat([
      prefix,
      Buffer.from("token=adscaile_canary_secret_value_000000000000"),
    ]));
    assert.throws(() => execFileSync(process.execPath, [path.join(imageDir, "scripts/scan-tree.mjs"), root]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
