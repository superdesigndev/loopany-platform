import { createFileRoute } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { TasksView } from "../components/kernel/TasksView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/tasks")({ component: TasksRoute });

function TasksRoute() {
  const { selection, select } = useKernel();
  return <TasksView data={useKernelData()} selection={selection} select={select} />;
}
