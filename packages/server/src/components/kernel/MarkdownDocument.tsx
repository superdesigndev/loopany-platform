import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../../lib/markdown";
import { cx, PRE_BODY } from "./styles";

/** Sanitized Markdown with a small source escape hatch for exact inspection. */
export function MarkdownDocument({ body }: { body: string }) {
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  const rendered = useMemo(() => renderMarkdown(body), [body]);
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview.current) return;
    for (const link of preview.current.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }, [rendered, mode]);

  return <div className="mt-4 border-y border-[#ccc]">
    <div className="flex justify-end gap-1 border-b border-[#ddd] py-1.5">
      {(["rendered", "raw"] as const).map((value) => <button
        key={value}
        type="button"
        className={cx("cursor-pointer border-0 px-2 py-1 text-[10px] uppercase", mode === value ? "bg-[#171717] text-white" : "bg-transparent text-[#666]")}
        onClick={() => setMode(value)}
      >{value}</button>)}
    </div>
    {mode === "rendered"
      ? <div ref={preview} className="taskmd px-1 py-4" dangerouslySetInnerHTML={{ __html: rendered }} />
      : <pre className={cx(PRE_BODY, "border-0")}>{body}</pre>}
  </div>;
}
