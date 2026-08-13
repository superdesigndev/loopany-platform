import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "loopany-socket-"));
process.env.LOOPANY_HOME = home;
const socket = await import("./local-socket.js");

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

test("owner-only local socket exposes only fixed status and wake operations", async () => {
  const stop = await socket.startLocalSocket(() => ({ pid: 42, inFlight: 1 }));
  try {
    expect(fs.statSync(socket.SOCKET_DIR).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socket.SOCKET_FILE).mode & 0o777).toBe(0o600);
    expect(await socket.queryLocalSocket("status")).toMatchObject({ ok: true, pid: 42, inFlight: 1 });
    expect(await socket.queryLocalSocket("wake")).toEqual({ ok: true, awake: true });

    const unsupported = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = net.createConnection(socket.SOCKET_FILE);
      let raw = "";
      client.setEncoding("utf8");
      client.on("connect", () => client.end(JSON.stringify({ op: "proxy", url: "https://example.test", token: "secret" }) + "\n"));
      client.on("data", chunk => { raw += chunk; });
      client.on("error", reject);
      client.on("close", () => resolve(JSON.parse(raw) as Record<string, unknown>));
    });
    expect(unsupported).toEqual({ ok: false, error: "unsupported local operation" });
  } finally {
    await stop();
  }
});
