import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/agent-tools/node_modules/playwright");

const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error("usage: browser-smoke.mjs <url> <png>");

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console:${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`page:${error.message}`));
await page.goto(url, { waitUntil: "networkidle" });
await page.locator("body").waitFor({ state: "visible" });
await page.screenshot({ path: output, fullPage: true });
await browser.close();
if (errors.length) throw new Error(`browser errors: ${errors.length}`);
const bytes = await readFile(output);
process.stdout.write(`${createHash("sha256").update(bytes).digest("hex")}  ${output}\n`);
