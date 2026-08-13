import { createFileRoute, redirect } from "@tanstack/react-router";
import { useKernel, useKernelData } from "../components/kernel/context";
import { DEFAULT_SETTINGS_SECTION, isSettingsSection } from "../components/kernel/routing";
import { SettingsView } from "../components/kernel/SettingsView";

export const Route = createFileRoute("/t/$teamSlug_/kernel/settings/$section")({
  // A hand-typed or renamed section is corrected, never a dead end.
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) {
      throw redirect({ to: "/t/$teamSlug/kernel/settings/$section", params: { ...params, section: DEFAULT_SETTINGS_SECTION }, replace: true });
    }
  },
  component: SettingsRoute,
});

function SettingsRoute() {
  const { section } = Route.useParams();
  const { teamSlug, agents, select } = useKernel();
  const data = useKernelData();
  if (!isSettingsSection(section)) return null;
  return <SettingsView data={data} teamId={data.team?.id} teamSlug={teamSlug} section={section} agents={agents} select={select} />;
}
