import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { TasksView } from "../components/kernel/TasksView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/tasks")({ component: TasksRoute });

function TasksRoute() {
  const { selection, select } = useKernel();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return <TasksView
    data={useKernelData()}
    selection={selection}
    select={select}
    search={search}
    setSearch={(next) => void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, ...next }),
      replace: true,
    })}
  />;
}
