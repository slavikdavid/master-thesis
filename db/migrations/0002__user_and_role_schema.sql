-- =========================
-- users / auth
-- =========================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  display_name TEXT,
  is_email_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users') THEN
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID REFERENCES users(id),
  role_id INTEGER REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- seed roles
INSERT INTO roles (name)
  VALUES ('admin'), ('member'), ('viewer')
ON CONFLICT (name) DO NOTHING;

-- =========================
-- teams & membership
-- =========================
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- each user can own at most one team
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_owner_per_team'
  ) THEN
    ALTER TABLE teams
      ADD CONSTRAINT unique_owner_per_team UNIQUE (owner_user_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- one personal team per existing user
INSERT INTO teams (name, owner_user_id, created_at, updated_at)
SELECT
  concat('Personal: ', email) AS name,
  id AS owner_user_id,
  now(), now()
FROM users
ON CONFLICT DO NOTHING;

-- migrate user_roles into team_members (attach users to their personal team)
INSERT INTO team_members (team_id, user_id, role_id, joined_at)
SELECT
  t.id AS team_id,
  ur.user_id,
  ur.role_id,
  now()
FROM user_roles ur
JOIN teams t ON t.owner_user_id = ur.user_id
ON CONFLICT (team_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id;

-- =========================
-- conversations & messages
-- =========================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ownership & sharing
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,

  -- link to repo/source this conversation is about
  repo_id TEXT NOT NULL,

  -- basic info
  title TEXT,
  type TEXT DEFAULT 'chat',                        -- e.g., 'chat', 'rag'
  source TEXT,                                     -- e.g., 'web', 'api', 'mobile'

  -- flags for UI/UX features
  is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,

  -- activity tracking
  last_interacted_at TIMESTAMPTZ DEFAULT now(),
  message_count INTEGER NOT NULL DEFAULT 0,

  -- flexible custom fields
  metadata JSONB NOT NULL DEFAULT '{}',

  -- system timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- if conversations already existed without repo_id, add & enforce:
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS repo_id TEXT;
-- enforce NOT NULL (only safe after backfill):
ALTER TABLE conversations
  ALTER COLUMN repo_id SET NOT NULL;

-- helpful index for lookups by repo
CREATE INDEX IF NOT EXISTS idx_conversations_repo_id ON conversations (repo_id);

-- ensure team_id exists and is set
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE CASCADE;

-- put existing conversations into their owner's personal team
UPDATE conversations c
SET team_id = t.id
FROM teams t
WHERE c.user_id = t.owner_user_id
  AND c.team_id IS NULL;

-- create an "orphan" team for conversations with no user
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM teams WHERE name = 'Orphan') THEN
    INSERT INTO teams (name, owner_user_id, created_at, updated_at)
    VALUES ('Orphan', NULL, now(), now());
  END IF;
END$$;

UPDATE conversations c
SET team_id = t.id
FROM teams t
WHERE t.name = 'Orphan'
  AND c.user_id IS NULL
  AND c.team_id IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  role TEXT CHECK (role IN ('user', 'assistant', 'system')) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- embedding metadata for messages (optional)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS embedding_created_at TIMESTAMPTZ;

-- =========================
-- RAG: documents & chunks
-- =========================
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  source_type TEXT,        -- e.g., 'pdf', 'upload'
  source_uri TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  checksum TEXT,
  ingestion_status TEXT NOT NULL DEFAULT 'pending',
  ingested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  embedding vector(1536),
  embedding_model TEXT,
  embedding_created_at TIMESTAMPTZ,
  embedding_metadata JSONB NOT NULL DEFAULT '{}',
  token_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- optional full-text search vector and index
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_document_chunks_search_vector
  ON document_chunks USING GIN (search_vector);

-- example vector index
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
  ON document_chunks USING ivfflat (embedding vector_l2_ops) WITH (lists = 100);

-- =========================
-- RAG: query tracking
-- =========================
CREATE TABLE IF NOT EXISTS rag_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  query_text TEXT NOT NULL,
  response_text TEXT,
  response_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieved_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rag_query_id UUID REFERENCES rag_queries(id) ON DELETE CASCADE,
  document_chunk_id UUID REFERENCES document_chunks(id),
  score DOUBLE PRECISION,
  rank INTEGER,
  used_in_prompt BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rag_query_id UUID REFERENCES rag_queries(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  is_approved BOOLEAN DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- audit & usage
-- =========================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id UUID,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);

-- backfill audit_logs.team_id from personal teams
UPDATE audit_logs al
SET team_id = t.id
FROM teams t
WHERE al.user_id = t.owner_user_id
  AND al.team_id IS NULL;

CREATE TABLE IF NOT EXISTS usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id),
  user_id UUID REFERENCES users(id),
  metric_name TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
