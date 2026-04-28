-- Phase 6: client profile fields + optimization history tables

ALTER TABLE clients ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS practice_type TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS built_by_mmw BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tagline TEXT;

-- SEO optimization push history
CREATE TABLE IF NOT EXISTS seo_optimizations (
  id           BIGSERIAL PRIMARY KEY,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  crawl_id     UUID REFERENCES crawls(id) ON DELETE SET NULL,
  url          TEXT NOT NULL,
  before_title TEXT,
  before_meta  TEXT,
  after_title  TEXT,
  after_meta   TEXT,
  pushed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS seo_opts_client_pushed
  ON seo_optimizations (client_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS seo_opts_crawl
  ON seo_optimizations (crawl_id);

-- Schema optimization push history
CREATE TABLE IF NOT EXISTS schema_optimizations (
  id          BIGSERIAL PRIMARY KEY,
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  crawl_id    UUID REFERENCES crawls(id) ON DELETE SET NULL,
  url         TEXT NOT NULL,
  post_id     BIGINT,
  schema_type TEXT,
  schema      JSONB,
  pushed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS schema_opts_client_pushed
  ON schema_optimizations (client_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS schema_opts_crawl
  ON schema_optimizations (crawl_id);
