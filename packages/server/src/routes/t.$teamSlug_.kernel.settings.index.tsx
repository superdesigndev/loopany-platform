import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_SETTINGS_SECTION } from "../components/kernel/routing";

/** Bare `/kernel/settings` lands on the first section. */
export const Route = createFileRoute("/t/$teamSlug_/kernel/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/t/$teamSlug/kernel/settings/$section", params: { ...params, section: DEFAULT_SETTINGS_SECTION }, replace: true });
  },
});
