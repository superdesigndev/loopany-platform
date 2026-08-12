import { createFileRoute } from "@tanstack/react-router";
import { KernelWebApp } from "../components/kernel/KernelWebApp";

export const Route = createFileRoute("/t/$teamId_/kernel")({
  component: KernelRoute,
});

function KernelRoute() {
  const { teamId } = Route.useParams();
  return <KernelWebApp teamId={teamId} />;
}
