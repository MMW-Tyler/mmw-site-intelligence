-- ─── migration_archives ─────────────────────────────────────────────────────
-- Freezes a blog migration's source data — extracted post HTML, metadata,
-- and downloaded image bytes — at the moment it's captured, so it can be
-- imported into WordPress later without depending on the source site still
-- being up (e.g. when the old site is being decommissioned mid-migration).
-- Run this in the Supabase SQL editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS migration_archives (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  crawl_id     UUID REFERENCES crawls(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  source_url   TEXT,
  platform     TEXT,
  post_count   INTEGER NOT NULL DEFAULT 0,
  image_count  INTEGER NOT NULL DEFAULT 0,
  data         JSONB NOT NULL,
               -- { version, source_url, platform, exported_at, posts: [...], errors: [...] }
               -- Each post carries its extracted HTML (original <img> src
               -- attributes, not yet rewritten to a destination) plus its
               -- images as { original_url, filename, mime_type, data_base64,
               -- alt, width, height } — self-contained, no re-fetch needed.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_archives_client ON migration_archives(client_id);
