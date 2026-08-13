import { useState } from "react";
import { cx, FOCUS_RING } from "./styles";

export function LocalTime({ value, variant = "inline" }: { value?: string | null; variant?: "inline" | "timeline" }) {
  if (!value) return <span>-</span>;
  const date = new Date(value);
  if (variant === "timeline") return <time dateTime={value} className="leading-[1.45]">
    <span className="block">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}</span>
    <span className="block">{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)}</span>
  </time>;
  return <time dateTime={value}>{new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date)}</time>;
}

export function CopyAction({ value, children = "Copy", variant = "link", ariaLabel }: { value: string; children?: React.ReactNode; variant?: "link" | "command"; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <button
    className={cx(FOCUS_RING, variant === "link"
      ? "cursor-pointer border-0 bg-transparent p-0 text-[#174f78] underline decoration-[#aaa] underline-offset-2"
      : "cursor-pointer border-0 border-l border-[#555] bg-[#292929] px-[14px] text-white hover:bg-[#3b3b3b] max-[600px]:w-full max-[600px]:border-t max-[600px]:border-l-0 max-[600px]:p-[9px]")}
    onClick={() => void copy()}
    aria-label={ariaLabel}
  >{copied ? "Copied" : children}</button>;
}
