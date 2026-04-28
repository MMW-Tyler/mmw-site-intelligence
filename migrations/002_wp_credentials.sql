-- MMW Site Intelligence — Migration 002: WordPress credentials
-- Run this in the Supabase SQL editor for the Site Intelligence project.
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.
--
-- Adds WordPress connection fields to the clients table so the Optimize tab
-- can push SEO fields and schema directly to client WordPress sites.
-- Auth uses WordPress Application Passwords (WP core 5.6+) — no plugin required
-- for auth. The MMW Plugin (mmw-plugin.php) is still required for schema deploy.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS wp_url          TEXT,
  ADD COLUMN IF NOT EXISTS wp_username     TEXT,
  ADD COLUMN IF NOT EXISTS wp_app_password TEXT;

COMMENT ON COLUMN clients.wp_url          IS 'WordPress site URL, e.g. https://clientsite.com';
COMMENT ON COLUMN clients.wp_username     IS 'WordPress admin username for API access';
COMMENT ON COLUMN clients.wp_app_password IS 'WordPress Application Password (WP 5.6+). Stored plain text — never log or expose client-side.';
