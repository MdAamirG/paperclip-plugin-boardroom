import { useHostLocation, useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { BOARDROOM_ROUTE_PATH } from "../constants.js";
import { CreateRoomPage } from "./components/CreateRoom.js";
import { RoomDetailPage } from "./components/RoomDetail.js";
import { RoomListPage } from "./components/RoomList.js";
import { boardroomPaths, parseBoardroomRoute } from "./route.js";
import { BoardroomStyles } from "./styles.js";

/**
 * Boardroom page at `/:companyPrefix/boardroom`, with sub-routes `/new` (creation) and `/:roomId`
 * (detail) read from the host location.
 */
export function BoardroomPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const companyId = context.companyId;

  return (
    <section className="br-root" aria-label="Boardroom">
      <BoardroomStyles />
      {companyId ? (
        <Routes companyId={companyId} pathname={location.pathname} companyPrefix={context.companyPrefix} />
      ) : (
        <p>Select a company to open its Boardroom.</p>
      )}
    </section>
  );
}

function Routes({ companyId, pathname, companyPrefix }: { companyId: string; pathname: string; companyPrefix: string | null }) {
  const route = parseBoardroomRoute(pathname, companyPrefix);
  const navigation = useHostNavigation();
  switch (route.name) {
    case "list":
      return <RoomListPage companyId={companyId} />;
    case "new":
      return <CreateRoomPage companyId={companyId} />;
    case "room":
      // `key` resets the page state when the user moves from one Room to another.
      return <RoomDetailPage key={route.roomId} companyId={companyId} roomId={route.roomId} />;
    default:
      return (
        <div className="br-stack">
          <p role="alert">This Boardroom address does not exist.</p>
          <a {...navigation.linkProps(boardroomPaths.list())} className="br-link">
            ← All Rooms
          </a>
        </div>
      );
  }
}

/** Sidebar entry that opens the Boardroom page through the host router. */
export function BoardroomSidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const href = navigation.resolveHref(boardroomPaths.list());
  const active = location.pathname === href || location.pathname.startsWith(`${href}/`);
  return (
    <>
      <BoardroomStyles />
      <a {...navigation.linkProps(`/${BOARDROOM_ROUTE_PATH}`)} className="br-nav" aria-current={active ? "page" : undefined}>
        <svg className="br-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>Boardroom</span>
      </a>
    </>
  );
}
