import { useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { BOARDROOM_ROUTE_PATH } from "../constants.js";

/**
 * Boardroom page at `/:companyPrefix/boardroom`. Placeholder until ticket 04 adds the Room list,
 * the creation flow and the Room detail.
 */
export function BoardroomPage({ context }: PluginPageProps) {
  return (
    <section aria-labelledby="boardroom-title">
      <h1 id="boardroom-title">Boardroom</h1>
      {context.companyId ? (
        <p>Rooms for human-led discussions with your agents will appear here.</p>
      ) : (
        <p>Select a company to open its Boardroom.</p>
      )}
    </section>
  );
}

/** Sidebar entry that opens the Boardroom page through the host router. */
export function BoardroomSidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return <a {...navigation.linkProps(`/${BOARDROOM_ROUTE_PATH}`)}>Boardroom</a>;
}
