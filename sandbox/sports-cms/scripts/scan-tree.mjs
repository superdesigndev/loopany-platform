import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const root = path.resolve(args[0] ?? "");
const expectCanary = args.includes("--expect-canary");
const payloadOnly = args.includes("--payload-only");
const allowlistPath = args.includes("--allowlist")
  ? path.resolve(args[args.indexOf("--allowlist") + 1])
  : null;
if (!args[0]) throw new Error("usage: scan-tree.mjs <root> [--allowlist file] [--expect-canary]");

const allowlist = allowlistPath
  ? JSON.parse(await readFile(allowlistPath, "utf8")).files ?? {}
  : {};
const findings = [];
const canaryRules = new Set();
const rules = [
  ["PRIVATE_KEY", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ["TOKEN_ASSIGNMENT", /(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_+/.=-]{16,}/gi],
  ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["PHONE", /(?:\+49|0049)[ ()0-9/-]{8,}/g],
  ["IBAN", /\bDE\d{2}(?:[ ]?\d{4}){4}[ ]?\d{2}\b/g],
];
const forbiddenBasenames = new Set([
  ".env", ".npmrc", ".netrc", "auth.json", "credentials", "credentials.json", "known_hosts.old",
]);

function isPayload(relative) {
  return [
    "opt/project-golden/", "opt/adscaile/", "opt/agent-tools/", "usr/local/libexec/adscaile/",
    "tmp/platform/", "opt/adscaile-negative-control.txt",
  ].some((prefix) => relative === prefix.replace(/\/$/, "") || relative.startsWith(prefix));
}

function isPayloadOrAncestor(relative) {
  return isPayload(relative) || [
    "opt/project-golden", "opt/adscaile", "opt/agent-tools",
    "usr/local/libexec/adscaile", "tmp/platform",
  ].some((payload) => payload.startsWith(`${relative}/`));
}

function allowlistKeys(relative) {
  const keys = [relative];
  for (const [prefix, replacement] of [
    ["opt/project-golden/", "project-source/"],
    ["opt/agent-tools/", "agent-tools/"],
    ["tmp/platform/", "platform/"],
    ["usr/local/libexec/adscaile/", "image/runtime/"],
  ]) if (relative.startsWith(prefix)) keys.push(replacement + relative.slice(prefix.length));
  return keys;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    const stat = await lstat(absolute);
    if (payloadOnly && !isPayloadOrAncestor(relative)) continue;
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      const resolvedRelative = path.relative(root, resolved);
      const escapes = resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative);
      if (escapes || (payloadOnly && !isPayloadOrAncestor(resolvedRelative))) {
        findings.push({ rule: "SYMLINK", path: relative, sha256: null });
      }
      continue;
    }
    if (stat.isDirectory()) {
      if ([".git", ".ssh"].includes(entry.name)) findings.push({ rule: "FORBIDDEN_PATH", path: relative, sha256: null });
      else await walk(absolute);
      continue;
    }
    if (!stat.isFile()) continue;
    if (payloadOnly && !isPayload(relative)) continue;
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (forbiddenBasenames.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name)) {
      findings.push({ rule: "FORBIDDEN_PATH", path: relative, sha256 });
    }
    const text = bytes.toString("latin1");
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const value = match[0].toLowerCase();
        if (!expectCanary && rule === "EMAIL" && /@(example\.(?:com|org|net)|example\.invalid|not-a-real-company\.invalid)$/.test(value)) continue;
        const allowed = allowlistKeys(relative).map((key) => allowlist[key]).find(Boolean);
        if (allowed?.sha256 === sha256 && allowed?.rules?.includes(rule)) continue;
        findings.push({ rule, path: relative, sha256 });
        if (relative.endsWith("negative-control.txt")) canaryRules.add(rule);
        break;
      }
    }
  }
}

await walk(root);
findings.sort((a, b) => `${a.rule}:${a.path}`.localeCompare(`${b.rule}:${b.path}`));
for (const finding of findings) process.stdout.write(`${JSON.stringify(finding)}\n`);

if (expectCanary) {
  const expected = ["PRIVATE_KEY", "TOKEN_ASSIGNMENT", "EMAIL", "PHONE", "IBAN"];
  const missing = expected.filter((rule) => !canaryRules.has(rule));
  if (missing.length) throw new Error(`negative control missed rules: ${missing.join(",")}`);
  process.stdout.write("negative control: all sentinel classes detected\n");
} else if (findings.length) {
  process.stderr.write(`scanner: ${findings.length} redacted finding(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("scanner: clean\n");
}
