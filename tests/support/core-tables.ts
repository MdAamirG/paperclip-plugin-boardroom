/**
 * Stub `public` core tables for the PGlite test database.
 *
 * Only the columns the plugin reads (or a migration may reference) are present. Names and types
 * follow the host schema in `packages/db/src/schema/*.ts` of paperclipai/paperclip. Add a column
 * here when a ticket starts reading it, and keep it identical to the host's name and type.
 */
export const CORE_TABLES_SQL = `
CREATE TABLE public.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  issue_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.agents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  name text NOT NULL,
  role text NOT NULL DEFAULT 'general',
  title text,
  status text NOT NULL DEFAULT 'idle',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_company_id_uq UNIQUE (company_id, id)
);

CREATE TABLE public.projects (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'backlog',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.issues (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  project_id uuid REFERENCES public.projects(id),
  identifier text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'backlog',
  origin_kind text NOT NULL DEFAULT 'manual',
  origin_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.heartbeat_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  invocation_source text NOT NULL DEFAULT 'on_demand',
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id),
  heartbeat_run_id uuid REFERENCES public.heartbeat_runs(id),
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
