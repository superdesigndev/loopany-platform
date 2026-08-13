import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { LOOPANY_DIR } from "./config.js";

export const SOCKET_DIR = path.join(LOOPANY_DIR, "run");
export const SOCKET_FILE = path.join(SOCKET_DIR, "daemon.sock");

export async function queryLocalSocket(op: "status" | "wake", timeoutMs = 750): Promise<Record<string, unknown> | undefined> {
  try {
    const dir = fs.lstatSync(SOCKET_DIR);
    const socketFile = fs.lstatSync(SOCKET_FILE);
    if (dir.isSymbolicLink() || socketFile.isSymbolicLink() || dir.uid !== process.getuid?.() || socketFile.uid !== process.getuid?.()) return undefined;
  } catch { return undefined; }
  return new Promise(resolve => {
    const socket = net.createConnection(SOCKET_FILE);
    let settled = false;
    let raw = "";
    const finish = (value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish());
    socket.on("error", () => finish());
    socket.on("data", chunk => { raw += chunk; if (raw.includes("\n")) { try { finish(JSON.parse(raw) as Record<string, unknown>); } catch { finish(); } } });
    socket.on("connect", () => socket.end(JSON.stringify({ op }) + "\n"));
    socket.on("close", () => { if (!settled) { try { finish(JSON.parse(raw) as Record<string, unknown>); } catch { finish(); } } });
  });
}

export async function startLocalSocket(status: () => Record<string, unknown>): Promise<() => Promise<void>> {
  fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(SOCKET_DIR);
  if (dir.isSymbolicLink() || dir.uid !== process.getuid?.()) throw new Error("unsafe Loopany socket directory ownership");
  try {
    const existing = fs.lstatSync(SOCKET_FILE);
    if (existing.isSymbolicLink()) throw new Error("refusing symlink daemon socket");
    fs.rmSync(SOCKET_FILE);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    socket.once("data", raw => {
      let request: { op?: string } = {};
      try { request = JSON.parse(String(raw)) as { op?: string }; } catch {}
      // Fixed local operations only. This socket never accepts a URL, token,
      // argv, or remote request payload and therefore cannot proxy mk_ authority.
      const response = request.op === "status" ? { ok: true, ...status() } : request.op === "wake" ? { ok: true, awake: true } : { ok: false, error: "unsupported local operation" };
      socket.end(JSON.stringify(response) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(SOCKET_FILE, resolve); });
  fs.chmodSync(SOCKET_FILE, 0o600);
  return async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(SOCKET_FILE, { force: true }); };
}
