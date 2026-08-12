export const BOARD_STATUSES = ["todo", "in-progress", "follow-up", "done"] as const;
export const HIDDEN_STATUSES = ["idea", "archived"] as const;

type TreeNode = { task: { status: string }; children: TreeNode[] };

export function visibleTaskTree<T extends TreeNode>(nodes: T[], showHidden: boolean): T[] {
  if (showHidden) return nodes;
  return nodes.flatMap((node) => {
    const children = visibleTaskTree(node.children as T[], false);
    if (HIDDEN_STATUSES.includes(node.task.status as (typeof HIDDEN_STATUSES)[number])) return children;
    return [{ ...node, children } as T];
  });
}

export function hiddenTaskCount(tasks: Array<{ status: string }>): number {
  return tasks.filter((task) => HIDDEN_STATUSES.includes(task.status as (typeof HIDDEN_STATUSES)[number])).length;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resumeCommand(profile: string | null, sessionId: string, workdir?: string | null): string {
  const executable = profile === "codex" ? "codex resume" : "claude --resume";
  const resume = `${executable} ${shellQuote(sessionId)}`;
  return workdir ? `cd -- ${shellQuote(workdir)} && ${resume}` : resume;
}
