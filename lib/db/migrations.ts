/** Idempotent; safe to run on every deploy. Keep in sync with lib/db/schema.ts. */
export const MIGRATION_0001 = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  scope text NOT NULL,
  calendar_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_credentials_user_provider ON oauth_credentials(user_id, provider);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date text NOT NULL,
  trigger text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  error_code text,
  briefing_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_user_date ON runs(user_id, local_date, started_at DESC);

CREATE TABLE IF NOT EXISTS briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  snapshot jsonb NOT NULL,
  run_id uuid,
  generated_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS briefings_user_date_version ON briefings(user_id, local_date, version);

CREATE TABLE IF NOT EXISTS locks (
  key text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  result text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_created ON audit_events(user_id, created_at DESC);
`;

export const MIGRATION_0002 = `
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  client_key text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_user_client_key ON messages(user_id, client_key);
CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS intake_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  op_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  status text NOT NULL,
  page_id text,
  page_url text,
  title text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  before jsonb,
  after_edited_at text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_ops_message ON intake_ops(message_id);

CREATE TABLE IF NOT EXISTS permissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS blueprint_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS blueprint_versions_user_version ON blueprint_versions(user_id, version);

CREATE TABLE IF NOT EXISTS blueprint_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  kind text NOT NULL,
  minutes integer,
  energy text,
  context text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_feedback_user_created ON action_feedback(user_id, created_at DESC);
`;

export const MIGRATION_0003 = `
CREATE TABLE IF NOT EXISTS blueprint_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  content_sha256 text NOT NULL,
  preview_sha256 text NOT NULL,
  preview jsonb NOT NULL,
  status text NOT NULL DEFAULT 'preview',
  apply_report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS blueprint_imports_user_content ON blueprint_imports(user_id, content_sha256);
CREATE INDEX IF NOT EXISTS blueprint_imports_user_created ON blueprint_imports(user_id, created_at DESC);
`;

export const MIGRATION_0004 = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS blueprint_notion_page_id text;
`;

export const MIGRATION_0005 = `
CREATE TABLE IF NOT EXISTS email_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permalink text NOT NULL,
  kind text NOT NULL,
  title text,
  page_id text,
  page_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_items_user_permalink ON email_items(user_id, permalink);
CREATE INDEX IF NOT EXISTS email_items_user_updated ON email_items(user_id, updated_at DESC);
`;

export const MIGRATION_0006 = `
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  quiet_start text NOT NULL DEFAULT '22:30',
  quiet_end text NOT NULL DEFAULT '07:00',
  pause_all boolean NOT NULL DEFAULT false,
  maintenance_mode boolean NOT NULL DEFAULT false,
  life_area_visibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_budgets jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS life_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  visibility text NOT NULL DEFAULT 'private',
  sort_order integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS life_areas_user_slug ON life_areas(user_id, slug);

CREATE TABLE IF NOT EXISTS sync_cursors (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector text NOT NULL,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector)
);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id text PRIMARY KEY,
  title text NOT NULL,
  mission text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  memory_partition text NOT NULL DEFAULT 'work',
  output_contract text NOT NULL,
  daily_token_budget integer NOT NULL DEFAULT 8000,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  goal text,
  parent_run_id uuid,
  trigger text NOT NULL,
  scheduled_for timestamptz,
  status text NOT NULL,
  checkpoint jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  cost_tokens integer NOT NULL DEFAULT 0,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  verifier_result jsonb,
  error text,
  idempotency_key text NOT NULL UNIQUE,
  legacy_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_user_status ON agent_runs(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool text NOT NULL,
  scope text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL,
  output_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  action text NOT NULL,
  risk text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  evidence text,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  execution_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_user_status ON approval_requests(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partition text NOT NULL,
  body text NOT NULL,
  provenance text NOT NULL,
  confidence text NOT NULL DEFAULT 'stated',
  consent text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS memory_records_user_partition ON memory_records(user_id, partition, created_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  to_agent_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  start timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'deevaa',
  status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);
`;

export const MIGRATIONS = [MIGRATION_0001, MIGRATION_0002, MIGRATION_0003, MIGRATION_0004, MIGRATION_0005, MIGRATION_0006];
