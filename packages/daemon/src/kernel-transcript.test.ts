import { expect, test } from "vitest";
import { createClaudeTranscriptParser, KernelTranscriptCapture, type TranscriptDraft } from "./kernel-transcript.js";

test("Claude stream-json becomes a bounded provider-neutral transcript", () => {
  const entries: TranscriptDraft[] = [];
  const parser = createClaudeTranscriptParser((entry) => entries.push(entry));
  parser.feed('{"type":"assistant","session_id":"sess-team","message":{"content":[{"type":"text","text":"Checking the route"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"/work/src/route.ts"}}]}}\n');
  parser.feed('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"route contents"}]}}\n');
  parser.feed('{"type":"result","session_id":"sess-team","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":4}}');

  expect(parser.finish()).toBe("sess-team");
  expect(entries).toEqual([
    { kind: "agent-message", text: "Checking the route" },
    { kind: "tool", toolCallId: "tool-1", title: "Read: /work/src/route.ts", path: "/work/src/route.ts", status: "started" },
    { kind: "tool", toolCallId: "tool-1", title: "Read: /work/src/route.ts", path: "/work/src/route.ts", status: "done", text: "route contents" },
    { kind: "usage", inputTokens: 10, outputTokens: 4, costUsd: 0.02 },
  ]);
});

test("capture batches entries and closes with an honest final marker", async () => {
  const uploads: any[] = [];
  const capture = new KernelTranscriptCapture(async (body) => { uploads.push(body); }, () => "2026-08-14T00:00:00.000Z");
  capture.append({ kind: "phase", phase: "agent", text: "claude started" });
  capture.append({ kind: "agent-message", text: "Working" });
  await capture.finish();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({ endSeq: 1, final: true, partial: false, entries: [{ seq: 0 }, { seq: 1 }] });
});

test("a failed chunk makes the final marker partial without failing the Run", async () => {
  const uploads: any[] = [];
  const capture = new KernelTranscriptCapture(
    async (body) => { uploads.push(body); if (!body.final) throw new Error("offline"); },
    () => new Date().toISOString(),
    async () => {},
  );
  capture.append({ kind: "agent-message", text: "Captured before outage" });
  // Force a non-final upload by filling a batch, then let the final marker land.
  for (let i = 0; i < 20; i++) capture.append({ kind: "agent-message", text: "x".repeat(2_000) });
  await capture.finish();
  expect(uploads.at(-1)?.partial).toBe(true);
});
