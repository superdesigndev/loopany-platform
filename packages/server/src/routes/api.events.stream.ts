import { createFileRoute } from "@tanstack/react-router";
import { resolveApiContext } from "../kernel/apiAuth.js";
import { eventTail, eventsAfter } from "../kernel/objectApi.js";
import * as store from "../db/kernelStore.js";
import { authFailure, ensureBooted } from "../kernel/routeSupport.js";

const enc = new TextEncoder();
const liveSessions = new Map<string, () => void>();
export const Route = createFileRoute("/api/events/stream")({ server: { handlers: { GET: async ({ request }: { request: Request }) => {
  await ensureBooted(); const auth = await resolveApiContext(request, "owner"); if (!auth.ok) return authFailure(auth.error);
  const tail = await eventTail(auth.context.teamId); const header = request.headers.get("last-event-id"); const query = new URL(request.url).searchParams.get("since");
  let cursor = Number(header ?? query ?? tail); if (!Number.isFinite(cursor) || cursor < 0) cursor = tail;
  const reset = tail - cursor > 1000; if (reset) cursor = tail;
  let poll: ReturnType<typeof setInterval> | undefined; let heartbeat: ReturnType<typeof setInterval> | undefined; let busy = false;
  const sessionKey = `${auth.context.teamId}:${auth.context.actor.actorId}`;
  liveSessions.get(sessionKey)?.();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed by the client */ }
        if (liveSessions.get(sessionKey) === cleanup) liveSessions.delete(sessionKey);
      };
      liveSessions.set(sessionKey, cleanup);
      controller.enqueue(enc.encode(`retry: 3000\n\n${reset ? `event: reset\ndata: ${JSON.stringify({ seq: tail })}\n\n` : ""}`));
      const send = async () => { if (busy || closed) return; busy = true; try { for (const event of await eventsAfter(auth.context.teamId, cursor)) { cursor = event.seq; const object = event.objectId ? await store.getObject(undefined, event.objectId) : undefined; const objectKind = object?.kind ?? event.objectId?.split("-", 1)[0] ?? null; const loopId = objectKind === "loop" ? event.objectId : object?.watcher ?? object?.createdByLoop ?? null; controller.enqueue(enc.encode(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify({ seq: event.seq, id: event.id, kind: event.kind, objectId: event.objectId, objectKind, loopId, entrance: event.entrance, ts: event.ts })}\n\n`)); } } catch { cleanup(); } finally { busy = false; } };
      void send(); poll = setInterval(() => void send(), 1000); heartbeat = setInterval(() => { if (!closed) controller.enqueue(enc.encode(`: ping ${new Date().toISOString()}\n\n`)); }, 15_000);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
} } } });
