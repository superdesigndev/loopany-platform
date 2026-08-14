/** Normalized, bounded transcript capture for Kernel Claude Runs.
 * Provider-native JSON never leaves the machine: this parser emits only the
 * small team-shareable vocabulary accepted by the server. */

export type TranscriptDraft =
  | { kind: "phase"; phase: "workflow" | "agent" | "finishing"; text: string }
  | { kind: "agent-message"; text: string }
  | { kind: "tool"; toolCallId: string; title: string; status: "started" | "done" | "failed"; path?: string; text?: string }
  | { kind: "error"; text: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number };

export type TranscriptEntry = TranscriptDraft & { seq: number; at: string };

const TEXT_CAP = 8 * 1024;
const LOCAL_RUN_CAP = 2 * 1024 * 1024;
const LOCAL_ENTRY_CAP = 2_000;
const BATCH_BYTES = 32 * 1024;
const BATCH_MS = 1_000;

const clip = (value: unknown, cap = TEXT_CAP): string => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, cap) : "";
const resultText = (value: unknown): string => {
  if (typeof value === "string") return clip(value, 2_000);
  if (!Array.isArray(value)) return "";
  return clip(value.map((part) => typeof part?.text === "string" ? part.text : "").join("\n"), 2_000);
};

/** Incremental Claude stream-json parser. A final unterminated JSON line is
 * flushed by `finish`, matching Claude's real terminal event behavior. */
export function createClaudeTranscriptParser(emit: (entry: TranscriptDraft) => void): { feed(chunk: string): void; finish(): string | null } {
  let buffer = "";
  let sessionId: string | null = null;
  const tools = new Map<string, { title: string; path?: string }>();
  const handle = (line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (!sessionId && typeof event.session_id === "string" && event.session_id) sessionId = event.session_id.slice(0, 200);
    const content = event?.message?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") {
          const value = clip(block.text);
          if (value) emit({ kind: "agent-message", text: value });
          continue;
        }
        if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        const input = block.input ?? {};
        const path = clip(input.file_path ?? input.path, 1_000) || undefined;
        const target = path ?? clip(input.command ?? input.pattern ?? input.url ?? input.description, 1_000);
        const title = clip(`${block.name}${target ? `: ${target}` : ""}`, 1_200);
        tools.set(block.id, { title, ...(path ? { path } : {}) });
        emit({ kind: "tool", toolCallId: clip(block.id, 200), title, status: "started", ...(path ? { path } : {}) });
      }
      return;
    }
    if (event.type === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const known = tools.get(block.tool_use_id);
        const value = resultText(block.content);
        emit({
          kind: "tool", toolCallId: clip(block.tool_use_id, 200), title: known?.title ?? "Tool result",
          status: block.is_error === true ? "failed" : "done", ...(known?.path ? { path: known.path } : {}), ...(value ? { text: value } : {}),
        });
      }
      return;
    }
    if (event.type === "result") {
      const usage = event.usage ?? {};
      const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : undefined;
      const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : undefined;
      const costUsd = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : undefined;
      if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) emit({ kind: "usage", ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) });
      if (event.is_error === true && typeof event.result === "string") emit({ kind: "error", text: clip(event.result) });
    }
  };
  return {
    feed(chunk) { buffer += chunk; let newline: number; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) handle(line); } },
    finish() { const rest = buffer.trim(); buffer = ""; if (rest) handle(rest); return sessionId; },
  };
}

export interface TranscriptUploadBody { entries: TranscriptEntry[]; endSeq: number; final?: boolean; partial?: boolean; truncated?: boolean }

/** Buffered uploader. Upload errors are remembered as `partial`, never thrown
 * into Run execution. A final marker still lands when possible so the Web UI
 * can distinguish a complete capture from a gap. */
export class KernelTranscriptCapture {
  private pending: TranscriptEntry[] = [];
  private nextSeq = 0;
  private bytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();
  private partial = false;
  private truncated = false;

  constructor(
    private readonly upload: (body: TranscriptUploadBody) => Promise<void>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  append(draft: TranscriptDraft): void {
    if (this.nextSeq >= LOCAL_ENTRY_CAP || this.bytes >= LOCAL_RUN_CAP) { this.truncated = true; return; }
    const entry = { ...draft, seq: this.nextSeq++, at: this.now() } as TranscriptEntry;
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (this.bytes + size > LOCAL_RUN_CAP) { this.truncated = true; return; }
    this.bytes += size;
    this.pending.push(entry);
    if (Buffer.byteLength(JSON.stringify(this.pending)) >= BATCH_BYTES) this.queueFlush();
    else this.timer ??= setTimeout(() => { this.timer = undefined; this.queueFlush(); }, BATCH_MS);
  }

  private queueFlush(final = false): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const entries = this.pending.splice(0);
    if (!entries.length && !final) return;
    const endSeq = entries.at(-1)?.seq ?? this.nextSeq;
    this.chain = this.chain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.upload({ entries, endSeq, ...(final ? { final: true, partial: this.partial, truncated: this.truncated } : {}) });
          return;
        } catch {
          if (attempt < 2) await this.sleep(attempt === 0 ? 250 : 1_000);
        }
      }
      this.partial = true;
    });
  }

  async finish(): Promise<{ partial: boolean; truncated: boolean }> {
    this.queueFlush(true);
    await this.chain;
    return { partial: this.partial, truncated: this.truncated };
  }
}
