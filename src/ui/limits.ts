/**
 * Limits the creation form shows. The server owns and enforces them (`src/db/participants.ts`,
 * `src/db/rooms.ts`, `src/api/rooms.ts`); `tests/ui/limits.spec.ts` pins these copies to the server
 * values, because the UI bundle must not import the database layer.
 */
export const MAX_PARTICIPANTS = 8;
export const DEFAULT_TURN_CAP = 40;
export const MIN_TURN_CAP = 1;
export const MAX_TURN_CAP = 200;
export const TITLE_MAX_LENGTH = 200;
export const TOPIC_MAX_LENGTH = 10000;
