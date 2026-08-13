/**
 * Shared Tailwind class recipes for the Kernel workspace.
 *
 * The Kernel Web app is deliberately its own visual world - a dense monospace,
 * grayscale "instrument" surface that does NOT inherit the product design
 * system's tokens (hence the literal hex values here instead of `--color-*`).
 * These constants hold only the recipes that repeat across panels - button,
 * rail item, pill, field - so the same control cannot drift between surfaces;
 * anything used once stays inline on its element.
 */

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/*
 * STATE IS A SKIN, NEVER A LAYER. Two utilities for the SAME property in one
 * class list (`bg-white` + `bg-[#171717]`) do NOT resolve by the order written
 * here - they resolve by stylesheet order, so the loser is unpredictable. Every
 * stateful recipe below is therefore a function returning ONE mutually
 * exclusive skin. Variant utilities (`hover:`/`disabled:`) are safe to layer:
 * Tailwind emits them after the plain ones.
 */

/** Root surface, shared by the workspace shell and the sign-in page. */
export const SURFACE = "min-h-screen bg-[#fafafa] font-mono text-[13px] text-[#171717]";
/** The bordered push button - header, detail pane and task actions. `primary`
 *  is the one committing action in a group; `active` is a pressed toggle. */
export const button = (variant: "default" | "primary" | "active" = "default") => cx(
  "cursor-pointer border px-2 py-[5px]",
  variant === "default" ? "border-[#aaa] bg-white" : variant === "primary" ? "border-[#171717] bg-[#171717] text-white" : "border-[#aaa] bg-[#171717] text-white",
);
export const BUTTON_DISABLED = "disabled:cursor-not-allowed disabled:border-[#ccc] disabled:bg-[#eee] disabled:text-[#999]";
/** Flush, full-width item in a vertical rail (main nav + settings sections). */
export const railButton = (active: boolean) => cx(
  "block w-full cursor-pointer border-0 p-[9px] text-left",
  active ? "bg-[#171717] text-white" : "bg-transparent",
);
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#166a9c]";

export const MUTED = "text-[#666]";
export const ERROR = "text-[#b42318]";
export const EYEBROW = "text-[9px] font-bold tracking-[0.12em] text-[#666]";
export const pill = (online = false) => cx(
  "whitespace-nowrap border px-[5px] py-[3px] text-[9px]",
  online ? "border-[#16734a] bg-[#edf8f2] text-[#11613e]" : "border-[#aaa] bg-[#fafafa]",
);
/** Text input / select / textarea. */
export const FIELD = "border border-[#aaa] bg-white p-1.5";
/** Verbatim agent prose - specs, notes, document bodies. */
export const PRE_BODY = "border-y border-[#ccc] py-3 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap wrap-anywhere";

/**
 * Selection in a list: a fill plus an inset left bar. Inset rather than a real
 * border because the Task tree's nesting lives in `padding-left` - a border
 * would shift every selected line by its own width.
 */
const SELECTED_FILL = "bg-[#e9e9e6] shadow-[inset_3px_0_0_#171717]";
export const selectableRow = (selected: boolean) => cx("hover:bg-[#eee]", selected ? SELECTED_FILL : "bg-transparent");
export const selectableCard = (selected: boolean) => cx("hover:bg-[#eee]", selected ? SELECTED_FILL : "bg-white");

/** Presence light. Colour never signals alone - a text label always sits beside it. */
export const statusDot = (online: boolean) => cx(
  "size-2.5 flex-none rounded-full",
  online ? "bg-[#168857] shadow-[0_0_0_4px_#dff4e8]" : "bg-[#aaa] shadow-[0_0_0_4px_#eee]",
);
