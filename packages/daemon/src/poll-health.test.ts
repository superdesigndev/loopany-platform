import http from "node:http";
import { afterEach, expect, test } from "vitest";

import { boundedFetch } from "./http.js";
import { classifyPollFailure, PollHealth } from "./poll-health.js";

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

test("real HTTP timeout degrades once, rapidly re-polls, and recovers once", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    const request = requests;
    if (request <= 2) {
      setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ deliveries: [] })); }, 90);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ deliveries: [{ runId: "r1" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const url = `http://127.0.0.1:${address.port}`;

  const warnings: Array<Record<string, unknown>> = [];
  const infos: Array<Record<string, unknown>> = [];
  let now = 1_000;
  const health = new PollHealth({
    warn: (fields) => warnings.push(fields),
    info: (fields) => infos.push(fields),
  }, () => now);

  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let error: unknown;
    try {
      await boundedFetch(url, { method: "POST" }, 35);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    health.failure(classifyPollFailure(error), Date.now() - started);
    now += 40;
  }
  // A timeout consumed the poll budget, so production's elapsed cadence floors
  // at its short breather instead of sleeping a full poll interval.
  const { nextPollDelayMs } = await import("./daemon.js");
  expect(nextPollDelayMs(35, 20)).toBe(250);

  const started = Date.now();
  const recovered = await boundedFetch(url, { method: "POST" }, 35);
  expect((await recovered.json() as { deliveries: unknown[] }).deliveries).toHaveLength(1);
  health.success(Date.now() - started);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(warnings).toMatchObject([{ kind: "timeout" }]);
  expect(infos).toHaveLength(1);
  expect(infos[0]).toMatchObject({ failures: 2 });
  expect(infos[0]!.outageMs).toBeGreaterThanOrEqual(80);
  expect(requests).toBe(3);
});

test("a changed failure is reported while identical failures stay quiet", () => {
  const warnings: Array<Record<string, unknown>> = [];
  const infos: Array<Record<string, unknown>> = [];
  let now = 1_000;
  const health = new PollHealth({
    warn: (fields) => warnings.push(fields),
    info: (fields) => infos.push(fields),
  }, () => now);

  health.failure({ kind: "timeout", detail: "TimeoutError" }, 35);
  health.failure({ kind: "timeout", detail: "TimeoutError" }, 35);
  health.failure({ kind: "http", detail: "Service Unavailable", status: 503 }, 4);
  now = 1_100;
  health.success(3);

  expect(warnings).toHaveLength(2);
  expect(warnings[1]).toMatchObject({ kind: "http", status: 503, previousKind: "timeout" });
  expect(infos).toMatchObject([{ failures: 3, outageMs: 135 }]);
});

test("classifies nested undici timeout codes and malformed JSON", () => {
  expect(classifyPollFailure(Object.assign(new TypeError("fetch failed"), {
    cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
  }))).toMatchObject({ kind: "timeout", detail: "UND_ERR_CONNECT_TIMEOUT" });
  expect(classifyPollFailure(new SyntaxError("Unexpected token"))).toMatchObject({ kind: "protocol" });
});

test("healthy empty long-poll completes inside the client budget", async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end('{"deliveries":[]}'), 20));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const response = await boundedFetch(`http://127.0.0.1:${address.port}`, { method: "POST" }, 60);
  expect(response.ok).toBe(true);
});
