import { createFileRoute } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { DocumentsView } from "../components/kernel/DocumentsView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/documents")({ component: DocumentsRoute });

function DocumentsRoute() {
  const { selection, select } = useKernel();
  return <DocumentsView data={useKernelData()} selection={selection} select={select} />;
}
