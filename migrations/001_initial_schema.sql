-- ─── MMW Site Intelligence — Database Schema ────────────────────────────────
-- Run this in the Supabase SQL editor for the new project.
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS guards.

-- ─── clients ─────────────────────────────────────────────────────────────────
-- Lightweight client registry. Keyed by domain so we don't depend on external IDs.
-- Other MMW tools can map their own client IDs to a domain to look things up.

CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain      TEXT UNIQUE NOT NULL,        -- e.g. 'example.com' (no protocol, no www)
  name        TEXT,                         -- friendly name, e.g. 'Example Med Spa'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_domain ON clients(domain);

-- ─── crawls ──────────────────────────────────────────────────────────────────
-- One row per crawl run. Tracks status and high-level stats.
-- Old crawls' pages are deleted when a new crawl finishes (see crawl_pages cleanup).

CREATE TABLE IF NOT EXISTS crawls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  target_url      TEXT NOT NULL,            -- the URL the user submitted
  status          TEXT NOT NULL DEFAULT 'queued',
                  -- queued | running | done | error | cancelled
  is_latest       BOOLEAN NOT NULL DEFAULT FALSE,
                  -- only one crawl per client_id has is_latest = true
  page_count      INTEGER DEFAULT 0,
  error_count     INTEGER DEFAULT 0,
  sitemap_seeds   INTEGER DEFAULT 0,
  avg_word_count  INTEGER DEFAULT 0,
  settings        JSONB DEFAULT '{}'::jsonb,
                  -- { maxPages, delayMs, concurrency, htmlSitemap, noSitemap }
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crawls_client ON crawls(client_id);
CREATE INDEX IF NOT EXISTS idx_crawls_latest ON crawls(client_id, is_latest) WHERE is_latest = TRUE;

-- ─── crawl_pages ─────────────────────────────────────────────────────────────
-- One row per crawled URL. Stores extracted text + metadata only — no raw HTML.
-- If we ever need raw HTML for a new analyzer, we re-crawl that client.

CREATE TABLE IF NOT EXISTS crawl_pages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id           UUID NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  status_code        INTEGER,
  redirect_to        TEXT,

  -- audit-relevant metadata
  title              TEXT,
  title_length       INTEGER,
  h1                 TEXT,
  h2_count           INTEGER,
  h2_sample          TEXT,
  meta_description   TEXT,
  meta_desc_present  BOOLEAN,
  word_count         INTEGER,
  inlinks            INTEGER DEFAULT 0,
  indexability       TEXT,                -- 'Indexable' | 'Non-Indexable'
  canonical_url      TEXT,
  canonical_match    TEXT,                -- 'Self' | 'Other' | 'Missing'
  has_cta            BOOLEAN,

  -- scout-relevant content (extracted by extractor.js)
  -- These are nullable because failed/redirect pages won't have content.
  headings           JSONB,               -- [{ tag: 'h2', text: '...' }, ...]
  extracted_body     TEXT,                -- compressed prose body (~2800 chars max)
  extracted_text     TEXT,                -- full plain-text of page (for voice analysis)

  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawl_pages_crawl ON crawl_pages(crawl_id);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_status ON crawl_pages(crawl_id, status_code);

-- ─── brand_voices ────────────────────────────────────────────────────────────
-- Generated brand voice profiles. One per client (latest only — overwritten on regen).
-- Other MMW tools fetch via GET /api/brand-voice/:client_id (or by domain).

CREATE TABLE IF NOT EXISTS brand_voices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  crawl_id        UUID REFERENCES crawls(id) ON DELETE SET NULL,
                  -- which crawl was used as input (for traceability)
  source_urls     JSONB,                  -- which pages were marked 'approved'
  profile         JSONB NOT NULL,         -- the voice profile (see voice.js for shape)
  human_edited    BOOLEAN DEFAULT FALSE,  -- has Tyler/team adjusted it
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_voices_client ON brand_voices(client_id);

-- ─── helper: enforce single is_latest per client ─────────────────────────────
-- When a crawl flips to is_latest = true, unflip any other crawl for the same client.

CREATE OR REPLACE FUNCTION enforce_single_latest_crawl()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_latest = TRUE THEN
    UPDATE crawls
       SET is_latest = FALSE
     WHERE client_id = NEW.client_id
       AND id <> NEW.id
       AND is_latest = TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_single_latest_crawl ON crawls;
CREATE TRIGGER trg_enforce_single_latest_crawl
  BEFORE INSERT OR UPDATE OF is_latest ON crawls
  FOR EACH ROW
  EXECUTE FUNCTION enforce_single_latest_crawl();
