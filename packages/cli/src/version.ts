import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function cliVersion(): string {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
}

export function versionBelow(value: string, minimum: string): boolean {
  const parts = (v: string) => v.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(value), b = parts(minimum);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! < b[i]!; }
  return false;
}
