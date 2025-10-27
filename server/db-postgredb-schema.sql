-- Drop tables in FK-safe order for schema recreation
DROP TABLE IF EXISTS proofread_runs CASCADE;
DROP TABLE IF EXISTS translation_memory_versions CASCADE;
DROP TABLE IF EXISTS translation_memory CASCADE;
DROP TABLE IF EXISTS translation_drafts CASCADE;
DROP TABLE IF EXISTS proofreading_history CASCADE;
DROP TABLE IF EXISTS ebook_cover_sets CASCADE;
DROP TABLE IF EXISTS ebook_artifacts CASCADE;
DROP TABLE IF EXISTS project_usage_totals CASCADE;
DROP TABLE IF EXISTS token_usage_events CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS licenses CASCADE;
DROP TABLE IF EXISTS user_subscriptions CASCADE;
DROP TABLE IF EXISTS service_plans CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS translation_batches CASCADE;
DROP TABLE IF EXISTS translationprojects CASCADE;
-- PostgreSQL schema for Project-T1 user, plan, and license management

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  nick_name TEXT,
  email TEXT UNIQUE NOT NULL,
  contact_info TEXT,
  photo TEXT,
  address TEXT,
  writer_cv TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS service_plans (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  max_jobs INT,
  max_characters INT,
  price_cents INT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  plan_id INT REFERENCES service_plans(id),
  started_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS licenses (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  license_key TEXT UNIQUE NOT NULL,
  issued_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  is_valid BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  project_id UUID REFERENCES translationprojects(project_id),
  document_id TEXT,
  type TEXT, -- e.g., 'analyze', 'translate'
  status TEXT, -- e.g., 'queued', 'running', 'done', 'failed'
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  attempts INT DEFAULT 0,
  last_error TEXT,
  workflow_run_id UUID
);


-- Table for tracking translation batches (hybrid pattern)
CREATE TABLE IF NOT EXISTS translation_batches (
  id SERIAL PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  batch_index INT,
  status TEXT, -- queued, running, done, failed
  mongo_batch_id TEXT, -- stores MongoDB ObjectId as string
  started_at TIMESTAMPTZ,
  openai_started_at TIMESTAMPTZ, -- when OpenAI request starts
  finished_at TIMESTAMPTZ,
  error TEXT
);

CREATE TABLE IF NOT EXISTS translationprojects (
  project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES users(user_id),
  title TEXT,
  description TEXT,
  intention TEXT,
  book_title TEXT,
  author_name TEXT,
  translator_name TEXT,
  memo TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  status TEXT,
  origin_lang TEXT DEFAULT 'ko',
  target_lang TEXT DEFAULT 'en',
  origin_file TEXT, -- MongoDB document _id for origin file
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS translation_memory (
  project_id UUID PRIMARY KEY REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  memory JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS translation_memory_versions (
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  version INT NOT NULL,
  memory JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

CREATE TABLE IF NOT EXISTS translation_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  workflow_run_id UUID REFERENCES workflow_runs(run_id),
  stage TEXT NOT NULL CHECK (stage IN ('literal','style','emotion','qa','draft','revise','micro-check')),
  batch_id UUID,
  segment_index INT NOT NULL,
  segment_id TEXT,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  text_source TEXT NOT NULL,
  text_target TEXT,
  back_translation TEXT,
  baseline JSONB,
  scores JSONB,
  guards JSONB,
  notes JSONB,
  span_pairs JSONB,
  candidates JSONB,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_translation_drafts_job_stage
  ON translation_drafts (job_id, stage, segment_index);

CREATE UNIQUE INDEX IF NOT EXISTS uq_translation_drafts_job_stage
  ON translation_drafts (job_id, stage, segment_index);

CREATE INDEX IF NOT EXISTS idx_translation_drafts_project
  ON translation_drafts (project_id, stage);

CREATE TABLE IF NOT EXISTS proofreading_history (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES translationprojects(project_id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  proofreading_id UUID UNIQUE NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proofreading_history_project
  ON proofreading_history (project_id);

CREATE INDEX IF NOT EXISTS idx_proofreading_history_job
  ON proofreading_history (job_id);

CREATE TABLE IF NOT EXISTS proofread_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  translation_file_id TEXT NOT NULL,
  memory_version INT,
  final_text_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proofread_runs_dedupe
  ON proofread_runs (project_id, translation_file_id, memory_version, final_text_hash);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  batch_id TEXT,
  event_type TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_cost NUMERIC(14,6) DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_events_project ON token_usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_job ON token_usage_events(job_id);

CREATE TABLE IF NOT EXISTS project_usage_totals (
  project_id UUID PRIMARY KEY REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  total_input_tokens BIGINT DEFAULT 0,
  total_output_tokens BIGINT DEFAULT 0,
  total_cost NUMERIC(14,6) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ebook_artifacts (
  ebook_id UUID PRIMARY KEY,
  project_id UUID REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  translation_file_id TEXT NOT NULL,
  quality_assessment_id TEXT,
  format TEXT NOT NULL DEFAULT 'txt',
  status TEXT NOT NULL DEFAULT 'pending',
  storage_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_artifacts_project ON ebook_artifacts(project_id);

CREATE TABLE IF NOT EXISTS ebooks (
  ebook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  translator TEXT,
  source_language TEXT,
  target_language TEXT,
  synopsis TEXT,
  current_version_id UUID,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ebooks_project ON ebooks(project_id);
CREATE INDEX IF NOT EXISTS idx_ebooks_status ON ebooks(status);

CREATE TABLE IF NOT EXISTS ebook_cover_sets (
  cover_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  ebook_id UUID REFERENCES ebooks(ebook_id) ON DELETE CASCADE,
  translation_profile_id TEXT,
  job_id TEXT,
  title TEXT,
  author TEXT,
  translator TEXT,
  target_language TEXT,
  summary_snapshot TEXT,
  prompt TEXT,
  writer_note TEXT,
  translator_note TEXT,
  isbn TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_cover_sets_project ON ebook_cover_sets(project_id);
CREATE INDEX IF NOT EXISTS idx_ebook_cover_sets_status ON ebook_cover_sets(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ebook_cover_sets_current ON ebook_cover_sets(project_id) WHERE is_current = TRUE;

DO $$
BEGIN
  ALTER TABLE ebook_cover_sets
    ADD COLUMN IF NOT EXISTS failure_reason TEXT;
END;
$$;

CREATE TABLE IF NOT EXISTS ebook_versions (
  ebook_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id UUID NOT NULL REFERENCES ebooks(ebook_id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  translation_file_id TEXT NOT NULL,
  quality_assessment_id TEXT,
  export_format TEXT NOT NULL,
  file_asset_id UUID,
  word_count INTEGER,
  character_count INTEGER,
  change_notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ebook_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_ebook_versions_ebook ON ebook_versions(ebook_id);

DO $$
BEGIN
  ALTER TABLE ebooks
    ADD CONSTRAINT ebooks_current_version_fk
      FOREIGN KEY (current_version_id)
      REFERENCES ebook_versions(ebook_version_id)
      ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS ebook_assets (
  ebook_asset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_version_id UUID REFERENCES ebook_versions(ebook_version_id) ON DELETE SET NULL,
  cover_set_id UUID REFERENCES ebook_cover_sets(cover_set_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES translationprojects(project_id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  source TEXT,
  metadata JSONB,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_assets_project ON ebook_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_ebook_assets_type ON ebook_assets(asset_type);

-- Workflow orchestration tables

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  requested_by TEXT,
  intent_text TEXT,
  label TEXT,
  parent_run_id UUID,
  metadata JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_type
  ON workflow_runs(project_id, type);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent
  ON workflow_runs(parent_run_id);

CREATE TABLE IF NOT EXISTS workflow_state (
  project_id UUID NOT NULL,
  type TEXT NOT NULL,
  current_run_id UUID,
  status TEXT NOT NULL DEFAULT 'idle',
  label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, type)
);

CREATE INDEX IF NOT EXISTS idx_workflow_state_project
  ON workflow_state(project_id);

CREATE TABLE IF NOT EXISTS conversation_intent_snapshots (
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  last_intent JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_intents_updated
  ON conversation_intent_snapshots(updated_at);

DO $$
BEGIN
  ALTER TABLE ebook_assets
    ADD COLUMN IF NOT EXISTS cover_set_id UUID REFERENCES ebook_cover_sets(cover_set_id) ON DELETE CASCADE;
EXCEPTION
  WHEN undefined_table THEN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS ebook_metadata (
  ebook_id UUID PRIMARY KEY REFERENCES ebooks(ebook_id) ON DELETE CASCADE,
  writer_note TEXT,
  translator_note TEXT,
  isbn TEXT,
  publisher_imprint TEXT,
  copyright_statement TEXT,
  audience TEXT,
  keywords TEXT[],
  extra JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ebook_metadata_isbn ON ebook_metadata(isbn) WHERE isbn IS NOT NULL;

CREATE TABLE IF NOT EXISTS ebook_distribution_channels (
  channel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id UUID NOT NULL REFERENCES ebooks(ebook_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  listing_id TEXT,
  price NUMERIC(10,2),
  currency TEXT,
  planned_publish_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  failure_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_distribution_ebook ON ebook_distribution_channels(ebook_id);
CREATE INDEX IF NOT EXISTS idx_ebook_distribution_channel ON ebook_distribution_channels(channel);

CREATE TABLE IF NOT EXISTS ebook_audit_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id UUID REFERENCES ebooks(ebook_id) ON DELETE CASCADE,
  ebook_version_id UUID REFERENCES ebook_versions(ebook_version_id) ON DELETE SET NULL,
  cover_set_id UUID REFERENCES ebook_cover_sets(cover_set_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_audit_ebook ON ebook_audit_log(ebook_id);
CREATE INDEX IF NOT EXISTS idx_ebook_audit_event ON ebook_audit_log(event_type);
