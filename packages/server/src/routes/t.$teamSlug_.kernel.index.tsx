import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/t/<slug>/kernel` is the entry link everywhere (setup output, bookmarks), so
 *  it keeps working and lands on the default view. */
export const Route = createFileRoute("/t/$teamSlug_/kernel/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/t/$teamSlug/kernel/inbox", params, search, replace: true });
  },
});
