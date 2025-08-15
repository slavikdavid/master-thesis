-- =========================
-- extensions
-- =========================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- for pgvector
