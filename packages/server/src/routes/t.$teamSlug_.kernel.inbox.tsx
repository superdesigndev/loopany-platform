import { createFileRoute } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { InboxView } from "../components/kernel/InboxView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/inbox")({ component: InboxRoute });

function InboxRoute() {
  const { selection, select } = useKernel();
  return <InboxView data={useKernelData()} selection={selection} select={select} />;
}
