import { useId, type ReactNode } from "react";
import type { RoomDetail } from "../../api/types.js";

/** What every Room detail region receives. A later ticket edits only its own region file. */
export interface RegionProps {
  companyId: string;
  detail: RoomDetail;
  /** Goes up by one on every `room.changed` for this Room. A region that fetches its own data refetches when it changes. */
  refreshKey: number;
  /** Fetch the Room detail again now, for example after a mutation. */
  reloadRoom: () => void;
}

/** The labelled box around one region. `data-region` is the stable hook for tests and later tickets. */
export function RegionFrame({ region, title, children }: { region: string; title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="br-region" aria-labelledby={headingId} data-region={region}>
      <h2 id={headingId} className="br-h2">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Placeholder({ children }: { children: ReactNode }) {
  return <p className="br-region-placeholder">{children}</p>;
}
