-- SoumyaOps — Complete PostgreSQL Schema
-- Run: psql -U postgres -d soumyaops -f migrations/001_initial_schema.sql

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for keyword search

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  github_id       VARCHAR(64) UNIQUE,
  username        VARCHAR(128) NOT NULL,
  email           VARCHAR(256) UNIQUE,
  avatar_url      TEXT,
  github_token    TEXT,            -- encrypted OAuth token
  refresh_token   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Workspaces ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(128) NOT NULL,
  slug            VARCHAR(128) UNIQUE NOT NULL,
  telegram_bot_token  TEXT,
  telegram_webhook_url TEXT,
  pinecone_namespace   VARCHAR(128),  -- isolated namespace per workspace
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Workspace members (team)
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(32) DEFAULT 'member', -- owner | admin | member
  joined_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

-- ── Messages (Telegram + manual ingestion) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  source          VARCHAR(32) NOT NULL, -- 'telegram' | 'manual' | 'file'
  telegram_msg_id BIGINT,
  sender_name     VARCHAR(128),
  sender_id       VARCHAR(128),
  content         TEXT NOT NULL,
  content_type    VARCHAR(32) DEFAULT 'text', -- 'text' | 'voice' | 'document'
  voice_file_id   TEXT,           -- Telegram file_id for voice
  metadata        JSONB DEFAULT '{}',
  vector_id       VARCHAR(256),   -- Pinecone vector ID
  embedded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_workspace ON messages(workspace_id);
CREATE INDEX idx_messages_source ON messages(source);
CREATE INDEX idx_messages_created ON messages(created_at DESC);
-- GIN index for full-text keyword search
CREATE INDEX idx_messages_content_gin ON messages USING GIN (to_tsvector('english', content));

-- ── Documents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by     UUID REFERENCES users(id),
  file_name       VARCHAR(256) NOT NULL,
  file_type       VARCHAR(64),    -- 'txt' | 'json' | 'md'
  file_size       INTEGER,
  content         TEXT,
  chunk_count     INTEGER DEFAULT 0,
  vector_ids      TEXT[],         -- array of Pinecone vector IDs
  embedded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── GitHub Repositories ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repositories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  repo_url        TEXT NOT NULL,
  repo_full_name  VARCHAR(256),   -- owner/repo
  default_branch  VARCHAR(128) DEFAULT 'main',
  detected_type   VARCHAR(32),    -- 'frontend' | 'backend' | 'fullstack'
  detected_stack  JSONB,          -- { frontend: 'react', backend: 'node', ... }
  local_path      TEXT,           -- where it was cloned
  vector_ids      TEXT[],
  last_analyzed   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Log Entries ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS log_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id         UUID REFERENCES repositories(id),
  raw_log         TEXT NOT NULL,
  level           VARCHAR(16),    -- 'ERROR' | 'WARN' | 'INFO'
  error_type      VARCHAR(128),
  error_message   TEXT,
  stack_trace     TEXT,
  file_path       TEXT,
  line_number     INTEGER,
  metadata        JSONB DEFAULT '{}',
  status          VARCHAR(32) DEFAULT 'open', -- 'open' | 'fixing' | 'fixed' | 'pr_created'
  vector_id       VARCHAR(256),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_logs_workspace ON log_entries(workspace_id);
CREATE INDEX idx_logs_status ON log_entries(status);
CREATE INDEX idx_logs_level ON log_entries(level);

-- ── Fix Suggestions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fix_suggestions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  log_entry_id    UUID REFERENCES log_entries(id) ON DELETE CASCADE,
  workspace_id    UUID REFERENCES workspaces(id),
  suggested_fix   TEXT NOT NULL,
  explanation     TEXT,
  files_changed   JSONB,          -- [{path, before, after}]
  sources_used    JSONB,          -- RAG sources that informed the fix
  pr_url          TEXT,
  pr_number       INTEGER,
  status          VARCHAR(32) DEFAULT 'pending', -- 'pending' | 'pr_created' | 'dismissed'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Deployments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deployments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id         UUID REFERENCES repositories(id),
  triggered_by    UUID REFERENCES users(id),
  platform        VARCHAR(32),    -- 'vercel' | 'railway' | 'render'
  deploy_type     VARCHAR(32),    -- 'frontend' | 'backend'
  env_vars        JSONB DEFAULT '{}', -- encrypted env vars
  status          VARCHAR(32) DEFAULT 'queued', -- 'queued'|'building'|'deployed'|'failed'
  live_url        TEXT,
  deploy_id       VARCHAR(256),   -- platform-specific deployment ID
  logs            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── RAG Query History ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rag_queries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  sources         JSONB,          -- [{id, source, excerpt, score}]
  tokens_used     INTEGER,
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_deployments_updated_at
  BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();