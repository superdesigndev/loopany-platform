import { createContext, useContext } from "react";
import type { AssigneeOption } from "./AssigneePicker";
import type { Obj, Select, Selection } from "./model";

/**
 * What the shell owns and every view route reads: the polled workspace payload,
 * the current selection (derived from the URL) and the navigation callbacks.
 *
 * The poll lives in the layout, so switching views never refetches - and the
 * view routes stay four-line components with no data plumbing of their own.
 */
export type KernelContextValue = {
  teamSlug: string;
  data: Obj | null;
  error: string;
  reload: () => Promise<void>;
  selection: Selection | null;
  select: Select;
  agents: string[];
  assignees: AssigneeOption[];
};

const KernelContext = createContext<KernelContextValue | null>(null);

export const KernelProvider = KernelContext.Provider;

export function useKernel(): KernelContextValue {
  const value = useContext(KernelContext);
  if (!value) throw new Error("useKernel must be used inside the Kernel shell");
  return value;
}

/** Views render only inside the shell's data gate, so the payload is present. */
export function useKernelData(): Obj {
  return useKernel().data!;
}
