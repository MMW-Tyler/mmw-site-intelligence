# MMW Site Intelligence

Unified internal tool that merges Site Auditor + Content Scout + (upcoming) Brand Voice into a single webapp powered by one shared crawl. Replaces the standalone `mmw-site-auditor` and `mmw-content-scout` repos.

## Architecture in one paragraph

A single `POST /api/crawl` endpoint kicks off a crawl that discovers a client's pages (XML sitemap → sitemap index → HTML sitemap fallback → link-following), fetches each one, extracts SEO metadata + clean prose content + full plain-text, and persists everything to Supabase. Three analyzer tabs (Audit, Scout, Brand Voice) each read from `crawl_pages` and produce their own outputs. The Brand Voice analyzer also exposes an `/api/brand-voice/:client_id` endpoint that other MMW tools (Content Engine, Press Release Writer, future Blog Writer) call to pull a voice profile into their generation prompts.

Everything is async with SSE progress streaming, so crawls of 500+ pages don't block HTTP requests and don't depend on Render keeping a single response open.

## Repo layout

```
server.js                 — Express app, route definitions only
jobs.js                   — In-memory active-crawl state (SSE clients, cancel flag)
crawl/
  engine.js               — Crawler (lifted from old Site Auditor v1.4)
  extractor.js            — Cheerio content extraction (lifted from old Content Scout)
  store.js                — Supabase persistence (clients, crawls, pages)
analyzers/                — Phase 2/3/4: audit.js, scout.js, voice.js
prompts/                  — Phase 4: voice-analysis.js, voice-profile.js
api/                      — Phase 4: brand-voice.js (cross-tool API endpoints)
public/index.html         — Single-page UI with tabs (Crawl / Audit / Scout / Voice)
migrations/               — SQL schema (run in Supabase SQL editor)
```

## Setup

1. **Create a new Supabase project** (don't reuse Content Engine's). Save the project URL and the **service role key** (not the anon key).
2. Run `migrations/001_initial_schema.sql` in the Supabase SQL editor.
3. Locally:
   ```bash
   npm install
   cp .env.example .env
   # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
   npm start
   # → http://localhost:3000
   ```
4. On Render:
   - New Web Service from this repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment tab
   - Render auto-sets `PORT`

## Phase status

- **Phase 1 (current)** — Skeleton, shared crawl service, Supabase persistence, Crawl tab UI
- **Phase 2 (next)** — Audit tab (port from old Site Auditor — CSV export, cannibalization, content audit)
- **Phase 3** — Scout tab (port from old Content Scout — Markdown batches for AI context)
- **Phase 4** — Brand Voice tab + cross-tool API

## Storage policy

Per-page rows are kept only for the **latest crawl per client**. When a new crawl finishes, the previous crawl's `crawl_pages` rows are deleted (the parent `crawls` row stays for history). This bounds storage to roughly N clients × latest page count, well under Supabase's free tier limits.

We don't store raw HTML — only extracted text + metadata. If a future analyzer needs the raw HTML, we re-crawl that one client (~2 minutes for a 200-page site) rather than storing it speculatively.

## Why this was merged

The old setup had Site Auditor and Content Scout each doing their own crawl of the same client site — redundant fetches, separate UIs, no shared sitemap, no way for downstream tools to reuse the content. This merge eliminates the duplicate work, gives Brand Voice a place to live without building yet another crawler, and creates a single source of truth that other MMW tools (Content Engine, Press Release Writer, Blog Writer) can read from via a clean API.

## Notes for the team

- The crawler is polite by default: 2 concurrent requests, 300ms delay between fetches, sets a `User-Agent` identifying as MMW-Crawler. These are tunable per-crawl in the UI.
- Cancellation is supported mid-crawl. If you hit Cancel, in-flight requests finish but no new ones start, and the partial results are preserved with `status='cancelled'`.
- Render's free tier sleeps after 15 min of inactivity. For long crawls, the SSE stream may briefly hiccup if Render restarts the process — but the crawl itself runs to completion in the background, and you can check final status via `GET /api/crawl/:id`.
