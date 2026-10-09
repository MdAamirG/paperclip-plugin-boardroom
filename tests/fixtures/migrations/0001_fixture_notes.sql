-- Fixture for the harness self-test. Uses the host-derived namespace name, as real migrations must.
CREATE TABLE plugin_boardroom_79f8e138fc.fixture_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fixture_notes_company_idx ON plugin_boardroom_79f8e138fc.fixture_notes (company_id);
