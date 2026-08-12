#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_URL = "https://loopany-kernel-live.fly.dev/t/team-shared/kernel";
const DEFAULT_PORT = 9232;

function usage() {
  console.log(`usage: open-in-codex.mjs [--attach] [--port <port>] [--url <https-url>]

Launch an independent Codex desktop window and embed Loopany Kernel Web.
  --attach       use an existing Codex CDP window on the selected port
  --port <port>  CDP port (default ${DEFAULT_PORT})
  --url <url>    Kernel Web URL (default ${DEFAULT_URL})`);
}

function args(argv) {
  const result = { attach: false, port: DEFAULT_PORT, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--help" || value === "-h") { usage(); process.exit(0); }
    if (value === "--attach") { result.attach = true; continue; }
    if (value === "--port") { result.port = Number(argv[++i]); continue; }
    if (value === "--url") { result.url = argv[++i]; continue; }
    throw new Error(`Unknown option: ${value}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error("--port must be an integer from 1024 to 65535");
  const parsed = new URL(result.url);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("--url must use HTTPS unless it is loopback");
  return result;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`);
  return (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const found = await targets(port);
      const target = found.find((item) => /chatgpt|codex/i.test(`${item.title} ${item.url}`)) || found[0];
      if (target) return target;
    } catch {}
    await delay(250);
  }
  throw new Error(`No Codex renderer found on CDP port ${port}`);
}

class Cdp {
  constructor(url) { this.id = 0; this.pending = new Map(); this.socket = new WebSocket(url); }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

async function launch(port) {
  const profile = join(homedir(), "Library", "Application Support", "Loopany Kernel Codex");
  await mkdir(profile, { recursive: true });
  const child = spawn("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

const options = args(process.argv.slice(2));
if (!options.attach) await launch(options.port);
const target = await waitForTarget(options.port);
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.setBypassCSP", { enabled: true });
const directory = dirname(fileURLToPath(import.meta.url));
const userScript = await readFile(join(directory, "inject.js"), "utf8");
const source = `window.__LOOPANY_KERNEL_WEB_URL__ = ${JSON.stringify(options.url)};\n${userScript}\n//# sourceURL=loopany-kernel-web.inject.js`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
await cdp.send("Page.reload", { ignoreCache: true });

const readyDeadline = Date.now() + 15_000;
let ready = false;
while (Date.now() < readyDeadline) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      entry: Boolean(document.getElementById("loopany-kernel-web-entry")),
      page: !document.getElementById("loopany-kernel-web-page")?.hidden,
      frame: document.getElementById("loopany-kernel-web-frame")?.dataset.loaded === "true"
    })`,
    returnByValue: true,
  });
  ready = Boolean(status.result?.value?.entry && status.result.value.page && status.result.value.frame);
  if (ready) break;
  await delay(250);
}
if (!ready) throw new Error("Loopany sidebar entry or embedded page did not become ready");

console.log(`Loopany is embedded in Codex at ${options.url}`);
console.log("Keep this process running. Press Ctrl+C to detach.");
const stop = async () => {
  try { await cdp.send("Runtime.evaluate", { expression: "window.__loopanyKernelWebInjection__?.destroy?.()" }); } catch {}
  cdp.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
