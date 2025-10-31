-- PostgreSQL schema for Project-T1 job queue and cache

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  document_id TEXT,
  type TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  attempts INT DEFAULT 0,
  last_error TEXT,
  workflow_run_id UUID
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ratelimits (
  key TEXT,
  ts TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT,
  batch_id TEXT,
  event_type TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_cost NUMERIC(14,6) DEFAULT 0,
  duration_ms INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_events_project ON token_usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_events_job ON token_usage_events(job_id);

CREATE TABLE IF NOT EXISTS translation_cancellation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL,
  project_id TEXT,
  user_id TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_usage_totals (
  project_id TEXT PRIMARY KEY,
  total_input_tokens BIGINT DEFAULT 0,
  total_output_tokens BIGINT DEFAULT 0,
  total_cost NUMERIC(14,6) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS translationprojects (
  project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  title TEXT,
  description TEXT,
  intention TEXT,
  book_title TEXT,
  author_name TEXT,
  translator_name TEXT,
  memo TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  user_consent TEXT,
  status TEXT,
  origin_lang TEXT DEFAULT 'ko',
  target_lang TEXT DEFAULT 'en',
  origin_file TEXT,
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
  job_id TEXT NOT NULL,
  workflow_run_id UUID,
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

CREATE TABLE IF NOT EXISTS ebooks (
  ebook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
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

CREATE TABLE IF NOT EXISTS ebook_cover_sets (
  cover_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  ebook_id UUID REFERENCES ebooks(ebook_id),
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

CREATE TABLE IF NOT EXISTS ebook_versions (
  ebook_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id UUID NOT NULL,
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
  ebook_version_id UUID REFERENCES ebook_versions(ebook_version_id),
  cover_set_id UUID REFERENCES ebook_cover_sets(cover_set_id),
  project_id UUID NOT NULL,
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

CREATE TABLE IF NOT EXISTS ebook_metadata (
  ebook_id UUID PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS ebook_audit_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id UUID,
  ebook_version_id UUID,
  cover_set_id UUID,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebook_audit_ebook ON ebook_audit_log(ebook_id);

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
