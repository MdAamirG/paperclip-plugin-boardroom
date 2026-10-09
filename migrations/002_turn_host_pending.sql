-- A Turn settles in two steps: the database part (outcome, reply Message) can run anywhere; the host
-- part (activity entry, session close, live update, starting the next Turn) needs a host call that
-- the host only accepts inside an invocation (or for a company with a plugin configuration row).
-- `host_pending` is true from the first step until the second is done, so the host part runs once
-- and a settlement made outside an invocation is finished later by a run event, the sweep or an
-- API request. Existing rows are false: their host part was done (or lost) before this column.
ALTER TABLE plugin_boardroom_79f8e138fc.turns ADD COLUMN host_pending boolean NOT NULL DEFAULT false;
