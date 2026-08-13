import { createFileRoute } from "@tanstack/react-router";
import { KernelWebApp } from "../components/kernel/KernelWebApp";

export const Route = createFileRoute("/t/$teamSlug_/kernel")({
  component: KernelRoute,
});

function KernelRoute() {
  const { teamSlug } = Route.useParams();
  return <KernelWebApp teamSlug={teamSlug} />;
}
