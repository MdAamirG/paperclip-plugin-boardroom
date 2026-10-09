import { Placeholder, RegionFrame, type RegionProps } from "./frame.js";

/**
 * Filled by the notes and transcript ticket. The shell already decides who may post: a viewer, or
 * anyone in a closed Room, gets a read-only notice and no composer.
 */
export function ComposerRegion({ detail }: RegionProps) {
  const { canPost, role } = detail.permissions;
  return (
    <RegionFrame region="composer" title="Composer">
      {canPost ? (
        <Placeholder>The composer will appear here.</Placeholder>
      ) : (
        <p className="br-notice br-notice-warn" role="status">
          {detail.room.status === "closed"
            ? "This Room is closed, so it is read-only."
            : role === "viewer"
              ? "Your role can read this Room but not post in it."
              : "You cannot post in this Room."}
        </p>
      )}
    </RegionFrame>
  );
}
