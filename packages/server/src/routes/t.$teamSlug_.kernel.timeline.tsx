import { createFileRoute } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { TimelineView } from "../components/kernel/TimelineView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/timeline")({ component: TimelineRoute });

function TimelineRoute() {
  const { selection, select } = useKernel();
  const data = useKernelData();
  return <TimelineView items={data.recentTimeline} data={data} selection={selection} select={select} />;
}
