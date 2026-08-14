import type { Obj } from "./model";
import { Empty } from "./primitives";
import { LocalTime } from "./DisplayPrimitives";

const LABEL: Record<string, string> = { phase: "PHASE", "agent-message": "AGENT", tool: "TOOL", error: "ERROR", usage: "USAGE" };

function summary(entry: Obj): string {
  if (entry.kind === "tool") return `${entry.title}${entry.status ? ` · ${entry.status}` : ""}${entry.text ? `\n${entry.text}` : ""}`;
  if (entry.kind === "usage") return [entry.inputTokens != null && `${entry.inputTokens} input`, entry.outputTokens != null && `${entry.outputTokens} output`, entry.costUsd != null && `$${entry.costUsd}`].filter(Boolean).join(" · ") || "Usage recorded";
  return entry.text ?? "Recorded";
}

export function RunTranscript({ value }: { value: Obj }) {
  const entries = value.entries ?? [];
  const capture = value.capture ?? {};
  if (!entries.length) return <Empty text={capture.status === "partial" ? "Transcript capture is incomplete" : "No shared transcript recorded"} />;
  return <div>
    <div className="mb-2 text-[10px] text-[#777]">
      {capture.status === "complete" ? "Complete shared transcript" : "Partial shared transcript"}
      {capture.truncated ? " · truncated" : ""} · {capture.entries ?? entries.length} entries
    </div>
    <div className="relative">
      {entries.map((entry: Obj, index: number) => <div key={entry.seq} className="grid grid-cols-[76px_18px_minmax(0,1fr)] text-[11px] leading-[1.5]">
        <div className="py-2 pr-2 text-right text-[#777]"><LocalTime value={entry.at} variant="timeline" /></div>
        <span className="relative flex justify-center" aria-hidden="true">
          <span className={`absolute left-1/2 w-px -translate-x-1/2 bg-[#bbb] ${index === 0 ? "top-1/2" : "top-0"} ${index === entries.length - 1 ? "bottom-1/2" : "bottom-0"}`} />
          <span className={`relative mt-[14px] size-[7px] ${entry.kind === "error" ? "bg-[#9b2c2c]" : "bg-[#555]"}`} />
        </span>
        <div className="min-w-0 border-b border-[#ddd] py-2 pr-2 pl-3">
          <code className="mr-2 inline-block border border-[#aaa] px-1.5 py-0.5 text-[9px] text-[#666]">{LABEL[entry.kind] ?? entry.kind}</code>
          <span className="wrap-anywhere whitespace-pre-wrap">{summary(entry)}</span>
        </div>
      </div>)}
    </div>
  </div>;
}
