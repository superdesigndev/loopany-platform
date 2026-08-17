export const BOARD_STATUSES = ["todo", "in-progress", "follow-up", "done"] as const;
export const HIDDEN_STATUSES = ["idea", "done", "archived"] as const;
export const TASK_STATUSES = ["idea", "todo", "in-progress", "follow-up", "done", "archived"] as const;
export const DEFAULT_TASK_STATUSES = ["idea", "todo", "in-progress", "follow-up"] as const;

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

type FilterableTreeNode = {
  task: { id: string; title: string; status: string; owner?: string | null };
  children: FilterableTreeNode[];
  contextOnly?: boolean;
};

export function taskMatchesFilters(
  task: FilterableTreeNode["task"],
  filters: { query: string; owner: string | null; statuses: readonly string[] },
): boolean {
  const query = filters.query.trim().toLocaleLowerCase();
  return (!query || `${task.title} ${task.id}`.toLocaleLowerCase().includes(query))
    && (!filters.owner || (filters.owner === "unowned" ? !task.owner : task.owner === filters.owner))
    && filters.statuses.includes(task.status);
}

/** Keep matching Tasks plus the ancestor chain needed to understand their scope. */
export function filterTaskTree<T extends FilterableTreeNode>(
  nodes: T[],
  filters: { query: string; owner: string | null; statuses: readonly string[] },
): T[] {
  return nodes.flatMap((node) => {
    const children = filterTaskTree(node.children as T[], filters);
    const matches = taskMatchesFilters(node.task, filters);
    if (!matches && children.length === 0) return [];
    return [{ ...node, children, contextOnly: !matches } as T];
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resumeCommand(profile: string | null, sessionId: string, workdir?: string | null): string {
  const executable = profile === "codex" ? "codex resume" : "claude --resume";
  const resume = `${executable} ${shellQuote(sessionId)}`;
  return workdir ? `cd -- ${shellQuote(workdir)} && ${resume}` : resume;
}
