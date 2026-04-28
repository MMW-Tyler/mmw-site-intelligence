# MMW Site Intelligence

Unified internal tool that merges the standalone **MMW Site Auditor** and **MMW Content Scout** into a single webapp powered by one shared crawl, with a third **Brand Voice** module being built on top of the same foundation. Replaces both legacy repos.

This README is the project's single source of truth. It exists so that any contributor — human or AI — can pick up the work without needing the conversation history that produced it. If something in this README contradicts the code, the README is wrong; update it.

---

## Why this tool exists

MMW (Medical Marketing Whiz) builds and maintains websites for medical clinics and aesthetics practices. Two pieces of MMW's internal tooling — Site Auditor and Content Scout — both started by crawling a client's website, then did different things with the result:

- **Site Auditor** did SEO audits — page inventory, status codes, thin content, missing metadata, cannibalization detection, CSV export. Used during onboarding and pre-migration.
- **Content Scout** extracted clean prose from each page and wrote Markdown content blocks for use as AI context (in the Content Engine and elsewhere). Used during content production.

Both tools crawled the same client sites independently, producing redundant fetches, separate UIs, and no shared inventory. There was also no obvious place to add a third concern that needed similar input — analyzing approved client content to derive a "brand voice" profile that downstream MMW tools could reuse.

The merge:

1. Eliminates duplicate crawl work
2. Creates a single inventory of client pages that any analyzer can read from
3. Gives Brand Voice a place to live without building yet another crawler
4. Establishes the pattern for future analyzers (any new "thing you do with crawled content" gets added as a new analyzer, not a new app)
5. Exposes Brand Voice profiles via an authenticated API so other MMW tools (Content Engine, Press Release Writer, the future Blog Writer) can pull a client's voice into their generation prompts

---

## The four-phase build plan

The project is being built in four phases. Each phase is independently shippable — when a phase finishes, the tool is still useful, just with fewer features. Phases 1, 2, and 3 are done; phase 4 is the remaining work.

### Phase 1 — Crawl service + skeleton (DONE)

**Goal:** Stand up the foundation. One shared crawl service that any analyzer can read from. Async job pattern so crawls don't block HTTP requests. Persistence to Supabase. Three-tab UI shell with Crawl active and the other tabs visible-but-disabled so the team can see what's coming.

**What was delivered:**
- Crawl engine (`crawl/engine.js`) lifted from the legacy Site Auditor's v1.4 crawler with two changes: (a) each fetched page also runs through the content extractor so we get clean prose alongside SEO metadata, (b) a `persistPage` callback writes each page to Supabase as it completes (instead of buffering in memory).
- Content extractor (`crawl/extractor.js`) lifted from the legacy Content Scout with one addition: also returns full plain-text (capped at 12K chars) for Brand Voice analysis.
- Supabase store (`crawl/store.js`) — all DB access in one module; lifecycle is upsertClient → createCrawl → persistPage × N → finalizeCrawl.
- Job manager (`jobs.js`) — in-memory state for active crawls (SSE clients, cancel flag, replay buffer). Durable record lives in Supabase.
- SSE-based progress streaming, mid-crawl cancellation.
- Schema (`migrations/001_initial_schema.sql`) — four tables (`clients`, `crawls`, `crawl_pages`, `brand_voices`) plus a Postgres trigger enforcing one `is_latest=true` crawl per client.
- Three-tab UI in `public/index.html` matching the MMW brand styling used in the Tools Hub.

### Phase 2 — Audit tab (DONE)

**Goal:** Replace the old standalone Site Auditor's UI with a simplified single-screen Audit tab inside this app. Reads from `crawl_pages` — never re-crawls.

**Simplification call:** The old Auditor had four sub-tabs (Overview / Inventory / Audit / Cannibalization). This phase consolidated to one screen. The four old views map to (a) overview stats card at the top, (b) clickable issue tiles that filter the inventory table, (c) a cannibalization card that surfaces between issues and the table when clusters exist, (d) the inventory table as the default view with status/text filters and column sorting. Filtering replaces tab-switching.

**What was delivered:**
- Audit analyzer (`analyzers/audit.js`) — pure functions, no DB access. Takes pages array, returns `{ summary, pages: [...with flags], cannibalClusters }`. Also has `buildCSV(pages)`.
- Cannibalization detection by title-suffix stripping (the part before `|`, `–`, `:` etc.) — catches the realistic cannibal case without false-positiving on shared site-name suffixes.
- Issue flagging: `thin`, `title_missing`, `title_short`, `title_long`, `meta_missing`, `meta_short`, `meta_long`, `h1_missing`, `no_cta`, `canonical_other`, `cannibal`, `http_error`, `fetch_failed`, `redirect`, `noindex`. Thresholds are constants in `analyzers/audit.js`, not UI knobs (tune later if needed).
- Three new endpoints in `server.js`: `GET /api/crawls`, `GET /api/audit/:id` (where `:id` can be the literal string `"latest"` to auto-pick the most recent finished crawl across all clients), `GET /api/audit/:id.csv`.
- New store functions: `getMostRecentFinishedCrawl()`, `listFinishedCrawls()`.
- Audit tab UI: toolbar with crawl-switcher dropdown and CSV download button, overview stats grid, clickable issue tiles, conditional cannibalization card, sortable + filterable inventory table.
- CSV column names cleaned up (no longer mirroring Screaming Frog's "Address / Title 1" — just "URL / Title" etc.) since MMW doesn't use Screaming Frog.

### Phase 3 — Scout tab (DONE)

**Goal:** Port the legacy Content Scout's functionality (Markdown content blocks for AI context) into a Scout tab that reads from the shared crawl. The legacy Scout asked the user to paste a list of URLs, then re-fetched each one. The Scout tab should never re-fetch — pages from the most recent crawl come pre-loaded with checkboxes.

**Design intent:**
- Default view: list of pages from the most recent crawl (same auto-select pattern as Audit), with checkboxes and a search/filter row.
- User selects which pages to include. There should be sensible defaults — exclude obvious "not content" pages (404s, redirects, contact-form-only pages, pages with `extracted_body` length below some threshold). Service/landing/about-style pages should be checked by default.
- Output configuration: batch size (default 100, matching old Scout), site name (used in the manifest filename and Markdown header).
- Generate button produces the same Markdown output format as the old Content Scout: per-page block with H1, H2/H3 headings, prose body, separator. Batched into files of N pages each. Manifest file lists all batches.
- Download as a zip of `.md` files (the old Scout output is a folder of files — preserve this since the team's downstream workflow expects it).
- Cleaning rules from the old Scout's `extractContent()` are already applied at crawl time (the extracted content is in `crawl_pages.extracted_body` and `crawl_pages.headings`). Phase 3 just consumes that data.

**What was delivered:**
- Scout analyzer (`analyzers/scout.js`) — pure functions: `shouldDefaultCheck(page)` (default selection heuristic), `formatPageBlock(page)`, `formatBatch(pages, opts)`, `formatManifest(batchMeta, opts)`, `buildBatches(pages, batchSize)`.
- Default selection heuristic: checks pages with status 2xx, indexable, 150+ words, excludes cart/login/admin/asset URLs.
- Markdown format: batch file opens with a header line, then each page as `## H1 or Title`, URL, subheadings line, then extracted body prose. Pages separated by `---`. Manifest lists all batch files.
- Zip via `jszip` — server generates a `nodebuffer` and sends it as `application/zip`. Client uses fetch + Blob URL to trigger the download.
- Two new endpoints in `server.js`: `GET /api/scout/:crawlId/pages` (lightweight metadata via `getCrawlPagesMeta`, includes `default_checked` flag), `POST /api/scout/:crawlId/generate` (builds and returns a zip stream).
- New store function: `getCrawlPagesMeta(crawlId)` — selects only the columns needed for the picker (no extracted_body/text), keeping the response small.
- Scout tab UI: crawl-switcher dropdown (same crawl list as Audit), site name input (auto-populated from client name), batch size input (default 100), Generate button with selected count. Page picker with checkboxes, search, content filter, and Select defaults / Select visible / Deselect all buttons. Header checkbox with indeterminate state. Sortable columns.

### Phase 4 — Brand Voice tab + cross-tool API (NEXT)

**Goal:** Build the Brand Voice analyzer and expose it as an API so other MMW tools (Content Engine, Press Release Writer, future Blog Writer) can pull a client's brand voice profile into their generation prompts. This is the highest-leverage phase — every downstream content tool gets better once Brand Voice exists.

**Design intent:**
- Voice tab UI: list of pages from the most recent crawl (similar to Scout), but with checkboxes labeled "approved brand content." User picks which pages represent the client's voice (typically: about page, service detail pages, blog posts written by the client themselves — NOT third-party content, NOT generic landing pages).
- Generate button: server pulls `extracted_text` from selected pages, runs analysis prompts against the Anthropic Claude API, produces a structured Brand Voice profile.
- Profile shape (saved as JSONB in `brand_voices.profile`):
  ```
  {
    "tone_descriptors": ["warm", "expert-but-approachable", "patient-focused"],
    "vocabulary": {
      "preferred_terms": [...],
      "avoided_terms": [...],
      "industry_specificity": "moderate" | "high" | "low"
    },
    "sentence_structure": {
      "avg_length": "short" | "medium" | "long",
      "rhythm": "varied" | "consistent",
      "uses_questions": true | false,
      "uses_lists": "frequently" | "sparingly" | "never"
    },
    "point_of_view": "first_person_plural" | "second_person" | "third_person",
    "do_examples": [3-5 short excerpts],
    "dont_examples": [3-5 short excerpts of voice that would NOT match],
    "summary_paragraph": "one paragraph that an AI can drop into a system prompt"
  }
  ```
- After generation, the profile is editable. The AI's first pass needs human refinement; the UI should let Tyler/Lori/Kat tweak any field. Save → updates the row, sets `human_edited = true`.
- The API: `GET /api/brand-voice/:client_id` and `GET /api/brand-voice/by-domain/:domain` return the profile as JSON. **Auth is required for these endpoints** (see Auth section below). Other tools call this and inject `profile.summary_paragraph` plus the do/don't examples into their generation prompts.
- One profile per client (the schema already has a unique index on `client_id`). Regenerating overwrites.

**Files this phase will touch:**
- New: `analyzers/voice.js` — orchestrates the voice analysis.
- New: `prompts/voice-analysis.js` — the analysis prompt(s). **Follow the Content Engine's `prompts.js` pattern** — prompts isolated from server logic so they can be edited without touching code paths.
- New: `prompts/voice-profile.js` — prompt for synthesizing analysis output into the structured profile.
- New: `api/brand-voice.js` — the cross-tool API endpoint(s).
- Modify: `server.js`, `public/index.html`, `README.md`.
- Add: auth middleware (see below).

**Cross-tool integration (after phase 4 is shipped):**
The Content Engine and Press Release Writer repos will need a small update: when generating content for a known client, fetch the brand voice profile via this app's API and inject it into the prompt. That work happens in those repos, not this one — phase 4 just provides the API.

---

## Architectural decisions (and why)

### One Supabase project per tool, never shared databases

Each MMW tool gets its own Supabase project. This tool has its own. Content Engine has its own. Press Release Writer has its own. Brand Voice profiles live in *this tool's* database; other tools fetch them via authenticated API call.

**Why:** Blast radius (a bad migration in one tool can't break others), independent schema evolution, cleaner auth boundaries, free-tier math. This is the standard "database-per-service" pattern. Do not "consolidate the databases" — that's the wrong direction.

### Storage policy: extracted text + metadata only, latest crawl only

Per-page rows are kept only for the **latest crawl per client**. When a new crawl finishes, the previous crawl's `crawl_pages` rows are deleted (the parent `crawls` row stays for history). The Postgres trigger `enforce_single_latest_crawl` keeps `is_latest = true` unique per client.

**Why:** Bounds storage to N clients × latest page count, well under Supabase free tier. With 50 clients × 500 pages × ~3KB per row, we're at ~75 MB. Plenty of headroom.

We do **not** store raw HTML. If a future analyzer needs raw HTML, re-crawl that one client (~2 minutes for 200 pages). Don't add raw HTML storage speculatively.

### Async crawl jobs with SSE progress streaming

Crawls take minutes, not seconds. A synchronous "user clicks button, server crawls, server returns" pattern fails on Render past ~5 min and is bad UX regardless. The pattern we use:

1. `POST /api/crawl` creates a `crawls` row, kicks off the crawl, returns `{ crawlId }` immediately.
2. The crawl runs in the background; each page is persisted as it completes.
3. The frontend opens an SSE stream at `GET /api/crawl/:id/progress` for live updates.
4. When the crawl finishes, the SSE emits `done` and closes.
5. Final status can also be retrieved via `GET /api/crawl/:id` after the fact.

The in-memory `jobs.js` handles SSE clients and the cancellation flag. The durable record lives in Supabase. If Render restarts the process mid-crawl, the SSE drops but the user can check final status via the `crawls` table — not catastrophic.

### Async job state lives in memory, not Supabase

`jobs.js` is in-memory only. SSE clients are connections, not data — round-tripping every progress event through Supabase would add latency without value. The trade-off: if the process restarts mid-crawl, in-flight jobs are lost. For an internal tool with infrequent crawls, this is fine. If we ever need persistent active-crawl state across restarts, this is the place to refactor.

### Pure-function analyzers

Every analyzer (`analyzers/audit.js`, future `analyzers/scout.js`, `analyzers/voice.js`) is a pure-function module. It takes pages, returns derived data. **No DB access inside analyzers.** The server is responsible for fetching pages from Supabase and passing them in.

**Why:** Trivial unit testing, easier to reason about, swappable. If we ever want to expose an analyzer for cross-tool use without going through the UI, we can.

### Prompts isolated from server logic

When phase 4 lands, prompts live in `prompts/*.js`, not in `analyzers/voice.js` and not in `server.js`. This mirrors the Content Engine's pattern. The reason: prompt iteration is the highest-frequency form of change for these tools. Keeping them in dedicated files means non-technical team members can review them, and prompt edits don't risk introducing bugs in the surrounding code.

### Auth: deferred until phase 4, then required

Phases 1-3 ship without auth. The tool is internal, the URL isn't public, and adding auth gates would slow iteration. Phase 4 introduces a cross-tool API (`GET /api/brand-voice/:client_id`) that other tools will call — this endpoint MUST be authenticated. When phase 4 starts, add a simple shared-secret API key (env var, header check). Optionally protect the entire app at the same time. The Supabase service role key (which the server already uses) bypasses RLS, so RLS-based auth is not the right pattern here; a header-based API key is.

---

## Repo layout

```
server.js                 — Express app, route definitions only, no business logic
jobs.js                   — In-memory active-crawl state (SSE clients, cancel flag, replay buffer)
package.json
.env.example              — Template for required env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORT)

crawl/
  engine.js               — Crawler (sitemap discovery, fetching, redirect handling, concurrency)
  extractor.js            — Cheerio-based content extraction (returns headings + body + full text)
  store.js                — All Supabase access (clients, crawls, pages persistence + reads)

analyzers/
  audit.js                — Phase 2: stats, issue flagging, cannibalization detection, CSV builder
  scout.js                — Phase 3: default-check heuristic, Markdown content block formatting, zip manifest
  voice.js                — Phase 4: TODO — Brand voice analysis orchestration

prompts/                  — Phase 4: TODO — voice-analysis.js, voice-profile.js

api/                      — Phase 4: TODO — brand-voice.js (cross-tool authenticated endpoints)

migrations/
  001_initial_schema.sql  — clients, crawls, crawl_pages, brand_voices tables + trigger

public/
  index.html              — Single-page UI with four tabs (Crawl active, Audit active, Scout TODO, Voice TODO)
```

---

## Database schema

Run `migrations/001_initial_schema.sql` in the Supabase SQL editor for this project. The schema is:

- `clients` — `id, domain, name, created_at`. Unique index on `domain`. Domains are stored normalized (no protocol, no www, no path).
- `crawls` — `id, client_id, target_url, status, is_latest, page_count, error_count, sitemap_seeds, avg_word_count, settings (JSONB), error_message, started_at, finished_at`. Status is one of `queued | running | done | error | cancelled`. The trigger `enforce_single_latest_crawl` ensures only one crawl per client has `is_latest = true`.
- `crawl_pages` — `id, crawl_id, url, status_code, redirect_to, title, title_length, h1, h2_count, h2_sample, meta_description, meta_desc_present, word_count, inlinks, indexability, canonical_url, canonical_match, has_cta, headings (JSONB), extracted_body, extracted_text, fetched_at`. Foreign key to `crawls(id)` with `ON DELETE CASCADE`. When a new crawl finalizes, page rows from previous crawls for that client are deleted.
- `brand_voices` — `id, client_id, crawl_id, source_urls (JSONB), profile (JSONB), human_edited, generated_at, updated_at`. Unique index on `client_id` (one profile per client; regen overwrites).

---

## Setup (local dev)

```bash
npm install
cp .env.example .env
# Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm start
# → http://localhost:3000
```

Required env vars:
- `SUPABASE_URL` — the project URL (from Supabase Project Settings → API)
- `SUPABASE_SERVICE_ROLE_KEY` — the **service role key**, NOT the anon key. We use service role because there's no user-level auth yet; we trust the server.
- `PORT` — Render sets this automatically; only used for local dev.

Future env vars (when phase 4 lands):
- `ANTHROPIC_API_KEY` — for voice analysis prompts
- `MMW_INTERNAL_API_KEY` — shared secret for the cross-tool Brand Voice API

---

## Deployment (Render)

- New Web Service from the GitHub repo `MMW-Tyler/mmw-site-intelligence`
- Build command: `npm install`
- Start command: `npm start`
- Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Environment tab
- Render auto-deploys on push to `main` (matches MMW's other tools)

Render's free tier sleeps after 15 min of inactivity. First request after sleep takes 30-60s (cold start). For long crawls, if Render restarts mid-run, the SSE stream drops but the crawl process continues to completion — the user can check final status via `GET /api/crawl/:id`.

---

## API reference

### Crawl
- `POST /api/crawl` — body: `{ targetURL, clientName?, maxPages?, delay?, concurrency?, htmlSitemap?, noSitemap? }`. Returns `{ crawlId, clientId }`. Defaults: maxPages 500, delay 300ms, concurrency 2.
- `GET /api/crawl/:id/progress` — SSE stream. Events: `log`, `progress`, `page`, `summary`, `done`, `error`, `cancelled`.
- `GET /api/crawl/:id` — returns the `crawls` row.
- `POST /api/crawl/:id/cancel` — flips the cancel flag on an active crawl.
- `GET /api/crawl/:id/pages` — returns `{ crawlId, pages: [...] }`.
- `GET /api/crawls?limit=50` — list of finished crawls, newest first, with client info joined. Used to populate the Audit tab's crawl-switcher dropdown.

### Client lookup
- `GET /api/client/:domain/latest-crawl` — returns the latest crawl for a given domain.

### Audit (phase 2)
- `GET /api/audit/:id` — `:id` can be a crawl UUID or the literal string `"latest"`. Returns `{ crawl, summary, pages, cannibalClusters }`.
- `GET /api/audit/:id.csv` — returns CSV download with cleaned-up column names. Filename: `audit-{domain}-{date}.csv`.

### Scout (phase 3)
- `GET /api/scout/:crawlId/pages` — `:crawlId` can be a UUID or `"latest"`. Returns `{ crawlId, crawl, pages: [...with default_checked flag] }`. Page objects include: `url, status_code, title, h1, word_count, indexability, default_checked`.
- `POST /api/scout/:crawlId/generate` — body: `{ urls: [...], siteName, batchSize }`. Returns a `.zip` download containing `batch-001.md`, `batch-002.md`, … and `manifest.md`. Filename: `scout-{domain}-{date}.zip`.

### Brand Voice (phase 4) — to be added
- `POST /api/voice/:crawlId/generate` — body: `{ urls: [...] }`. Internal endpoint, no auth needed (used by the UI on the same origin).
- `PATCH /api/voice/:clientId` — edit a profile after generation.
- `GET /api/brand-voice/:clientId` and `GET /api/brand-voice/by-domain/:domain` — **authenticated** cross-tool API. Other MMW tools call these.

---

## Conventions and patterns to follow

These reflect Tyler's preferences across MMW's tools — match them for consistency:

- **Brand styling.** MMW colors `#28AB83` (green), `#323547` (dark), `#FFFFFF` (white), with `#E5F5F0` / `#F7FAF9` as background tones. Fonts: Poppins (headings), Barlow (UI labels), Lato (body). Use prose with selective bullets for generated content — not bullet-only output.
- **Em dashes are banned in generated content.** Applies to anything the tool *generates* (Brand Voice profiles, Markdown content blocks, etc.) — not to internal docs like this README.
- **Iterative, feedback-driven development.** Tyler tests locally, identifies specific problems, and expects targeted fixes — not broad rewrites. When in doubt, propose a smaller change.
- **Prompts in dedicated files.** Following the Content Engine pattern. Don't inline prompts in route handlers or analyzer logic.
- **Stateless-first.** Don't add Supabase persistence speculatively. The Press Release Writer is intentionally stateless. Each tool decides whether persistence earns its place.
- **Render auto-deploy on push.** Standard flow: `git add . && git commit -m "..." && git push origin main`. Render rebuilds and redeploys on every push to `main`.
- **Credential hygiene.** Never commit `.env`. Always check `git status` before committing. If a key is exposed, rotate immediately, then `git filter-branch` to scrub history.
- **Google Docs is MMW's primary document viewer**, not Word — relevant if any tool generates documents.
- **Layout-aware output, not flat blobs.** This came from the Content Engine but applies more broadly: when generating content, structure it for the consumer. Markdown should be clean. CSV columns should be sensibly named. JSON should be predictable.

---

## Known issues / open questions for future phases

- **Headings extraction on poorly-structured CMSes.** Tested against `birchpainandspinegroup.com` (Joomla) — many pages render section headings as `<p><strong>...</strong></p>` instead of `<h2>`, so the extractor reports zero headings on those pages. Real bug or just data quality? Not yet decided. Defer the call until we have crawls of 2-3 more representative client sites (one WordPress with Elementor, one without, one Squarespace if available). Then either: (a) accept that some sites have no semantic structure and Voice has to handle that, (b) add a `<strong>`-as-heading promotion heuristic conditional on "page has zero real H2/H3 + multiple `<p><strong>` patterns at start of paragraphs."
- **Cannibalization heuristic tuning.** Phase 2's title-prefix-stripping approach catches the realistic cannibal case but may produce noise on sites with menu duplication (the same URL surfacing under multiple menu parents and getting double-counted). Verify with more crawls before tuning.
- **Joomla content selector.** The extractor's `CONTENT_SELECTORS` array doesn't include Joomla-specific classes like `.com-content-article__body` or `.item-page` — falls back to `body` on Joomla sites. Worth adding when we touch the extractor again.

---

## Where the legacy code came from

The two source repos that this tool replaces:
- **`mmw-site-auditor`** — single Express server, vanilla JS frontend, `crawler-engine.js` v1.4. The crawl engine in this repo is lifted from there. The legacy Auditor's UI had four sub-tabs that have been consolidated to one screen here.
- **`mmw-content-scout`** — single Express server, vanilla JS frontend. The content extractor in this repo is lifted from its `extractContent()` function with one addition (full-text return for Voice). The legacy Scout had a paste-URLs workflow that this tool replaces with a select-from-crawl workflow.

Both legacy repos were configured for `pkg`-based local-binary distribution (`.exe`). That approach was abandoned in favor of webapp deployment on Render — the local-binary path was a workaround for synchronous-crawl limitations, not a real requirement. The async-job pattern this tool uses works fine on Render.

If you need the legacy source for reference — for example, to see the exact Markdown output format the old Scout produced — ask Tyler. The legacy repos are archived but still accessible.

---

## Related MMW tools (context for cross-tool integration)

- **MMW Content Engine** (`mmw-content-engine` on GitHub, `mmw-content-engine-1a35.onrender.com`). Generates website copy, sitemaps, SEO metadata, AEO content, FAQ schema from ClickUp client Markdown exports. Will consume Brand Voice profiles in phase 4 — the prompt assembly should be updated to fetch `summary_paragraph` + do/don't examples from this tool's API and inject them into the generation prompt.
- **MMW Marketing Analysis Report Generator** (`mmw-report-tool.onrender.com`). Generates digital presence reports for sales prospects. Independent — does not consume Brand Voice (different use case: prospects, not active clients).
- **MMW Press Release Writer** (`mmw-press-release.onrender.com`). Two-mode tool (custom AI-generated + Candela device templates). Will consume Brand Voice profiles in phase 4 for the custom mode.
- **MMW Tools Hub** (`mmw-hub.html`). Standalone HTML dashboard listing all tools. When this app goes live, add a card linking to it.

The future **Blog Writer** and **SEO Optimizer** tools (still on the hub as "coming soon") will also consume Brand Voice once phase 4 ships.
