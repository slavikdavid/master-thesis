-- =========================
-- users / auth
-- =========================
CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  name text,
  display_name text,
  is_email_verified boolean DEFAULT FALSE,
  is_active boolean NOT NULL DEFAULT TRUE,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

DO $$
BEGIN
  IF EXISTS(
    SELECT
    FROM
      information_schema.tables
    WHERE
      table_name = 'users') THEN
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
END IF;
END
$$;

CREATE TABLE IF NOT EXISTS roles(
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles(
  user_id uuid REFERENCES users(id),
  role_id integer REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- seed roles
INSERT INTO roles(name)
  VALUES ('admin'),
('member'),
('viewer')
ON CONFLICT (name)
  DO NOTHING;

-- =========================
-- teams & membership
-- =========================
CREATE TABLE IF NOT EXISTS teams(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

-- each user can own at most one team
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT
      1
    FROM
      pg_constraint
    WHERE
      conname = 'unique_owner_per_team') THEN
  ALTER TABLE teams
    ADD CONSTRAINT unique_owner_per_team UNIQUE(owner_user_id);
END IF;
END
$$;

CREATE TABLE IF NOT EXISTS team_members(
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role_id integer REFERENCES roles(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- one personal team per existing user
INSERT INTO teams(name, owner_user_id, created_at, updated_at)
SELECT
  concat('Personal: ', email) AS name,
  id AS owner_user_id,
  now(),
  now()
FROM
  users
ON CONFLICT
  DO NOTHING;

-- migrate user_roles into team_members (attach users to their personal team)
INSERT INTO team_members(team_id, user_id, role_id, joined_at)
SELECT
  t.id AS team_id,
  ur.user_id,
  ur.role_id,
  now()
FROM
  user_roles ur
  JOIN teams t ON t.owner_user_id = ur.user_id
ON CONFLICT (team_id,
  user_id)
  DO UPDATE SET
    role_id = EXCLUDED.role_id;

-- =========================
-- conversations & messages
-- =========================
CREATE TABLE IF NOT EXISTS conversations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ownership & sharing
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  -- link to repo/source this conversation is about
  repo_id text NOT NULL,
  -- basic info
  title text,
  type TEXT DEFAULT 'chat', -- e.g., 'chat', 'rag'
  source text, -- e.g., 'web', 'api', 'mobile'
  -- flags for UI/UX features
  is_shared boolean NOT NULL DEFAULT FALSE,
  is_archived boolean NOT NULL DEFAULT FALSE,
  is_favorite boolean NOT NULL DEFAULT FALSE,
  -- activity tracking
  last_interacted_at timestamptz DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0,
  -- flexible custom fields
  metadata jsonb NOT NULL DEFAULT '{}',
  -- system timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- if conversations already existed without repo_id, add & enforce:
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS repo_id text;

-- enforce NOT NULL (only safe after backfill):
ALTER TABLE conversations
  ALTER COLUMN repo_id SET NOT NULL;

-- helpful index for lookups by repo
CREATE INDEX IF NOT EXISTS idx_conversations_repo_id ON conversations(repo_id);

-- speeds up conversation lookups for rag turns
CREATE INDEX IF NOT EXISTS idx_rag_queries_conversation_created ON rag_queries(conversation_id, created_at);

-- speeds up join from retrieved_chunks
CREATE INDEX IF NOT EXISTS idx_retrieved_chunks_rag_query_id ON retrieved_chunks(rag_query_id);

-- if you frequently filter by used_in_prompt
CREATE INDEX IF NOT EXISTS idx_retrieved_chunks_used ON retrieved_chunks(rag_query_id, used_in_prompt);

-- for filename matches in highlights
-- (only if documents.title stores repo-relative paths)
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);

-- ensure team_id exists and is set
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE CASCADE;

-- put existing conversations into their owner's personal team
UPDATE
  conversations c
SET
  team_id = t.id
FROM
  teams t
WHERE
  c.user_id = t.owner_user_id
  AND c.team_id IS NULL;

-- create an "orphan" team for conversations with no user
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT
      1
    FROM
      teams
    WHERE
      name = 'Orphan') THEN
  INSERT INTO teams(name, owner_user_id, created_at, updated_at)
    VALUES('Orphan', NULL, now(), now());
END IF;
END
$$;

UPDATE
  conversations c
SET
  team_id = t.id
FROM
  teams t
WHERE
  t.name = 'Orphan'
  AND c.user_id IS NULL
  AND c.team_id IS NULL;

CREATE TABLE IF NOT EXISTS messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  content text NOT NULL,
  role TEXT CHECK (ROLE IN ('user', 'assistant', 'system')) NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

-- embedding metadata for messages (optional)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_created_at timestamptz;

-- =========================
-- RAG: documents & chunks
-- =========================
CREATE TABLE IF NOT EXISTS documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  title text,
  description text,
  source_type text, -- e.g., 'pdf', 'upload'
  source_uri text,
  version integer NOT NULL DEFAULT 1,
  checksum text,
  ingestion_status text NOT NULL DEFAULT 'pending',
  ingested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS document_chunks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  chunk_text text NOT NULL,
  chunk_hash text NOT NULL,
  chunk_index integer NOT NULL,
  start_offset integer,
  end_offset integer,
  embedding vector(1536),
  embedding_model text,
  embedding_created_at timestamptz,
  embedding_metadata jsonb NOT NULL DEFAULT '{}',
  token_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

-- optional full-text search vector and index
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_document_chunks_search_vector ON document_chunks USING GIN(search_vector);

-- example vector index
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON document_chunks USING ivfflat(embedding vector_l2_ops) WITH (lists = 100);

-- =========================
-- RAG: query tracking
-- =========================
CREATE TABLE IF NOT EXISTS rag_queries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  query_text text NOT NULL,
  response_text text,
  response_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieved_chunks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rag_query_id uuid REFERENCES rag_queries(id) ON DELETE CASCADE,
  document_chunk_id uuid REFERENCES document_chunks(id),
  score double precision,
  rank integer,
  used_in_prompt boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rag_query_id uuid REFERENCES rag_queries(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  rating integer CHECK (rating BETWEEN 1 AND 5),
  comment text,
  is_approved boolean DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================
-- audit & usage
-- =========================
CREATE TABLE IF NOT EXISTS audit_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text,
  resource_id uuid,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id);

-- backfill audit_logs.team_id from personal teams
UPDATE
  audit_logs al
SET
  team_id = t.id
FROM
  teams t
WHERE
  al.user_id = t.owner_user_id
  AND al.team_id IS NULL;

CREATE TABLE IF NOT EXISTS usage_metrics(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid REFERENCES teams(id),
  user_id uuid REFERENCES users(id),
  metric_name text NOT NULL,
  value double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_token text UNIQUE NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

