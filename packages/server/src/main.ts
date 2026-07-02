/**
 * Standalone machine-facing server — boots the in-process backend (scheduler +
 * gateway) and serves the daemon endpoints over plain HTTP, plus a few admin
 * endpoints used for seeding/inspection (no auth — localhost; the authenticated
 * TanStack UI is a separate surface that shares this same SQLite DB).
 *
 *   POST /api/machine/poll   (Bearer device token)
 *   POST /agent-api/loop     (Bearer run token)
 *   POST /machine/report     (Bearer run token)
 *   admin: /api/machines, /api/loops, /api/loops/:id/run, /api/loops/:id/runs
 *
 * Run: `tsx src/main.ts` (or built). Port = LOOPANY_PORT (default 8787).
 */
import http from "node:http";

import { logger } from "./logger.js";
import * as store from "./db/store.js";
import { ensureServer } from "./server/boot.js";
import { machineIdFromToken, sha256 } from "./gateway/tokens.js";

const log = logger.child({ mod: "main" });
const DEMO_USER = "demo-user";

const { gateway, scheduler, abort } = ensureServer();

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 4_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else data += d.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function json(req: http.IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  void route(req, res).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "request failed");
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  });
});

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  // ---- machine endpoints ----
  if (m === "POST" && p === "/api/machine/poll") {
    const tok = bearer(req);
    if (!tok) return send(res, 401, { error: "missing device token" });
    const r = gateway.poll(tok);
    return send(res, r.status, r.body);
  }
  if (m === "POST" && p === "/agent-api/loop") {
    const tok = bearer(req);
    if (!tok) return send(res, 401, { text: "loopany: missing token", exitCode: 1 });
    const b = await json(req);
    const r = gateway.agentApi(tok, Array.isArray(b.argv) ? b.argv : []);
    return send(res, r.status, r.body);
  }
  if (m === "POST" && p === "/machine/report") {
    const tok = bearer(req);
    if (!tok) return send(res, 401, { error: "missing token" });
    const b = await json(req);
    const r = gateway.report(tok, b);
    return send(res, r.status, r.body);
  }

  // ---- admin (localhost; no auth in the standalone server) ----
  if (m === "POST" && p === "/api/machines") {
    const b = await json(req);
    if (!b.token || !b.name) return send(res, 400, { error: "token + name required" });
    const id = machineIdFromToken(b.token);
    const existing = store.getMachine(id);
    const machine = existing
      ? store.updateMachine(id, { name: b.name, roots: b.roots ?? null })
      : store.createMachine({ id, userId: b.userId ?? DEMO_USER, name: b.name, tokenHash: sha256(b.token), roots: b.roots ?? null, online: false });
    return send(res, 200, { machine });
  }
  if (m === "GET" && p === "/api/machines") {
    return send(res, 200, store.listMachines());
  }
  if (m === "POST" && p === "/api/loops") {
    const b = await json(req);
    if (!b.machineId || !b.cron) return send(res, 400, { error: "machineId + cron required" });
    const loop = store.createLoop({
      userId: b.userId ?? DEMO_USER,
      machineId: b.machineId,
      name: b.name ?? null,
      cron: b.cron,
      task: b.task ?? null,
      workdir: b.workdir ?? null,
      taskFile: b.taskFile ?? null,
      workflow: b.workflow ?? null,
      stateSchema: store.coerceStateSchema(b.stateSchema) ?? null,
      ui: store.coerceUi(b.ui) ?? null,
      notify: b.notify ?? "auto",
      allowControl: !!b.allowControl,
      model: b.model ?? null,
      enabled: b.enabled ?? true,
      nextRunAt: b.nextRunAt ?? null,
    });
    scheduler.addLoop(loop);
    return send(res, 200, { loop });
  }
  if (m === "GET" && p === "/api/loops") {
    return send(res, 200, store.listLoops().map((l) => ({ ...l, lastRun: store.lastRun(l.id) ?? null })));
  }
  const runMatch = p.match(/^\/api\/loops\/([^/]+)\/run$/);
  if (m === "POST" && runMatch) {
    const id = decodeURIComponent(runMatch[1]!);
    if (!store.getLoop(id)) return send(res, 404, { error: "not found" });
    scheduler.runNow(id);
    return send(res, 200, { ok: true });
  }
  const runsMatch = p.match(/^\/api\/loops\/([^/]+)\/runs$/);
  if (m === "GET" && runsMatch) {
    const id = decodeURIComponent(runsMatch[1]!);
    return send(res, 200, store.listRuns(id, 50));
  }

  send(res, 404, { error: "not found" });
}

const port = Number(process.env.LOOPANY_PORT || 8787);
server.listen(port, "127.0.0.1", () => log.info({ url: `http://127.0.0.1:${port}` }, "machine server listening"));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    abort.abort();
    server.close(() => process.exit(0));
  });
}
