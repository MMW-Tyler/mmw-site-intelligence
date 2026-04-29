/**
 * MMW Site Intelligence — Supabase Store
 *
 * All database access lives here. Server.js and crawl/engine.js call into
 * these functions and never touch Supabase directly. This keeps SQL in one
 * place and makes the storage layer swappable later if needed.
 *
 * Lifecycle of a crawl:
 *   1. upsertClient(domain, name)         → returns client_id
 *   2. createCrawl(client_id, url, opts)  → returns crawl_id, status='running'
 *   3. persistPage(crawl_id, page) × N    → called by engine per fetched URL
 *   4. finalizeCrawl(crawl_id, summary)   → updates status='done', sets is_latest=true,
 *                                            applies inlink counts, deletes old pages
 *   5. failCrawl(crawl_id, error_message) → updates status='error'
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment');
  }
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

// ─── Clients (extended) ───────────────────────────────────────────────────────

async function getClientById(clientId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Save or update WordPress credentials for a client.
 * Passing null for a field leaves the existing value unchanged.
 */
async function updateClientWpCredentials(clientId, { wpUrl, wpUsername, wpAppPassword }) {
  const sb      = getClient();
  const updates = {};
  if (wpUrl         != null) updates.wp_url          = wpUrl;
  if (wpUsername    != null) updates.wp_username     = wpUsername;
  if (wpAppPassword != null) updates.wp_app_password = wpAppPassword;

  if (Object.keys(updates).length === 0) return;

  const { error } = await sb.from('clients').update(updates).eq('id', clientId);
  if (error) throw error;
}

// ─── Domain helpers ──────────────────────────────────────────────────────────

function normalizeDomain(input) {
  // Accept full URL or bare domain. Return 'example.com' (no protocol, no www, no path).
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\/.*$/, '');
  return s;
}

// ─── Clients ─────────────────────────────────────────────────────────────────

async function upsertClient(targetUrl, friendlyName) {
  const sb = getClient();
  const domain = normalizeDomain(targetUrl);
  if (!domain) throw new Error('Could not derive domain from: ' + targetUrl);

  // Try to fetch existing
  const { data: existing, error: selErr } = await sb
    .from('clients')
    .select('id, name')
    .eq('domain', domain)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    // Optionally update name if user provided a new one
    if (friendlyName && friendlyName !== existing.name) {
      await sb.from('clients').update({ name: friendlyName }).eq('id', existing.id);
    }
    return existing.id;
  }

  // Insert new
  const { data: created, error: insErr } = await sb
    .from('clients')
    .insert({ domain, name: friendlyName || domain })
    .select('id')
    .single();
  if (insErr) throw insErr;
  return created.id;
}

// ─── Crawls ──────────────────────────────────────────────────────────────────

async function createCrawl(clientId, targetUrl, settings) {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawls')
    .insert({
      client_id:  clientId,
      target_url: targetUrl,
      status:     'running',
      settings:   settings || {},
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function persistPage(crawlId, page) {
  const sb = getClient();
  const { error } = await sb.from('crawl_pages').insert({
    crawl_id:           crawlId,
    url:                page.url,
    status_code:        page.status_code,
    redirect_to:        page.redirect_to,
    title:              page.title,
    title_length:       page.title_length,
    h1:                 page.h1,
    h2_count:           page.h2_count,
    h2_sample:          page.h2_sample,
    meta_description:   page.meta_description,
    meta_desc_present:  page.meta_desc_present,
    word_count:         page.word_count,
    inlinks:            page.inlinks || 0,
    indexability:       page.indexability,
    canonical_url:      page.canonical_url,
    canonical_match:    page.canonical_match,
    has_cta:            page.has_cta,
    headings:           page.headings,
    extracted_body:     page.extracted_body,
    extracted_text:     page.extracted_text,
  });
  if (error) throw error;
}

/**
 * After the crawl loop completes, apply the final inlink counts and
 * mark this crawl as the latest for its client. The latest-crawl trigger
 * in Postgres handles unflagging the previous one. We then delete the
 * previous crawl's page rows to keep storage bounded.
 */
async function finalizeCrawl(crawlId, summary) {
  const sb = getClient();

  // 1. Apply inlink counts in bulk. We batch UPDATEs because a single
  //    UPDATE WHERE url IN (...) can't set different values per row.
  //    For typical sites (<500 pages), this is one round-trip per page —
  //    not great but acceptable. If this becomes a bottleneck, we can
  //    switch to a temp table + JOIN UPDATE pattern.
  const inlinkEntries = Object.entries(summary.inlinks || {});
  if (inlinkEntries.length > 0) {
    // Fetch all pages for this crawl so we can match URL variants (trailing slash)
    const { data: pages, error: pagesErr } = await sb
      .from('crawl_pages')
      .select('id, url')
      .eq('crawl_id', crawlId);
    if (pagesErr) throw pagesErr;

    const inlinkMap = summary.inlinks;
    const updates = pages.map(p => {
      const a = p.url;
      const b = a.endsWith('/') ? a.slice(0, -1) : a + '/';
      const count = Math.max(inlinkMap[a] || 0, inlinkMap[b] || 0);
      return { id: p.id, inlinks: count };
    }).filter(u => u.inlinks > 0);

    // Batch update in chunks of 50
    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      const results = await Promise.allSettled(chunk.map(u =>
        sb.from('crawl_pages').update({ inlinks: u.inlinks }).eq('id', u.id)
      ));
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[finalizeCrawl] inlink update failed:', r.reason);
        }
      }
    }
  }

  // 2. Mark crawl as done + latest. The trigger in 001_initial_schema.sql
  //    will unflag the previous latest crawl for this client.
  const { data: crawl, error: crawlErr } = await sb
    .from('crawls')
    .update({
      status:         'done',
      is_latest:      true,
      page_count:     summary.total_pages,
      error_count:    summary.error_pages,
      sitemap_seeds:  summary.sitemap_seeds,
      avg_word_count: summary.avg_word_count,
      finished_at:    new Date().toISOString(),
    })
    .eq('id', crawlId)
    .select('client_id')
    .single();
  if (crawlErr) throw crawlErr;

  // 3. Delete page rows from any older crawl for this client (storage hygiene).
  //    We keep the crawl row itself for history, just delete its pages.
  const { data: oldCrawls, error: oldErr } = await sb
    .from('crawls')
    .select('id')
    .eq('client_id', crawl.client_id)
    .neq('id', crawlId);
  if (oldErr) throw oldErr;

  if (oldCrawls && oldCrawls.length > 0) {
    const oldIds = oldCrawls.map(c => c.id);
    await sb.from('crawl_pages').delete().in('crawl_id', oldIds);
  }
}

async function failCrawl(crawlId, errorMessage) {
  const sb = getClient();
  await sb
    .from('crawls')
    .update({
      status:        'error',
      error_message: errorMessage,
      finished_at:   new Date().toISOString(),
    })
    .eq('id', crawlId);
}

async function cancelCrawl(crawlId) {
  const sb = getClient();
  await sb
    .from('crawls')
    .update({
      status:      'cancelled',
      finished_at: new Date().toISOString(),
    })
    .eq('id', crawlId);
}

// ─── Read APIs (used by analyzer tabs in later phases) ───────────────────────

async function getCrawl(crawlId) {
  const sb = getClient();
  const { data, error } = await sb.from('crawls').select('*').eq('id', crawlId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getLatestCrawlForDomain(domain) {
  const sb = getClient();
  const norm = normalizeDomain(domain);
  const { data, error } = await sb
    .from('crawls')
    .select('*, clients!inner(domain, name)')
    .eq('clients.domain', norm)
    .eq('is_latest', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getCrawlPages(crawlId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawl_pages')
    .select('*')
    .eq('crawl_id', crawlId)
    .order('url');
  if (error) throw error;
  return data || [];
}

/**
 * Returns the most recent finished crawl across ALL clients, with client info joined.
 * Used by the Audit tab to auto-select what to show on load.
 */
async function getMostRecentFinishedCrawl() {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawls')
    .select('*, clients!inner(domain, name)')
    .eq('status', 'done')
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Lightweight page metadata for the Scout picker — no extracted_body/text.
 * Keeps the response small when the user is just selecting pages, not generating.
 */
async function getCrawlPagesMeta(crawlId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawl_pages')
    .select('url, status_code, redirect_to, title, h1, word_count, indexability')
    .eq('crawl_id', crawlId)
    .order('url');
  if (error) throw error;
  return data || [];
}

/**
 * Fetch full page data (including extracted_text) for a specific set of URLs
 * within a crawl. Used by the voice generation endpoint.
 */
async function getCrawlPagesByUrls(crawlId, urls) {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawl_pages')
    .select('id, url, h1, title, extracted_text, word_count')
    .eq('crawl_id', crawlId)
    .in('url', urls);
  if (error) throw error;
  return data || [];
}

// ─── Brand voices ─────────────────────────────────────────────────────────────

/**
 * Insert or update the brand voice profile for a client. One profile per client —
 * re-running voice analysis overwrites the previous one.
 */
async function upsertBrandVoice(clientId, crawlId, sourceUrls, profile) {
  const sb = getClient();
  const { error } = await sb
    .from('brand_voices')
    .upsert(
      {
        client_id:    clientId,
        crawl_id:     crawlId,
        source_urls:  sourceUrls,
        profile:      profile,
        human_edited: false,
        generated_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      },
      { onConflict: 'client_id' }
    );
  if (error) throw error;
}

/**
 * Update an existing brand voice profile (after human editing in the UI).
 * Sets human_edited = true and bumps updated_at.
 */
async function updateBrandVoiceProfile(clientId, profile) {
  const sb = getClient();
  const { error } = await sb
    .from('brand_voices')
    .update({
      profile:      profile,
      human_edited: true,
      updated_at:   new Date().toISOString(),
    })
    .eq('client_id', clientId);
  if (error) throw error;
}

/**
 * Get the brand voice profile for a client (by client_id).
 */
async function getBrandVoice(clientId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('brand_voices')
    .select('*, clients!inner(domain, name)')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Get the brand voice profile for a client by domain.
 */
async function getBrandVoiceByDomain(domain) {
  const sb = getClient();
  const norm = normalizeDomain(domain);
  const { data, error } = await sb
    .from('brand_voices')
    .select('*, clients!inner(domain, name)')
    .eq('clients.domain', norm)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Get the brand voice profile for the client that owns the given crawl.
 * Returns null if no profile exists yet.
 */
async function getBrandVoiceForCrawl(crawlId) {
  const sb = getClient();
  // Get the client_id for this crawl first
  const { data: crawl, error: crawlErr } = await sb
    .from('crawls')
    .select('client_id')
    .eq('id', crawlId)
    .maybeSingle();
  if (crawlErr) throw crawlErr;
  if (!crawl) return null;

  return getBrandVoice(crawl.client_id);
}

/**
 * Returns a list of all finished crawls, newest first, with client info.
 * Used to populate any "switch to a different crawl" dropdown.
 */
async function listFinishedCrawls(limit) {
  const sb = getClient();
  const { data, error } = await sb
    .from('crawls')
    .select('id, target_url, status, page_count, error_count, avg_word_count, finished_at, is_latest, clients!inner(domain, name)')
    .eq('status', 'done')
    .order('finished_at', { ascending: false })
    .limit(limit || 50);
  if (error) throw error;
  return data || [];
}

// ─── Client profile management ────────────────────────────────────────────────

/**
 * Return all clients ordered by name, each with their latest finished crawl attached.
 * latest_crawl is null if no finished crawl exists yet.
 */
async function listClients() {
  const sb = getClient();

  const [clientsResult, crawlsResult] = await Promise.all([
    sb.from('clients').select('*').order('name'),
    sb.from('crawls')
      .select('id, client_id, page_count, finished_at')
      .eq('is_latest', true)
      .eq('status', 'done'),
  ]);

  if (clientsResult.error) throw clientsResult.error;
  if (crawlsResult.error) throw crawlsResult.error;

  const crawlMap = {};
  for (const c of (crawlsResult.data || [])) {
    crawlMap[c.client_id] = { id: c.id, page_count: c.page_count, finished_at: c.finished_at };
  }

  return (clientsResult.data || []).map(client => ({
    ...client,
    latest_crawl: crawlMap[client.id] || null,
  }));
}

/**
 * Update editable profile fields for a client.
 * Only keys present in the allowed list are applied; undefined values are skipped.
 *
 * @param {string} clientId
 * @param {Object} fields - any subset of: name, city, state, practice_type, built_by_mmw,
 *                          tagline, wp_url, wp_username, wp_app_password
 */
async function updateClientProfile(clientId, fields) {
  const sb = getClient();
  const ALLOWED_KEYS = ['name', 'city', 'state', 'practice_type', 'built_by_mmw', 'tagline', 'wp_url', 'wp_username', 'wp_app_password'];
  const updates = {};
  for (const key of ALLOWED_KEYS) {
    if (fields[key] !== undefined) updates[key] = fields[key];
  }
  if (Object.keys(updates).length === 0) return;
  const { error } = await sb.from('clients').update(updates).eq('id', clientId);
  if (error) throw error;
}

/**
 * Permanently delete a client and all related data (cascades via FK).
 *
 * @param {string} clientId
 */
async function deleteClient(clientId) {
  const sb = getClient();
  const { error } = await sb.from('clients').delete().eq('id', clientId);
  if (error) throw error;
}

// ─── Optimization history ─────────────────────────────────────────────────────

/**
 * Bulk-insert SEO push records into seo_optimizations.
 *
 * @param {string} clientId
 * @param {string} crawlId
 * @param {Array}  items - [{ url, before_title, before_meta, after_title, after_meta }]
 */
async function saveSeoOptimizations(clientId, crawlId, items) {
  if (!items || items.length === 0) return;
  const sb = getClient();
  const rows = items.map(it => ({
    client_id:    clientId,
    crawl_id:     crawlId || null,
    url:          it.url,
    before_title: it.before_title || null,
    before_meta:  it.before_meta  || null,
    after_title:  it.after_title  || null,
    after_meta:   it.after_meta   || null,
  }));
  const { error } = await sb.from('seo_optimizations').insert(rows);
  if (error) throw error;
}

/**
 * Bulk-insert schema push records into schema_optimizations.
 *
 * @param {string} clientId
 * @param {string} crawlId
 * @param {Array}  items - [{ url, post_id, schema_type, schema }]
 */
async function saveSchemaOptimizations(clientId, crawlId, items) {
  if (!items || items.length === 0) return;
  const sb = getClient();
  const rows = items.map(it => ({
    client_id:   clientId,
    crawl_id:    crawlId || null,
    url:         it.url,
    post_id:     it.post_id     || null,
    schema_type: it.schema_type,
    schema:      it.schema      || {},
  }));
  const { error } = await sb.from('schema_optimizations').insert(rows);
  if (error) throw error;
}

/**
 * Retrieve the full SEO and schema optimization history for a client.
 *
 * @param {string} clientId
 * @returns {{ seo: Array, schema: Array }}
 */
async function getOptimizationHistory(clientId) {
  const sb = getClient();

  const [seoResult, schemaResult] = await Promise.all([
    sb.from('seo_optimizations')
      .select('*')
      .eq('client_id', clientId)
      .order('pushed_at', { ascending: false }),
    sb.from('schema_optimizations')
      .select('*')
      .eq('client_id', clientId)
      .order('pushed_at', { ascending: false }),
  ]);

  if (seoResult.error)    throw seoResult.error;
  if (schemaResult.error) throw schemaResult.error;

  return {
    seo:    seoResult.data    || [],
    schema: schemaResult.data || [],
  };
}

module.exports = {
  getClient,
  normalizeDomain,
  getClientById,
  updateClientWpCredentials,
  upsertClient,
  createCrawl,
  persistPage,
  finalizeCrawl,
  failCrawl,
  cancelCrawl,
  getCrawl,
  getLatestCrawlForDomain,
  getCrawlPages,
  getCrawlPagesMeta,
  getCrawlPagesByUrls,
  getMostRecentFinishedCrawl,
  listFinishedCrawls,
  upsertBrandVoice,
  updateBrandVoiceProfile,
  getBrandVoice,
  getBrandVoiceByDomain,
  getBrandVoiceForCrawl,
  listClients,
  updateClientProfile,
  deleteClient,
  saveSeoOptimizations,
  saveSchemaOptimizations,
  getOptimizationHistory,
};
