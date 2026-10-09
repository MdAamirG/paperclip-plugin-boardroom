-- Boardroom plugin tables (ticket 02).
--
-- Every object is fully qualified with the host-derived namespace `plugin_boardroom_79f8e138fc`
-- (derived from the manifest id `mdaamirg.boardroom`; never change the id). Every table carries
-- `company_id`, and every runtime query must filter on it: plugin SQL is not company-filtered.
--
-- Plugin-table foreign keys use (company_id, id) pairs, so a child row can never point at a row of
-- another company. There are deliberately no foreign keys to public.agents or public.issues: a
-- deleted agent or issue must never remove Room history.
--
-- Same-Room links: a Message and a Round point at each other through (company_id, room_id, id)
-- keys, so the pair always sits in one company and one Room. A Turn has no room column; the route
-- layer checks that a Turn belongs to the Room of the Round it is linked to.
--
-- The host records a checksum per applied migration. Before 0.1.0 ships this file may be edited;
-- after that, every schema change is a new numbered file.
--
-- WARNING for every comment in this file: the host scans comment text as well as code. It matches
-- the words from, join, references, into and update when a dotted name follows them, and it reads
-- an apostrophe as the start of a string. So never put those words before a dotted name in a
-- comment, and never use an apostrophe in a comment. A violation fails the whole migration at
-- install. The test in tests/db/tables.spec.ts scans this file for both.

CREATE TABLE plugin_boardroom_79f8e138fc.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title text NOT NULL,
  topic text NOT NULL DEFAULT '',
  project_id uuid,
  owner_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  max_total_turns integer NOT NULL DEFAULT 40,
  decision_md text,
  decision_by_user_id text,
  decision_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT rooms_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT rooms_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT rooms_max_total_turns_check CHECK (max_total_turns BETWEEN 1 AND 200),
  CONSTRAINT rooms_closed_at_check CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX rooms_company_updated_idx
  ON plugin_boardroom_79f8e138fc.rooms (company_id, updated_at DESC);

CREATE TABLE plugin_boardroom_79f8e138fc.room_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  added_by_user_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT room_participants_room_fk FOREIGN KEY (company_id, room_id)
    REFERENCES plugin_boardroom_79f8e138fc.rooms (company_id, id) ON DELETE CASCADE
);

-- One active row per room and agent. Removal is soft (removed_at), so a re-added agent gets a new row.
CREATE UNIQUE INDEX room_participants_one_active_uq
  ON plugin_boardroom_79f8e138fc.room_participants (room_id, agent_id)
  WHERE removed_at IS NULL;

CREATE INDEX room_participants_company_room_idx
  ON plugin_boardroom_79f8e138fc.room_participants (company_id, room_id, added_at);

CREATE TABLE plugin_boardroom_79f8e138fc.room_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  author_kind text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  round_id uuid,
  turn_id uuid,
  run_id uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_messages_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT room_messages_company_room_id_uq UNIQUE (company_id, room_id, id),
  CONSTRAINT room_messages_room_idempotency_uq UNIQUE (room_id, idempotency_key),
  CONSTRAINT room_messages_room_fk FOREIGN KEY (company_id, room_id)
    REFERENCES plugin_boardroom_79f8e138fc.rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT room_messages_author_kind_check CHECK (author_kind IN ('user', 'agent')),
  -- Agent Messages carry their Round and Turn (and the run id when known); user Messages carry none.
  CONSTRAINT room_messages_agent_refs_check CHECK (
    (author_kind = 'agent' AND round_id IS NOT NULL AND turn_id IS NOT NULL)
    OR (author_kind = 'user' AND round_id IS NULL AND turn_id IS NULL AND run_id IS NULL)
  )
);

CREATE INDEX room_messages_company_room_created_idx
  ON plugin_boardroom_79f8e138fc.room_messages (company_id, room_id, created_at, id);

CREATE TABLE plugin_boardroom_79f8e138fc.rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  seq integer NOT NULL,
  started_by_user_id text NOT NULL,
  trigger_message_id uuid NOT NULL,
  ask_all boolean NOT NULL DEFAULT false,
  addressed_agent_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT rounds_company_id_uq UNIQUE (company_id, id),
  CONSTRAINT rounds_company_room_id_uq UNIQUE (company_id, room_id, id),
  CONSTRAINT rounds_room_seq_uq UNIQUE (room_id, seq),
  CONSTRAINT rounds_room_fk FOREIGN KEY (company_id, room_id)
    REFERENCES plugin_boardroom_79f8e138fc.rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT rounds_trigger_message_fk FOREIGN KEY (company_id, room_id, trigger_message_id)
    REFERENCES plugin_boardroom_79f8e138fc.room_messages (company_id, room_id, id),
  CONSTRAINT rounds_seq_check CHECK (seq >= 1),
  CONSTRAINT rounds_status_check CHECK (status IN ('running', 'paused', 'stopped', 'completed')),
  CONSTRAINT rounds_ended_at_check CHECK ((status IN ('stopped', 'completed')) = (ended_at IS NOT NULL))
);

-- At most one active (running or paused) Round per Room.
CREATE UNIQUE INDEX rounds_one_active_per_room_uq
  ON plugin_boardroom_79f8e138fc.rounds (room_id)
  WHERE status IN ('running', 'paused');

CREATE INDEX rounds_company_status_idx
  ON plugin_boardroom_79f8e138fc.rounds (company_id, status);

CREATE TABLE plugin_boardroom_79f8e138fc.turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  round_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  ord integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  outcome text,
  skip_reason text,
  host_message text,
  session_id text,
  run_id uuid,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT turns_company_id_uq UNIQUE (company_id, id),
  -- The guard that each agent gets at most one Turn per Round.
  CONSTRAINT turns_round_agent_uq UNIQUE (round_id, agent_id),
  CONSTRAINT turns_round_ord_uq UNIQUE (round_id, ord),
  CONSTRAINT turns_round_fk FOREIGN KEY (company_id, round_id)
    REFERENCES plugin_boardroom_79f8e138fc.rounds (company_id, id) ON DELETE CASCADE,
  CONSTRAINT turns_message_fk FOREIGN KEY (company_id, message_id)
    REFERENCES plugin_boardroom_79f8e138fc.room_messages (company_id, id),
  CONSTRAINT turns_ord_check CHECK (ord >= 1),
  CONSTRAINT turns_status_check CHECK (status IN ('queued', 'running', 'finished')),
  CONSTRAINT turns_outcome_check CHECK (outcome IS NULL OR outcome IN ('posted', 'silent', 'failed', 'skipped')),
  -- An outcome is set exactly when the Turn has finished.
  CONSTRAINT turns_outcome_when_finished_check CHECK ((status = 'finished') = (outcome IS NOT NULL)),
  -- A skip reason is set exactly when the outcome is `skipped`.
  CONSTRAINT turns_skip_reason_check CHECK (
    (outcome IS NOT DISTINCT FROM 'skipped') = (skip_reason IS NOT NULL)
    AND (skip_reason IS NULL OR skip_reason IN ('not_invokable', 'stopped'))
  )
);

-- A run belongs to at most one Turn. Turns that have not started have no run id yet.
CREATE UNIQUE INDEX turns_run_id_uq
  ON plugin_boardroom_79f8e138fc.turns (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX turns_company_status_idx
  ON plugin_boardroom_79f8e138fc.turns (company_id, status);

-- Agent Messages point back at their Round and Turn. Added here because rounds and turns are
-- created after room_messages.
ALTER TABLE plugin_boardroom_79f8e138fc.room_messages
  ADD CONSTRAINT room_messages_round_fk FOREIGN KEY (company_id, room_id, round_id)
    REFERENCES plugin_boardroom_79f8e138fc.rounds (company_id, room_id, id);

ALTER TABLE plugin_boardroom_79f8e138fc.room_messages
  ADD CONSTRAINT room_messages_turn_fk FOREIGN KEY (company_id, turn_id)
    REFERENCES plugin_boardroom_79f8e138fc.turns (company_id, id);

CREATE TABLE plugin_boardroom_79f8e138fc.work_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  relation text NOT NULL,
  by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_links_room_issue_uq UNIQUE (room_id, issue_id),
  CONSTRAINT work_links_room_fk FOREIGN KEY (company_id, room_id)
    REFERENCES plugin_boardroom_79f8e138fc.rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT work_links_relation_check CHECK (relation IN ('created', 'linked'))
);

-- The issue-to-Room lookup (the "From Room" chip).
CREATE INDEX work_links_company_issue_idx
  ON plugin_boardroom_79f8e138fc.work_links (company_id, issue_id);
