-- 1. ensure extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. ensure required roles
INSERT INTO roles (name) VALUES ('admin'), ('member'), ('viewer')
  ON CONFLICT (name) DO NOTHING;

-- 3. create user if not exists
INSERT INTO users (email, password_hash, display_name, is_email_verified, created_at, updated_at)
VALUES (
  'test@example.com',
  crypt('Password123!', gen_salt('bf', 12)),
  'Test User',
  TRUE,
  now(),
  now()
)
ON CONFLICT (email) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  is_email_verified = TRUE,
  updated_at = now();

-- 4. create or get personal team & assign membership
WITH user_cte AS (
  SELECT id, email FROM users WHERE email = 'test@example.com'
),
ensure_team AS (
  -- try to insert a personal team
  INSERT INTO teams (name, owner_user_id, created_at, updated_at)
  SELECT
    concat('Personal: ', email),
    id,
    now(),
    now()
  FROM user_cte
  ON CONFLICT (owner_user_id) DO NOTHING
),
team_cte AS (
  -- always get the team ID
  SELECT id, owner_user_id FROM teams WHERE owner_user_id = (SELECT id FROM user_cte)
),
role_cte AS (
  SELECT id AS role_id FROM roles WHERE name = 'admin' LIMIT 1
)
INSERT INTO team_members (team_id, user_id, role_id, joined_at)
SELECT
  t.id,
  u.id,
  r.role_id,
  now()
FROM team_cte t
JOIN user_cte u ON t.owner_user_id = u.id
JOIN role_cte r ON TRUE
ON CONFLICT (team_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id;
