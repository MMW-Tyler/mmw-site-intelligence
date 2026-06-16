/**
 * MMW Site Intelligence — Server
 *
 * Express app exposing:
 *   GET  /                       → serves the SPA (public/index.html)
 *   POST /api/crawl              → starts a crawl, returns { crawlId }
 *   GET  /api/crawl/:id/progress → SSE stream of live crawl events
 *   GET  /api/crawl/:id          → returns crawl status + summary
 *   POST /api/crawl/:id/cancel   → flips cancel flag on an active crawl
 *   GET  /api/crawl/:id/pages    → returns all pages for a crawl (used by analyzer tabs)
 *
 * Future endpoints (later phases):
 *   GET  /api/brand-voice/:client_id  → returns the latest brand voice profile
 *   POST /api/brand-voice             → generate a new profile from approved URLs
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const JSZip  = require('jszip');

const engine        = require('./crawl/engine');
const store         = require('./crawl/store');
const jobs          = require('./jobs');
const audit         = require('./analyzers/audit');
const scout         = require('./analyzers/scout');
const voice         = require('./analyzers/voice');
const schemaAnalyzer = require('./analyzers/schema');
const brandVoiceApi = require('./api/brand-voice');
const wp              = require('./lib/wp');
const schemaValidator = require('./lib/schema-validator');

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT: SEO_SYSTEM,       buildSeoUserMessage }    = require('./prompts/seo-optimize');
const { SYSTEM_PROMPT: SCHEMA_SYSTEM,    buildSchemaUserMessage }  = require('./prompts/schema-gap');
const { SYSTEM_PROMPT: REPORT_SYSTEM,    buildReportUserMessage }  = require('./prompts/report');
const sitemapAnalyzer = require('./analyzers/sitemap');
const { SYSTEM_PROMPT: SITEMAP_SYSTEM, buildSitemapAnalysisMessage } = require('./prompts/sitemap-analysis');
const migrate          = require('./analyzers/migrate');
const wpMigrate        = require('./lib/wp-migrate');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Internal API auth — set MMW_INTERNAL_TOKEN in env to enable
const apiAuth = (req, res, next) => {
  const secret = process.env.MMW_INTERNAL_TOKEN;
  if (!secret) return next(); // disabled when env var not set
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${secret}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
};
app.use('/api', apiAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── Start crawl ─────────────────────────────────────────────────────────────

app.post('/api/crawl', async (req, res) => {
  const { targetURL, clientName, maxPages, delay, concurrency, htmlSitemap, noSitemap } = req.body || {};

  if (!targetURL || typeof targetURL !== 'string' || !/^https?:\/\//i.test(targetURL)) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  let clientId, crawlId;
  try {
    clientId = await store.upsertClient(targetURL, clientName);
    crawlId  = await store.createCrawl(clientId, targetURL, {
      maxPages:    parseInt(maxPages,    10) || 500,
      delayMs:     parseInt(delay,       10) || 300,
      concurrency: parseInt(concurrency, 10) || 2,
      htmlSitemap: htmlSitemap || '',
      noSitemap:   !!noSitemap,
    });
  } catch (err) {
    console.error('[crawl] DB setup failed:', err);
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }

  const job = jobs.create(crawlId);

  // Kick off the crawl asynchronously. Errors here go to the SSE stream
  // and to the crawls table — they don't reject this HTTP response.
  runCrawl(crawlId, job, {
    targetURL,
    maxPages:    parseInt(maxPages,    10) || 500,
    delayMs:     parseInt(delay,       10) || 300,
    concurrency: parseInt(concurrency, 10) || 2,
    htmlSitemap: htmlSitemap || '',
    noSitemap:   !!noSitemap,
    _cancelled:  () => job._cancelled(),
  }).catch(err => {
    console.error('[crawl] runCrawl threw:', err);
  });

  res.json({ crawlId, clientId });
});

async function runCrawl(crawlId, job, opts) {
  try {
    const summary = await engine.crawl(
      opts,
      (type, data) => { if (!job.cancelled) job.emit(type, data); },
      async (page) => { try { await store.persistPage(crawlId, page); } catch (e) { console.error('[crawl] persistPage failed:', e.message); } }
    );

    if (job.cancelled) {
      await store.cancelCrawl(crawlId);
      job.emit('done', { cancelled: true, ...summary });
    } else {
      await store.finalizeCrawl(crawlId, summary);
      job.emit('done', summary);
    }
  } catch (err) {
    console.error('[crawl] engine error:', err);
    try { await store.failCrawl(crawlId, err.message); } catch (_) {}
    job.fail(err);
    return;
  }
  job.finish();
}

// ─── SSE progress stream ─────────────────────────────────────────────────────

app.get('/api/crawl/:id/progress', (req, res) => {
  const crawlId = req.params.id;
  const job = jobs.get(crawlId);
  if (!job) {
    // Job is no longer in memory — could be already finished. Tell the client to fall back.
    return res.status(404).json({ error: 'Job not active. Fetch /api/crawl/:id for final status.' });
  }
  job.subscribe(res);
  req.on('close', () => job.unsubscribe(res));
});

// ─── Crawl status ────────────────────────────────────────────────────────────

app.get('/api/crawl/:id', async (req, res) => {
  try {
    const crawl = await store.getCrawl(req.params.id);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    res.json(crawl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cancel crawl ────────────────────────────────────────────────────────────

app.post('/api/crawl/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) job.cancel();
  res.json({ ok: true });
});

// ─── Pages for a crawl ───────────────────────────────────────────────────────

app.get('/api/crawl/:id/pages', async (req, res) => {
  try {
    const pages = await store.getCrawlPages(req.params.id);
    res.json({ crawlId: req.params.id, pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lookup latest crawl by domain ───────────────────────────────────────────

app.get('/api/client/:domain/latest-crawl', async (req, res) => {
  try {
    const crawl = await store.getLatestCrawlForDomain(req.params.domain);
    if (!crawl) return res.status(404).json({ error: 'No crawl found for domain' });
    res.json(crawl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Client management ────────────────────────────────────────────────────────

// GET /api/clients — list all clients with their latest crawl attached
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await store.listClients();
    res.json({ clients });
  } catch (err) {
    console.error('[clients list] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId — get a single client by ID
app.get('/api/clients/:clientId', async (req, res) => {
  try {
    const client = await store.getClientById(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    console.error('[clients get] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:clientId — update client profile fields
app.patch('/api/clients/:clientId', async (req, res) => {
  try {
    await store.updateClientProfile(req.params.clientId, req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients patch] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:clientId — permanently delete client and all data
app.delete('/api/clients/:clientId', async (req, res) => {
  const { confirm } = req.body || {};
  if (!confirm) return res.status(400).json({ error: 'Must send { confirm: true } to delete a client' });
  try {
    await store.deleteClient(req.params.clientId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[clients delete] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:clientId/ping — test WP credentials without needing a crawl
app.get('/api/clients/:clientId/ping', async (req, res) => {
  try {
    const client = await store.getClientById(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.json({ ok: false, error: 'WordPress credentials not configured' });
    }
    const result = await wp.ping(client.wp_url, client.wp_username, client.wp_app_password);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/clients/:clientId/history — optimization history for a client
app.get('/api/clients/:clientId/history', async (req, res) => {
  try {
    const history = await store.getOptimizationHistory(req.params.clientId);
    res.json(history);
  } catch (err) {
    console.error('[clients history] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:clientId/report — SSE: generate optimization report with Claude
app.post('/api/clients/:clientId/report', async (req, res) => {
  const { crawlId: filterCrawlId } = req.body || {};

  let client;
  try {
    client = await store.getClientById(req.params.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const emit = sseEmitter(res);

  try {
    emit('log', { message: 'Building report context...' });

    // Get optimization history, optionally filtered to a specific crawl
    let { seo: seoHistory, schema: schemaHistory } = await store.getOptimizationHistory(client.id);
    if (filterCrawlId) {
      seoHistory    = seoHistory.filter(h => h.crawl_id === filterCrawlId);
      schemaHistory = schemaHistory.filter(h => h.crawl_id === filterCrawlId);
    }

    // Get crawl summary
    let crawlSummary = null;
    if (filterCrawlId) {
      crawlSummary = await store.getCrawl(filterCrawlId).catch(() => null);
    } else {
      crawlSummary = await store.getMostRecentFinishedCrawl().catch(() => null);
    }

    // Build a lightweight audit summary from available data
    const auditSummary = {
      total:        (crawlSummary && crawlSummary.page_count) || 0,
      thin:         0,
      titleMissing: 0,
      titleShort:   0,
      titleLong:    0,
      metaMissing:  0,
      metaShort:    0,
    };

    emit('log', { message: 'Generating report with Claude...' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let fullText = '';

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const stream = anthropic.messages.stream({
      model:      'claude-opus-4-7',
      max_tokens: 4096,
      thinking:   { type: 'adaptive' },
      system: [{ type: 'text', text: REPORT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role:    'user',
        content: buildReportUserMessage(client, crawlSummary, auditSummary, seoHistory, schemaHistory),
      }],
    }, { signal: ac.signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
      }
    }

    emit('done', { report: fullText });
  } catch (err) {
    console.error('[report] error:', err);
    emit('error', { message: err.message });
  }
  res.end();
});

// ─── List of finished crawls (for "switch crawl" dropdown) ───────────────────

app.get('/api/crawls', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const list = await store.listFinishedCrawls(limit);
    res.json({ crawls: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Audit endpoints ─────────────────────────────────────────────────────────
// `:id` is either a crawl UUID or the literal string 'latest' to auto-pick
// the most recent finished crawl across all clients.

async function resolveCrawl(idOrLatest) {
  if (idOrLatest === 'latest') {
    return await store.getMostRecentFinishedCrawl();
  }
  return await store.getCrawl(idOrLatest);
}

app.get('/api/audit/:id.csv', async (req, res) => {
  try {
    const crawl = await resolveCrawl(req.params.id);
    if (!crawl) return res.status(404).send('Crawl not found');
    const pages = await store.getCrawlPages(crawl.id);
    const result = audit.analyze(pages);
    const csv = audit.buildCSV(result.pages);

    const domain = (crawl.clients && crawl.clients.domain) || 'site';
    const date = (crawl.finished_at || new Date().toISOString()).split('T')[0];
    const filename = `audit-${domain}-${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[audit csv] error:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/api/audit/:id', async (req, res) => {
  try {
    const crawl = await resolveCrawl(req.params.id);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const pages = await store.getCrawlPages(crawl.id);
    const result = audit.analyze(pages);
    res.json({ crawl, ...result });
  } catch (err) {
    console.error('[audit] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Scout endpoints ─────────────────────────────────────────────────────────
// Lightweight page list for the picker UI; generate returns a zip of .md files.

app.get('/api/scout/:crawlId/pages', async (req, res) => {
  try {
    const crawl = await resolveCrawl(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const pages = await store.getCrawlPagesMeta(crawl.id);
    const withFlags = pages.map(p => ({ ...p, default_checked: scout.shouldDefaultCheck(p) }));
    res.json({ crawlId: crawl.id, crawl, pages: withFlags });
  } catch (err) {
    console.error('[scout pages] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scout/:crawlId/generate', async (req, res) => {
  try {
    const { urls, siteName, batchSize: batchSizeInput } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'urls array is required and must be non-empty' });
    }
    if (urls.length > 500) return res.status(400).json({ error: 'Maximum 500 URLs per request' });
    const batchSize = Math.max(1, Math.min(500, parseInt(batchSizeInput, 10) || 100));

    const crawl = await resolveCrawl(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });

    const allPages = await store.getCrawlPages(crawl.id);
    const urlSet   = new Set(urls);
    const selected = allPages.filter(p => urlSet.has(p.url));

    if (selected.length === 0) {
      return res.status(400).json({ error: 'No matching pages found for the provided URLs' });
    }

    const domain = (crawl.clients && crawl.clients.domain) || 'site';
    const name   = (siteName || '').trim() || (crawl.clients && crawl.clients.name) || domain;
    const date   = (crawl.finished_at || new Date().toISOString()).split('T')[0];

    const batches = scout.buildBatches(selected, batchSize);
    const zip     = new JSZip();

    const crawlDate = (crawl.finished_at || new Date().toISOString()).split('T')[0];
    const batchMeta = batches.map((pages, i) => {
      const filename = `batch-${String(i + 1).padStart(3, '0')}.md`;
      zip.file(filename, scout.formatBatch(pages, {
        siteName:    name,
        batchNumber: i + 1,
        batchTotal:  batches.length,
        startIndex:  i * batchSize,
        totalPages:  selected.length,
        crawlDate,
      }));
      return { filename, count: pages.length, startIndex: i * batchSize };
    });

    zip.file('manifest.md', scout.formatManifest(batchMeta, { siteName: name }));

    const zipBuffer  = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipFilename = `scout-${domain}-${date}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('[scout generate] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Voice endpoints ──────────────────────────────────────────────────────────
// Page picker uses the same lightweight metadata as Scout.
// Profile fetch returns any existing brand voice for the crawl's client.
// Generate streams SSE while Claude works, then saves the result to brand_voices.

app.get('/api/voice/:crawlId/pages', async (req, res) => {
  try {
    const crawl = await resolveCrawl(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const pages    = await store.getCrawlPagesMeta(crawl.id);
    const withFlags = pages.map(p => ({ ...p, default_checked: voice.shouldDefaultCheck(p) }));
    res.json({ crawlId: crawl.id, crawl, pages: withFlags });
  } catch (err) {
    console.error('[voice pages] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/voice/:crawlId/profile', async (req, res) => {
  try {
    const crawl = await resolveCrawl(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const bv = await store.getBrandVoiceForCrawl(crawl.id);
    if (!bv) return res.status(404).json({ error: 'No brand voice profile yet' });
    res.json(bv);
  } catch (err) {
    console.error('[voice profile] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generation streams SSE back to the browser while Claude works.
// Response body is newline-delimited "data: <json>\n\n" events.
// Event types: log { message }, done { profile, clientId }, error { message }
app.post('/api/voice/:crawlId/generate', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required and must be non-empty' });
  }
  if (urls.length > 500) return res.status(400).json({ error: 'Maximum 500 URLs per request' });

  let crawl;
  try {
    crawl = await resolveCrawl(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Switch to SSE so the browser sees progress events and the connection
  // stays open while Claude works (avoids proxy timeout issues).
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const emit = (type, data) => {
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (_) {}
  };

  try {
    emit('log', { message: 'Fetching selected pages from database...' });
    const pages = await store.getCrawlPagesByUrls(crawl.id, urls);

    if (pages.length === 0) {
      emit('error', { message: 'No matching pages found in this crawl for the provided URLs.' });
      return res.end();
    }

    const profile = await voice.analyzeVoice(pages, emit, { signal: ac.signal });

    emit('log', { message: 'Saving profile...' });
    await store.upsertBrandVoice(crawl.client_id, crawl.id, urls, profile);

    emit('done', { profile, clientId: crawl.client_id });
  } catch (err) {
    console.error('[voice generate] error:', err);
    emit('error', { message: err.message });
  }

  res.end();
});

app.patch('/api/voice/:clientId', async (req, res) => {
  const { profile } = req.body || {};
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ error: 'profile object is required' });
  }
  try {
    await store.updateBrandVoiceProfile(req.params.clientId, profile);
    res.json({ ok: true });
  } catch (err) {
    console.error('[voice patch] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/voice/:clientId/profile/export — download brand voice as Markdown file
app.get('/api/voice/:clientId/profile/export', async (req, res) => {
  try {
    const bv = await store.getBrandVoice(req.params.clientId);
    if (!bv) return res.status(404).json({ error: 'No brand voice profile found for this client' });

    const domain = (bv.clients && bv.clients.domain) || req.params.clientId;
    const p      = bv.profile || {};

    const lines = [
      `# Brand Voice Profile`,
      `**Client:** ${(bv.clients && bv.clients.name) || domain}`,
      `**Domain:** ${domain}`,
      `**Generated:** ${bv.generated_at ? new Date(bv.generated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown'}`,
      `**Human edited:** ${bv.human_edited ? 'Yes' : 'No'}`,
      '',
      '---',
      '',
    ];

    if (p.summary_paragraph) {
      lines.push('## Summary', '', p.summary_paragraph, '');
    }

    if (p.tone_descriptors && p.tone_descriptors.length > 0) {
      lines.push('## Tone Descriptors', '');
      for (const t of p.tone_descriptors) lines.push(`- ${t}`);
      lines.push('');
    }

    if (p.vocabulary) {
      if (p.vocabulary.preferred && p.vocabulary.preferred.length > 0) {
        lines.push('## Preferred Vocabulary', '');
        for (const w of p.vocabulary.preferred) lines.push(`- ${w}`);
        lines.push('');
      }
      if (p.vocabulary.avoided && p.vocabulary.avoided.length > 0) {
        lines.push('## Vocabulary to Avoid', '');
        for (const w of p.vocabulary.avoided) lines.push(`- ${w}`);
        lines.push('');
      }
    }

    if (p.sentence_structure) {
      lines.push('## Sentence Structure', '', p.sentence_structure, '');
    }

    if (p.do_examples && p.do_examples.length > 0) {
      lines.push('## Do Examples', '');
      for (const ex of p.do_examples) lines.push(`- ${ex}`);
      lines.push('');
    }

    if (p.dont_examples && p.dont_examples.length > 0) {
      lines.push('## Do Not Examples', '');
      for (const ex of p.dont_examples) lines.push(`- ${ex}`);
      lines.push('');
    }

    // Include any remaining keys not explicitly handled above
    const handled = new Set(['summary_paragraph', 'tone_descriptors', 'vocabulary', 'sentence_structure', 'do_examples', 'dont_examples']);
    for (const [key, val] of Object.entries(p)) {
      if (handled.has(key) || val == null) continue;
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`## ${label}`, '');
      if (Array.isArray(val)) {
        for (const item of val) lines.push(`- ${typeof item === 'object' ? JSON.stringify(item) : item}`);
      } else if (typeof val === 'object') {
        lines.push('```json', JSON.stringify(val, null, 2), '```');
      } else {
        lines.push(String(val));
      }
      lines.push('');
    }

    const markdown = lines.join('\n');
    const filename = `brand-voice-${domain}.md`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(markdown);
  } catch (err) {
    console.error('[voice export] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Optimize tab ────────────────────────────────────────────────────────────
// WordPress connection + SEO field push + Schema scan/generate/push.
// All write operations go through the MMW Plugin installed on the client WP site.

// Helper: resolve crawl then get the full client record (including WP credentials)
async function resolveCrawlAndClient(crawlIdOrLatest) {
  const crawl = await resolveCrawl(crawlIdOrLatest);
  if (!crawl) return { crawl: null, client: null };
  const client = await store.getClientById(crawl.client_id);
  return { crawl, client };
}

// Helper: stream SSE emitter
function sseEmitter(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  return (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch (_) {} };
}

// GET /api/optimize/:crawlId/connection — return WP credentials (password redacted) for UI
app.get('/api/optimize/:crawlId/connection', async (req, res) => {
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const hasCredentials = !!(client && client.wp_url && client.wp_username && client.wp_app_password);
    res.json({
      clientId:       client ? client.id : null,
      clientName:     client ? client.name : null,
      wp_url:         (client && client.wp_url)      || '',
      wp_username:    (client && client.wp_username)  || '',
      has_password:   !!(client && client.wp_app_password),
      hasCredentials,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/optimize/:crawlId/connection — save WP credentials
app.post('/api/optimize/:crawlId/connection', async (req, res) => {
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    const { wp_url, wp_username, wp_app_password } = req.body || {};
    await store.updateClientWpCredentials(client.id, {
      wpUrl:         wp_url         || null,
      wpUsername:    wp_username    || null,
      wpAppPassword: wp_app_password || null,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/optimize/:crawlId/ping — test WP connection + plugin
app.post('/api/optimize/:crawlId/ping', async (req, res) => {
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured' });
    }
    const result = await wp.ping(client.wp_url, client.wp_username, client.wp_app_password);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/optimize/plugin/download — serve the plugin ZIP
app.get('/api/optimize/plugin/download', async (req, res) => {
  try {
    const fs   = require('fs');
    const path = require('path');
    const phpSrc = fs.readFileSync(
      path.join(__dirname, 'wordpress', 'mmw-plugin', 'mmw-plugin.php'), 'utf8'
    );
    const zip = new JSZip();
    zip.folder('mmw-plugin').file('mmw-plugin.php', phpSrc);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="mmw-plugin.zip"');
    res.send(buf);
  } catch (err) {
    console.error('[plugin download] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SEO optimization ─────────────────────────────────────────────────────────
// POST /api/optimize/:crawlId/seo/generate — SSE: Claude drafts title + meta for selected pages
app.post('/api/optimize/:crawlId/seo/generate', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  if (urls.length > 500) return res.status(400).json({ error: 'Maximum 500 URLs per request' });

  let crawl, client;
  try {
    ({ crawl, client } = await resolveCrawlAndClient(req.params.crawlId));
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const emit = sseEmitter(res);

  try {
    emit('log', { message: 'Fetching page data...' });

    const allPages = await store.getCrawlPages(crawl.id);
    const urlSet   = new Set(urls);
    const selected = allPages.filter(p => urlSet.has(p.url));

    if (selected.length === 0) {
      emit('error', { message: 'No matching pages found for the provided URLs.' });
      return res.end();
    }

    // Fetch brand voice for this client if available (enriches the prompt)
    const bv          = await store.getBrandVoiceForCrawl(crawl.id).catch(() => null);
    const voiceSummary = bv && bv.profile && bv.profile.summary_paragraph || null;

    const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const BATCH_SIZE = 10;
    const proposals  = [];

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      emit('log', { message: `Optimizing pages ${i + 1}–${Math.min(i + BATCH_SIZE, selected.length)} of ${selected.length}...` });

      const userContent = buildSeoUserMessage(batch, voiceSummary, client);
      let fullText = '';

      const stream = anthropic.messages.stream({
        model:      'claude-opus-4-7',
        max_tokens: 4096,
        thinking:   { type: 'adaptive' },
        system: [{ type: 'text', text: SEO_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
      }, { signal: ac.signal });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text;
        }
      }

      const cleaned = fullText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let batchResults;
      try { batchResults = JSON.parse(cleaned); } catch (_) {
        emit('log', { message: `Warning: could not parse batch ${Math.floor(i / BATCH_SIZE) + 1} response — skipping.` });
        continue;
      }
      if (Array.isArray(batchResults)) proposals.push(...batchResults);
    }

    emit('done', { proposals });
  } catch (err) {
    console.error('[seo generate] error:', err);
    emit('error', { message: err.message });
  }
  res.end();
});

// POST /api/optimize/:crawlId/seo/push — push SEO fields to WordPress
app.post('/api/optimize/:crawlId/seo/push', async (req, res) => {
  const { items } = req.body || {}; // [{ url, postId, title, meta }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }
  if (items.length > 200) return res.status(400).json({ error: 'Maximum 200 items per request' });
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured' });
    }

    // Resolve postIds for any items missing them (SEO generate doesn't do WP lookup)
    const needsLookup = items.filter(it => !it.postId && it.url);
    if (needsLookup.length > 0) {
      const lookupResults = await wp.lookupUrls(
        client.wp_url, client.wp_username, client.wp_app_password,
        needsLookup.map(it => it.url)
      ).catch(() => []);
      const pidMap = {};
      for (const r of lookupResults) { if (r.found) pidMap[r.url] = r.post_id; }
      for (const item of items) { if (!item.postId) item.postId = pidMap[item.url] || null; }
    }

    const results = [];
    for (const item of items) {
      if (!item.postId) {
        results.push({ url: item.url, ok: false, error: 'Could not resolve URL to a WordPress post ID. Ensure the MMW plugin is installed.' });
        continue;
      }
      try {
        const r = await wp.writeSeoMeta(
          client.wp_url, client.wp_username, client.wp_app_password,
          { postId: item.postId, title: item.title || null, description: item.meta || null }
        );
        results.push({ url: item.url, ok: true, updated: r.updated });
      } catch (err) {
        results.push({ url: item.url, ok: false, error: err.message });
      }
    }
    res.json({ results });

    // Save push history (fire-and-forget — don't delay or fail the response)
    setImmediate(async () => {
      try {
        const successItems = results.filter(r => r.ok);
        if (successItems.length === 0) return;
        const allPages = await store.getCrawlPages(crawl.id).catch(() => []);
        const pageMap  = {};
        for (const p of allPages) pageMap[p.url] = p;
        const historyItems = successItems.map(r => {
          const orig = items.find(it => it.url === r.url) || {};
          const pg   = pageMap[r.url] || {};
          return {
            url:          r.url,
            before_title: pg.title            || null,
            before_meta:  pg.meta_description || null,
            after_title:  orig.title          || null,
            after_meta:   orig.meta           || null,
          };
        });
        await store.saveSeoOptimizations(client.id, crawl.id, historyItems);
      } catch (e) {
        console.error('[seo push] history save failed:', e);
      }
    });
  } catch (err) {
    console.error('[seo push] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SEO export routes ───────────────────────────────────────────────────────

// POST /api/optimize/:crawlId/seo/export — internal HTML review doc (MMW-branded)
app.post('/api/optimize/:crawlId/seo/export', async (req, res) => {
  try {
    const { proposals, pages } = req.body || {};
    if (!Array.isArray(proposals) || proposals.length === 0) {
      return res.status(400).json({ error: 'proposals array is required' });
    }

    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    const domain   = (crawl && crawl.clients && crawl.clients.domain) || req.params.crawlId;
    const siteName = (client && client.name) || domain;
    const date     = new Date().toISOString().split('T')[0];

    const pageMap = {};
    if (Array.isArray(pages)) {
      for (const p of pages) pageMap[p.url] = p;
    }

    const rows = proposals.map(p => {
      const orig  = pageMap[p.url] || {};
      const curTitle = orig.title            || '(none)';
      const curMeta  = orig.meta_description || '(none)';
      const newTitle = p.proposed_title || '(no change)';
      const newMeta  = p.proposed_meta  || '(no change)';
      const reason   = p.reason || '';
      return `
        <tr>
          <td class="url">${escHtml(p.url)}</td>
          <td>
            <div class="label">Before</div><div class="before">${escHtml(curTitle)}</div>
            <div class="label mt">After</div><div class="after">${escHtml(newTitle)}</div>
          </td>
          <td>
            <div class="label">Before</div><div class="before">${escHtml(curMeta)}</div>
            <div class="label mt">After</div><div class="after">${escHtml(newMeta)}</div>
          </td>
          <td class="reason">${escHtml(reason)}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO Proposals — ${escHtml(siteName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #1a1a1a; background: #f5f5f5; }
  .header { background: #0d1f3c; color: #fff; padding: 20px 32px; display: flex; align-items: center; gap: 16px; }
  .header .logo { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; color: #7ec8e3; }
  .header .subtitle { font-size: 13px; color: #aac4d4; margin-top: 2px; }
  .header .client { margin-left: auto; text-align: right; font-size: 12px; color: #aac4d4; }
  .header .client strong { display: block; font-size: 15px; color: #fff; }
  .meta-bar { background: #fff; border-bottom: 1px solid #e0e0e0; padding: 10px 32px; font-size: 12px; color: #555; display: flex; gap: 24px; }
  .container { padding: 24px 32px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  thead { background: #0d1f3c; color: #fff; }
  thead th { padding: 12px 14px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  tbody tr { border-bottom: 1px solid #f0f0f0; }
  tbody tr:last-child { border-bottom: none; }
  td { padding: 12px 14px; vertical-align: top; }
  td.url { font-size: 11px; color: #555; word-break: break-all; max-width: 220px; }
  td.reason { font-size: 12px; color: #666; max-width: 180px; }
  .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #999; margin-bottom: 2px; }
  .label.mt { margin-top: 8px; }
  .before { color: #888; font-size: 12px; }
  .after  { color: #0d6e3f; font-size: 12px; font-weight: 500; }
  .footer { text-align: center; padding: 20px; font-size: 11px; color: #aaa; }
  @media print { body { background: #fff; } .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">MMW</div>
    <div class="subtitle">Medical Marketing Whiz — Internal Review</div>
  </div>
  <div class="client">
    <strong>${escHtml(siteName)}</strong>
    ${escHtml(domain)}
  </div>
</div>
<div class="meta-bar">
  <span>Generated: ${date}</span>
  <span>Proposals: ${proposals.length}</span>
  <span>Document type: Internal Review</span>
</div>
<div class="container">
  <table>
    <thead>
      <tr>
        <th>URL</th>
        <th>Title</th>
        <th>Meta Description</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>
<div class="footer">MMW Site Intelligence &mdash; Confidential &mdash; Internal Use Only</div>
</body>
</html>`;

    const filename = `seo-proposals-${domain}-${date}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (err) {
    console.error('[seo export] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/optimize/:crawlId/seo/approval — client-facing printable HTML
app.post('/api/optimize/:crawlId/seo/approval', async (req, res) => {
  try {
    const { proposals, pages, clientName: bodyClientName } = req.body || {};
    if (!Array.isArray(proposals) || proposals.length === 0) {
      return res.status(400).json({ error: 'proposals array is required' });
    }

    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    const domain   = (crawl && crawl.clients && crawl.clients.domain) || req.params.crawlId;
    const siteName = bodyClientName || (client && client.name) || domain;
    const date     = new Date().toISOString().split('T')[0];

    const pageMap = {};
    if (Array.isArray(pages)) {
      for (const p of pages) pageMap[p.url] = p;
    }

    const rows = proposals.map(p => {
      const orig     = pageMap[p.url] || {};
      const curTitle = orig.title            || '(none)';
      const curMeta  = orig.meta_description || '(none)';
      const newTitle = p.proposed_title || '(no change)';
      const newMeta  = p.proposed_meta  || '(no change)';
      return `
        <tr>
          <td class="url">${escHtml(p.url)}</td>
          <td>
            <div class="label">Current</div><div class="before">${escHtml(curTitle)}</div>
            <div class="label mt">Proposed</div><div class="after">${escHtml(newTitle)}</div>
          </td>
          <td>
            <div class="label">Current</div><div class="before">${escHtml(curMeta)}</div>
            <div class="label mt">Proposed</div><div class="after">${escHtml(newMeta)}</div>
          </td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO Optimization Proposals — ${escHtml(siteName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; }
  .header { padding: 32px 40px 20px; border-bottom: 2px solid #0d1f3c; }
  .header h1 { font-size: 22px; font-weight: 700; color: #0d1f3c; }
  .header .practice { font-size: 15px; color: #444; margin-top: 4px; }
  .header .date { font-size: 12px; color: #888; margin-top: 6px; }
  .intro { padding: 20px 40px; font-size: 13px; color: #444; line-height: 1.6; border-bottom: 1px solid #eee; }
  .container { padding: 24px 40px; }
  table { width: 100%; border-collapse: collapse; }
  thead { background: #0d1f3c; color: #fff; }
  thead th { padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  tbody tr { border-bottom: 1px solid #eee; }
  tbody tr:last-child { border-bottom: none; }
  td { padding: 12px 14px; vertical-align: top; }
  td.url { font-size: 11px; color: #666; word-break: break-all; max-width: 200px; }
  .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #aaa; margin-bottom: 2px; }
  .label.mt { margin-top: 8px; }
  .before { color: #999; font-size: 12px; }
  .after  { color: #1a5c3b; font-size: 12px; font-weight: 500; }
  .approval-row { margin-top: 32px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #555; }
  .sig-line { display: inline-block; width: 240px; border-bottom: 1px solid #999; margin: 0 12px; }
  .footer { text-align: center; padding: 24px 40px; font-size: 11px; color: #bbb; border-top: 1px solid #eee; margin-top: 24px; }
  @media print { body { background: #fff; } thead { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <h1>SEO Optimization Proposals</h1>
  <div class="practice">${escHtml(siteName)}</div>
  <div class="date">Prepared: ${date}</div>
</div>
<div class="intro">
  The following page titles and meta descriptions have been reviewed and optimized for local search visibility.
  Please review the proposed changes and approve for implementation.
</div>
<div class="container">
  <table>
    <thead>
      <tr>
        <th>Page URL</th>
        <th>Title Tag</th>
        <th>Meta Description</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <div class="approval-row">
    Approved by: <span class="sig-line">&nbsp;</span> Date: <span class="sig-line">&nbsp;</span>
  </div>
</div>
<div class="footer">Prepared by Medical Marketing Whiz &mdash; ${escHtml(domain)}</div>
</body>
</html>`;

    const filename = `seo-approval-${domain}-${date}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (err) {
    console.error('[seo approval] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// HTML escape helper used by export routes
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Schema scan + analyze ────────────────────────────────────────────────────
// POST /api/optimize/:crawlId/schema/scan-analyze — SSE: scan existing schemas
//   via WP plugin, then Claude identifies gaps + generates JSON-LD.
app.post('/api/optimize/:crawlId/schema/scan-analyze', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  if (urls.length > 500) return res.status(400).json({ error: 'Maximum 500 URLs per request' });

  let crawl, client;
  try {
    ({ crawl, client } = await resolveCrawlAndClient(req.params.crawlId));
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured for this client' });
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const emit    = sseEmitter(res);
  const siteUrl = client.wp_url;

  try {
    // 1. Fetch full page data
    emit('log', { message: 'Fetching page data from database...' });
    const allPages = await store.getCrawlPages(crawl.id);
    const urlSet   = new Set(urls);
    const selected = allPages.filter(p => urlSet.has(p.url));
    if (selected.length === 0) {
      emit('error', { message: 'No matching pages found.' }); return res.end();
    }

    // 2. Bulk URL → post ID lookup
    emit('log', { message: `Resolving ${selected.length} URLs to WordPress post IDs...` });
    const lookupResults = await wp.lookupUrls(
      siteUrl, client.wp_username, client.wp_app_password,
      selected.map(p => p.url)
    );
    const postIdMap = {};
    let notFound = 0;
    for (const r of lookupResults) {
      if (r.found) postIdMap[r.url] = r.post_id;
      else notFound++;
    }
    if (notFound > 0) emit('log', { message: `${notFound} URL(s) could not be matched to a WordPress post — they will be skipped for schema push but still analyzed.` });

    // 3. Bulk schema scan via WP plugin
    const foundPostIds = Object.values(postIdMap);
    const scanMap = {}; // url → { post_id, schemas, existing_types }
    if (foundPostIds.length > 0) {
      emit('log', { message: `Scanning existing schemas on ${foundPostIds.length} posts...` });
      const scanResults = await wp.getSchemasBulk(
        siteUrl, client.wp_username, client.wp_app_password, foundPostIds
      );
      const postIdToUrl = {};
      for (const [url, pid] of Object.entries(postIdMap)) postIdToUrl[pid] = url;
      for (const r of scanResults) {
        const url = postIdToUrl[r.post_id];
        if (url) scanMap[url] = { post_id: r.post_id, schemas: r.schemas,
          existing_types: schemaAnalyzer.extractExistingTypes(r.schemas) };
      }
    }
    emit('log', { message: 'Schema scan complete. Starting gap analysis with Claude...' });

    // 4. Prepare page context + generate BreadcrumbList deterministically
    const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const clientName   = (client.clients && client.clients.name) || client.name || '';
    const BATCH_SIZE   = 5;
    const allProposals = [];

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      emit('log', { message: `Analyzing schemas for pages ${i + 1}–${Math.min(i + BATCH_SIZE, selected.length)} of ${selected.length}...` });

      const contextPages = batch.map(p =>
        schemaAnalyzer.preparePageContext(p, siteUrl, scanMap[p.url])
      );

      // Claude-based gap analysis
      const userContent = buildSchemaUserMessage(contextPages, clientName, client);
      let fullText = '';

      const stream = anthropic.messages.stream({
        model:      'claude-opus-4-7',
        max_tokens: 8192,
        thinking:   { type: 'adaptive' },
        system: [{ type: 'text', text: SCHEMA_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
      }, { signal: ac.signal });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text;
        }
      }

      const cleaned = fullText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      let batchResults = [];
      try { batchResults = JSON.parse(cleaned); } catch (_) {
        emit('log', { message: `Warning: could not parse schema batch ${Math.floor(i / BATCH_SIZE) + 1} — skipping.` });
        continue;
      }

      // Inject deterministic BreadcrumbList for each page if not already present
      for (let j = 0; j < batchResults.length; j++) {
        const pageResult = batchResults[j] || {};
        const pageUrl    = pageResult.url || contextPages[j].url;
        const existing   = scanMap[pageUrl] ? scanMap[pageUrl].existing_types : [];

        if (!existing.includes('BreadcrumbList')) {
          const bc = schemaAnalyzer.buildBreadcrumb(pageUrl, siteUrl);
          if (bc) {
            if (!Array.isArray(pageResult.schemas)) pageResult.schemas = [];
            pageResult.schemas.unshift({ schema_type: 'BreadcrumbList', reason: 'Standard breadcrumb navigation schema.', schema: bc });
          }
        }

        // Validate each proposed schema against schema.org vocabulary
        if (Array.isArray(pageResult.schemas)) {
          for (const s of pageResult.schemas) {
            if (s.schema && typeof s.schema === 'object') {
              s.validation = await schemaValidator.validateSchema(s.schema);
            } else {
              s.validation = { valid: false, errors: ['Schema is not a valid JSON object'], warnings: [] };
            }
          }
        }

        // Attach post_id for push step
        pageResult.post_id = postIdMap[pageUrl] || null;
        pageResult.url     = pageUrl;
        allProposals.push(pageResult);
      }
    }

    const invalidCount = allProposals.reduce((n, p) =>
      n + (p.schemas || []).filter(s => s.validation && !s.validation.valid).length, 0);
    if (invalidCount > 0) {
      emit('log', { message: `⚠ ${invalidCount} schema${invalidCount === 1 ? '' : 's'} flagged by schema.org validator — review before pushing.` });
    }

    emit('done', { proposals: allProposals });
  } catch (err) {
    console.error('[schema scan-analyze] error:', err);
    emit('error', { message: err.message });
  }
  res.end();
});

// POST /api/optimize/:crawlId/schema/push — push approved schemas to WordPress
app.post('/api/optimize/:crawlId/schema/push', async (req, res) => {
  const { items } = req.body || {}; // [{ url, postId, schemaType, schema }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }
  if (items.length > 200) return res.status(400).json({ error: 'Maximum 200 items per request' });
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured' });
    }

    // Validate all schemas before pushing any
    const validationResults = await Promise.all(
      items.map(item => schemaValidator.validateSchema(item.schema || {}))
    );
    const invalidItems = items
      .map((item, i) => ({ item, v: validationResults[i] }))
      .filter(({ v }) => !v.valid);
    if (invalidItems.length > 0) {
      const msgs = invalidItems.map(({ item, v }) =>
        `${item.schemaType} (${item.url}): ${v.errors.join('; ')}`
      );
      return res.status(422).json({
        error: 'One or more schemas failed schema.org validation — correct errors before pushing.',
        validation_errors: msgs,
      });
    }

    const results = [];
    for (const item of items) {
      try {
        const r = await wp.deploySchema(
          client.wp_url, client.wp_username, client.wp_app_password,
          { postId: item.postId, schemaType: item.schemaType, schema: item.schema }
        );
        results.push({
          url: item.url, schemaType: item.schemaType, ok: true, meta_key: r.meta_key,
          ...(item.pi != null && { pi: item.pi }),
          ...(item.si != null && { si: item.si }),
        });
      } catch (err) {
        results.push({
          url: item.url, schemaType: item.schemaType, ok: false, error: err.message,
          ...(item.pi != null && { pi: item.pi }),
          ...(item.si != null && { si: item.si }),
        });
      }
    }
    res.json({ results });

    // Save push history (fire-and-forget)
    setImmediate(async () => {
      try {
        const successItems = results.filter(r => r.ok);
        if (successItems.length === 0) return;
        const histItems = successItems.map(r => {
          const orig = items.find(it => it.url === r.url && it.schemaType === r.schemaType) || {};
          return {
            url:         r.url,
            post_id:     orig.postId     || null,
            schema_type: r.schemaType,
            schema:      orig.schema     || {},
          };
        });
        await store.saveSchemaOptimizations(client.id, crawl.id, histItems);
      } catch (e) {
        console.error('[schema push] history save failed:', e);
      }
    });
  } catch (err) {
    console.error('[schema push] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Sitemap Optimizer ────────────────────────────────────────────────────────

// POST /api/sitemap/analyze — SSE: parse sitemap + GSC CSV, tier pages, run Claude analysis
app.post('/api/sitemap/analyze', async (req, res) => {
  const { sitemapXml: sitemapB64, gscCsv: gscB64, clientId } = req.body || {};
  if (!sitemapB64) return res.status(400).json({ error: 'sitemapXml is required' });
  if (!gscB64)    return res.status(400).json({ error: 'gscCsv is required' });

  const emit = sseEmitter(res);

  try {
    // 1. Decode
    emit('log', { message: 'Parsing sitemap XML...' });
    const xmlString = Buffer.from(sitemapB64, 'base64').toString('utf8');
    const csvString = Buffer.from(gscB64, 'base64').toString('utf8');

    let sitemapEntries;
    try {
      sitemapEntries = sitemapAnalyzer.parseSitemapXml(xmlString);
    } catch (e) {
      emit('error', { message: 'Sitemap parse error: ' + e.message }); res.end(); return;
    }
    emit('log', { message: `Parsed ${sitemapEntries.length} URLs from sitemap.` });

    // 2. Parse GSC
    emit('log', { message: 'Parsing GSC CSV...' });
    let gscRows;
    try {
      gscRows = sitemapAnalyzer.parseGscCsv(csvString);
    } catch (e) {
      emit('error', { message: 'GSC CSV parse error: ' + e.message }); res.end(); return;
    }
    emit('log', { message: `Parsed ${gscRows.length} rows from GSC export.` });

    // 3. Cross-reference
    emit('log', { message: 'Cross-referencing sitemap against GSC data...' });
    const { matched, sitemapOnly, gscOnly } = sitemapAnalyzer.crossReference(sitemapEntries, gscRows);
    emit('log', { message: `Matched: ${matched.length} | Sitemap-only: ${sitemapOnly.length} | GSC-only: ${gscOnly.length}` });

    // 4. Assign tiers and build stats
    const allPages = [
      ...matched.map(p => ({ ...p, tier: sitemapAnalyzer.assignTier(p) })),
      ...sitemapOnly.map(p => ({ ...p, tier: 'sitemap_only', clicks: 0, impressions: 0 })),
    ];

    const stats = sitemapAnalyzer.buildTierStats(allPages);
    emit('stats', { stats });
    emit('log', { message: `Tiers: ${Object.entries(stats.tiers).map(([k,v]) => `${k}=${v}`).join(', ')}` });

    // 5. Get client context if clientId provided
    let clientContext = null;
    if (clientId) {
      try {
        const client = await store.getClientById(clientId);
        if (client) clientContext = { name: client.name, city: client.city, state: client.state, practice_type: client.practice_type };
      } catch (_) {}
    }

    // 6. Claude analysis
    emit('log', { message: 'Sending to Claude for strategic analysis...' });
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userContent = buildSitemapAnalysisMessage(stats, clientContext);

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    let fullText = '';
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      signal: ac.signal,
      system: [{ type: 'text', text: SITEMAP_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: userContent,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
      }
    }

    // 7. Parse Claude response
    let analysis;
    try {
      const cleaned = fullText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      analysis = JSON.parse(cleaned);
    } catch (_) {
      emit('log', { message: 'Warning: could not parse Claude response as JSON — proceeding with defaults.' });
      analysis = { strategy_summary: fullText.slice(0, 500), report_markdown: fullText };
    }

    emit('analysis', { analysis });
    emit('log', { message: 'Applying decisions to all pages...' });

    // 8. Apply default decisions
    const decisionsAll = sitemapAnalyzer.applyDefaultDecisions(allPages);
    emit('log', { message: `Proposed: keep=${decisionsAll.filter(p=>p.decision==='keep').length}, review=${decisionsAll.filter(p=>p.decision==='review').length}, cut=${decisionsAll.filter(p=>p.decision==='cut').length}` });

    emit('done', { decisions: decisionsAll, gscOnly, analysis });

  } catch (err) {
    console.error('[sitemap analyze] error:', err);
    emit('error', { message: err.message });
  }
  res.end();
});

// POST /api/sitemap/export — download proposed sitemap XML, decision CSV, or markdown report
app.post('/api/sitemap/export', (req, res) => {
  const { decisions, format, siteUrl } = req.body || {};
  if (!Array.isArray(decisions)) return res.status(400).json({ error: 'decisions array required' });

  try {
    if (format === 'xml') {
      const xml = sitemapAnalyzer.buildProposedSitemapXml(decisions, siteUrl || '');
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', 'attachment; filename="proposed-sitemap.xml"');
      return res.send(xml);
    }
    if (format === 'csv') {
      const csv = sitemapAnalyzer.buildDecisionCsv(decisions);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="sitemap-decisions.csv"');
      return res.send(csv);
    }
    if (format === 'report') {
      const report = (req.body.reportMarkdown || '');
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', 'attachment; filename="sitemap-report.md"');
      return res.send(report);
    }
    res.status(400).json({ error: 'format must be xml, csv, or report' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Migrate tab (blog migration to WordPress) ───────────────────────────────
// Four-step flow: discover → sample-test → connection-test → push.
// Server-side enforces that sample-test and connection-test have been called
// successfully in this session before /push will run. The gate state is
// in-memory only — simple and good enough for an internal tool.

const migrateSessions = new Map(); // crawlId → { sampleOk, connectionOk, lastTouched }

function migrateSession(crawlId) {
  if (!migrateSessions.has(crawlId)) {
    migrateSessions.set(crawlId, { sampleOk: false, connectionOk: false, lastTouched: Date.now() });
  }
  const s = migrateSessions.get(crawlId);
  s.lastTouched = Date.now();
  return s;
}

// Periodically evict sessions older than 2h (no-op cleanup so the map doesn't grow unbounded)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of migrateSessions.entries()) {
    if (v.lastTouched < cutoff) migrateSessions.delete(k);
  }
}, 30 * 60 * 1000).unref();

const RSS_AUTOFIND_PATHS = ['/feed', '/1/feed', '/blog?format=rss', '/rss', '/blog/feed', '/articles/feed'];

// Deliberate exception to the "no fetching from migrate analyzer" rule:
// the crawl's extracted_body is a text-compressed prose digest, unsuitable
// for migration which needs faithful post HTML. So sample-test and push
// fetch the live source page and run extraction against it.
async function fetchSourcePage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MMW-Site-Intelligence/1.0 (blog-migration)' },
    redirect: 'follow',
    signal:   AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function tryFetchRss(siteUrl) {
  if (!siteUrl) return { url: null, xml: null };
  const origin = (() => { try { return new URL(siteUrl).origin; } catch (_) { return ''; } })();
  if (!origin) return { url: null, xml: null };

  for (const p of RSS_AUTOFIND_PATHS) {
    const url = origin + p;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'MMW-Site-Intelligence/1.0 RSS-discover' },
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const xml = await res.text();
      if (xml && (ct.includes('xml') || xml.trim().startsWith('<?xml') || xml.includes('<rss') || xml.includes('<feed'))) {
        return { url, xml };
      }
    } catch (_) { /* try next */ }
  }
  return { url: null, xml: null };
}

// GET /api/migrate/:crawlId/discover
//   Query: rssUrl? (override URL or "none"), urlPatterns? (comma-separated)
app.get('/api/migrate/:crawlId/discover', async (req, res) => {
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });

    const pages = await store.getCrawlPages(crawl.id);

    const patternsParam = (req.query.urlPatterns || '').trim();
    const urlPatterns = patternsParam
      ? patternsParam.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const candidates = migrate.detectBlogPosts(pages, {
      siteUrl:      crawl.target_url,
      urlPatterns,
      minWordCount: 150,
    });

    // RSS — explicit URL, auto-detect, or skip
    let rssXml = null, rssUrl = null;
    const rssParam = (req.query.rssUrl || '').trim();
    if (rssParam === 'none') {
      rssXml = null;
    } else if (rssParam) {
      try {
        const r = await fetch(rssParam, { headers: { 'User-Agent': 'MMW-Site-Intelligence/1.0' }, signal: AbortSignal.timeout(15_000) });
        if (r.ok) { rssXml = await r.text(); rssUrl = rssParam; }
      } catch (_) { /* leave null */ }
    } else {
      const found = await tryFetchRss(crawl.target_url);
      rssXml = found.xml;
      rssUrl = found.url;
    }

    const rssItems = rssXml ? migrate.parseRssFeed(rssXml) : [];
    const merged   = migrate.mergeRssWithPages(rssItems, candidates);

    // Detect platform from one sample page
    const samplePage = pages.find(p => /\/articles\//.test(p.url) || /\/blog\//.test(p.url));
    const platform   = migrate.detectPlatform(crawl.target_url, (samplePage && samplePage.extracted_body) || '');

    // Strip private fields before returning
    const safe = merged.map(c => ({
      url:             c.url,
      title:           c.title,
      h1:              c.h1,
      word_count:      c.word_count,
      image_count:     c.image_count,
      pub_date:        c.pub_date,
      author:          c.author,
      category:        c.category,
      slug:            c.slug,
      rss_enriched:    c.rss_enriched,
      default_checked: c.default_checked,
    }));

    res.json({
      crawlId:       crawl.id,
      crawl:         { id: crawl.id, target_url: crawl.target_url, clients: crawl.clients },
      clientId:      client ? client.id : null,
      hasWpCreds:    !!(client && client.wp_url && client.wp_username && client.wp_app_password),
      wp_url:        (client && client.wp_url)      || '',
      wp_username:   (client && client.wp_username) || '',
      platform,
      rssDetected:   !!rssUrl,
      rssUrl:        rssUrl || null,
      rssItemCount:  rssItems.length,
      posts:         safe,
    });
  } catch (err) {
    console.error('[migrate discover] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/migrate/:crawlId/sample-test
//   body: { urls: [...] }   — server picks 3 representative, fetches each live,
//   extracts post body, and runs normalization. No WordPress calls.
app.post('/api/migrate/:crawlId/sample-test', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  try {
    const { crawl } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });

    const pages    = await store.getCrawlPages(crawl.id);
    const urlSet   = new Set(urls);
    const selected = pages.filter(p => urlSet.has(p.url));
    if (selected.length === 0) {
      return res.status(400).json({ error: 'No matching pages found for the provided URLs' });
    }

    const candidates = migrate.detectBlogPosts(selected, { minWordCount: 1 });
    const samplePicks = migrate.pickRepresentativeSamples(candidates);

    // RSS enrichment so metadata is populated
    const rssFound = await tryFetchRss(crawl.target_url).catch(() => ({ xml: null }));
    const rssItems = rssFound.xml ? migrate.parseRssFeed(rssFound.xml) : [];
    const enriched = migrate.mergeRssWithPages(rssItems, samplePicks);

    // Detect platform from the first fetched page (more reliable than crawl body)
    let platform = 'unknown';
    const out = [];
    const errors = [];

    for (const c of enriched) {
      try {
        const fullHtml = await fetchSourcePage(c.url);
        if (platform === 'unknown') {
          platform = migrate.detectPlatform(crawl.target_url, fullHtml);
        }
        const postHtml   = migrate.extractPostBody(fullHtml, platform);
        const htmlMeta   = migrate.extractMetadataFromHtml(fullHtml);
        const normalized = migrate.normalizePostBody(postHtml, { platform });
        const images     = migrate.extractInlineImages(postHtml).map(img => ({
          ...img,
          original_url: migrate.absoluteUrl(img.original_url, c.url),
        }));

        out.push({
          url:             c.url,
          platform,
          metadata: {
            title:    c.title || htmlMeta.title || htmlMeta.h1,
            slug:     c.slug || migrate.buildSlug(htmlMeta.title || htmlMeta.h1 || '', c.url),
            pub_date: c.pub_date || htmlMeta.pub_date,
            author:   c.author   || htmlMeta.author,
            category: c.category,
          },
          raw_html:        postHtml,
          normalized_html: normalized,
          images,
        });
      } catch (e) {
        errors.push({ url: c.url, error: e.message });
      }
    }

    if (out.length === 0) {
      migrateSession(crawl.id).sampleOk = false;
      return res.status(502).json({ error: 'Failed to fetch any sample pages', errors });
    }

    migrateSession(crawl.id).sampleOk = true;
    res.json({ samples: out, platform, errors });
  } catch (err) {
    console.error('[migrate sample-test] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/migrate/:crawlId/connection-test
//   Runs four checks: auth, capabilities, media round-trip, category round-trip.
app.post('/api/migrate/:crawlId/connection-test', async (req, res) => {
  try {
    const { crawl, client } = await resolveCrawlAndClient(req.params.crawlId);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured for this client' });
    }

    const auth = { username: client.wp_username, appPassword: client.wp_app_password };
    const checks = [];

    // 1. Authentication + capabilities
    const verify = await wpMigrate.verifyCredentials(client.wp_url, client.wp_username, client.wp_app_password);
    checks.push({
      name:   'Authentication',
      ok:     !!verify.user_id,
      detail: verify.user_id
        ? `Connected as "${verify.user_name || verify.user_slug || client.wp_username}" (user #${verify.user_id})`
        : (verify.error || 'Authentication failed'),
    });
    checks.push({
      name:   'Required capabilities',
      ok:     !!verify.ok,
      detail: verify.ok
        ? 'User has publish_posts and upload_files capabilities'
        : (verify.error || 'Missing required capabilities'),
    });

    // 2. Image round-trip
    let mediaCheck = { name: 'Image upload round-trip', ok: false, detail: 'Not attempted' };
    if (verify.ok) {
      try {
        const uploaded = await wpMigrate.uploadMedia(client.wp_url, auth, {
          buffer:   wpMigrate.TEST_PNG,
          filename: `mmw-migration-test-${Date.now()}.png`,
          mimeType: 'image/png',
          alt:      'MMW migration test',
        });
        try {
          await wpMigrate.deleteMedia(client.wp_url, auth, uploaded.media_id);
          mediaCheck = { name: 'Image upload round-trip', ok: true, detail: `Uploaded test image (id ${uploaded.media_id}) and deleted successfully` };
        } catch (delErr) {
          mediaCheck = { name: 'Image upload round-trip', ok: false, detail: `Uploaded id ${uploaded.media_id} but cleanup failed: ${delErr.message}` };
        }
      } catch (upErr) {
        mediaCheck = { name: 'Image upload round-trip', ok: false, detail: upErr.message };
      }
    }
    checks.push(mediaCheck);

    // 3. Category round-trip
    let catCheck = { name: 'Category create/delete', ok: false, detail: 'Not attempted' };
    if (verify.ok) {
      try {
        const cache = wpMigrate.makeTermCache();
        const testName = `mmw-migration-test-${Date.now()}`;
        const id = await wpMigrate.ensureCategory(client.wp_url, auth, testName, cache);
        try {
          await wpMigrate.deleteCategory(client.wp_url, auth, id);
          catCheck = { name: 'Category create/delete', ok: true, detail: `Created "${testName}" (id ${id}) and deleted successfully` };
        } catch (delErr) {
          catCheck = { name: 'Category create/delete', ok: false, detail: `Created id ${id} but cleanup failed: ${delErr.message}` };
        }
      } catch (e) {
        catCheck = { name: 'Category create/delete', ok: false, detail: e.message };
      }
    }
    checks.push(catCheck);

    const allOk = checks.every(c => c.ok);
    migrateSession(crawl.id).connectionOk = allOk;
    res.json({ ok: allOk, checks });
  } catch (err) {
    console.error('[migrate connection-test] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/migrate/:crawlId/push
//   body: { urls: [...], migrate_images: bool, post_status: 'draft'|'publish',
//           category_map?: {}, author_map?: {} }
//   SSE stream of per-post events.
app.post('/api/migrate/:crawlId/push', async (req, res) => {
  const {
    urls,
    migrate_images      = true,
    post_status         = 'draft',
    category_map        = {},
    additional_category = null,
  } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }
  if (post_status !== 'draft' && post_status !== 'publish') {
    return res.status(400).json({ error: 'post_status must be "draft" or "publish"' });
  }

  let crawl, client;
  try {
    ({ crawl, client } = await resolveCrawlAndClient(req.params.crawlId));
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    if (!client || !client.wp_url || !client.wp_username || !client.wp_app_password) {
      return res.status(400).json({ error: 'WordPress credentials not configured for this client' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Enforce the verification gate
  const sess = migrateSession(crawl.id);
  if (!sess.sampleOk || !sess.connectionOk) {
    return res.status(412).json({
      error: 'Verification gate not satisfied. Run sample-test and connection-test successfully in this session before pushing.',
      sampleOk:     sess.sampleOk,
      connectionOk: sess.connectionOk,
    });
  }

  const auth = { username: client.wp_username, appPassword: client.wp_app_password };

  // SSE setup
  const emit = sseEmitter(res);
  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  try {
    emit('log', { message: `Loading ${urls.length} pages from crawl data...` });
    const allPages = await store.getCrawlPages(crawl.id);
    const urlSet   = new Set(urls);
    const selected = allPages.filter(p => urlSet.has(p.url));
    if (selected.length === 0) {
      emit('error', { message: 'No matching pages found for the provided URLs.' });
      return res.end();
    }

    const candidates = migrate.detectBlogPosts(selected, { minWordCount: 1 });

    // Re-enrich with RSS to get dates/authors/categories
    const rssFound = await tryFetchRss(crawl.target_url).catch(() => ({ xml: null }));
    const rssItems = rssFound.xml ? migrate.parseRssFeed(rssFound.xml) : [];
    const enriched = migrate.mergeRssWithPages(rssItems, candidates);

    // Platform detection happens off the first fetched page below
    let platform = migrate.detectPlatform(crawl.target_url, '');
    emit('log', { message: `${rssItems.length} RSS items merged. Fetching source HTML per post (this can take a while).` });

    const termCache  = wpMigrate.makeTermCache();
    const gate       = wpMigrate.rateLimiter(700);
    const mediaCache = new Map(); // sourceUrl → destUrl  (for duplicate uploads in same run)

    // Resolve the run-wide "additional category" once. Every post will be
    // tagged with this category id in addition to whatever RSS provides.
    let additionalCategoryId = null;
    if (additional_category && String(additional_category).trim()) {
      const name = String(additional_category).trim();
      try {
        await gate();
        additionalCategoryId = await wpMigrate.ensureCategory(client.wp_url, auth, name, termCache);
        emit('log', { message: `Tagging every post with category "${name}" (id ${additionalCategoryId}).` });
      } catch (e) {
        emit('log', { message: `Warning: could not ensure category "${name}": ${e.message}. Continuing without it.` });
      }
    }

    let created = 0, failed = 0, skipped = 0;

    for (const post of enriched) {
      if (cancelled) {
        emit('log', { message: 'Cancelled by client. Stopping further imports.' });
        break;
      }

      emit('post_started', { url: post.url, title: post.title });

      try {
        // Fetch the live source page
        let fullHtml;
        try {
          fullHtml = await fetchSourcePage(post.url);
        } catch (fe) {
          failed++;
          emit('post_failed', { url: post.url, error: `Source fetch failed: ${fe.message}` });
          continue;
        }
        if (platform === 'unknown') platform = migrate.detectPlatform(crawl.target_url, fullHtml);

        const htmlMeta = migrate.extractMetadataFromHtml(fullHtml);
        const rawBody  = migrate.extractPostBody(fullHtml, platform);

        // Merge metadata: RSS wins, then HTML, then crawl
        const finalTitle  = post.title    || htmlMeta.title || htmlMeta.h1 || '(untitled)';
        const finalDate   = post.pub_date || htmlMeta.pub_date;
        const finalAuthor = post.author   || htmlMeta.author;
        // Slug: prefer the source URL's last path segment (canonical for the
        // post, and immune to generic-fallback titles like "Articles | Blog | ...")
        const finalSlug   = migrate.slugFromUrl(post.url) ||
                             post.slug ||
                             migrate.buildSlug(finalTitle, post.url);

        // Check for slug collision in destination
        await gate();
        const existing = await wpMigrate.findPostBySlug(client.wp_url, auth, finalSlug).catch(() => null);
        if (existing) {
          skipped++;
          emit('post_failed', {
            url:    post.url,
            error:  `Post with slug "${finalSlug}" already exists in destination (id ${existing.id}). Skipping to avoid duplicate.`,
            skipped: true,
          });
          continue;
        }

        const inlineImages = migrate.extractInlineImages(rawBody);
        let featuredOriginalSrc = null;
        const urlMap = {};
        let featuredMediaId = null;

        if (migrate_images && inlineImages.length > 0) {
          for (let i = 0; i < inlineImages.length; i++) {
            if (cancelled) break;
            const img = inlineImages[i];
            const absUrl = migrate.absoluteUrl(img.original_url, post.url);
            if (mediaCache.has(absUrl)) {
              urlMap[img.original_url] = mediaCache.get(absUrl);
              continue;
            }
            try {
              await gate();
              const downloaded = await fetch(absUrl, { signal: AbortSignal.timeout(60_000) });
              if (!downloaded.ok) throw new Error(`HTTP ${downloaded.status} fetching ${absUrl}`);
              const buf = Buffer.from(await downloaded.arrayBuffer());
              const mimeType = downloaded.headers.get('content-type') || 'application/octet-stream';
              const filename = (absUrl.split('/').pop() || `img-${Date.now()}`).split('?')[0].slice(0, 100) || `img-${Date.now()}.jpg`;

              await gate();
              const uploaded = await wpMigrate.uploadMedia(client.wp_url, auth, {
                buffer:   buf,
                filename,
                mimeType,
                alt:      img.alt || post.title,
              });
              urlMap[img.original_url] = uploaded.source_url;
              mediaCache.set(absUrl, uploaded.source_url);
              if (featuredMediaId == null) {
                featuredMediaId    = uploaded.media_id;
                featuredOriginalSrc = img.original_url;
              }
              emit('image_uploaded', { url: post.url, source: absUrl, media_id: uploaded.media_id });
            } catch (imgErr) {
              emit('image_failed', { url: post.url, source: absUrl, error: imgErr.message });
            }
          }
        }

        // Remove the image promoted to featured_media from the body so it
        // doesn't render twice (once as WP's featured image, once inline).
        // Sibling caption text (e.g. "Photo by X @ Unsplash") is preserved.
        const bodyMinusFeatured = featuredOriginalSrc
          ? migrate.removeImageFromHtml(rawBody, featuredOriginalSrc)
          : rawBody;
        const rewritten = migrate.rewriteImageUrls(bodyMinusFeatured, urlMap);
        const finalHtml = migrate.normalizePostBody(rewritten, { platform });

        // Categories / tags
        const categoryNames = [];
        const tagNames      = [];
        if (post.category) {
          const mapped = category_map[post.category] || post.category;
          categoryNames.push(mapped);
        }

        const categoryIds = [];
        if (additionalCategoryId) categoryIds.push(additionalCategoryId);
        for (const name of categoryNames) {
          try { await gate(); const id = await wpMigrate.ensureCategory(client.wp_url, auth, name, termCache); if (id && !categoryIds.includes(id)) categoryIds.push(id); }
          catch (_) { /* non-fatal */ }
        }
        const tagIds = [];
        for (const name of tagNames) {
          try { await gate(); const id = await wpMigrate.ensureTag(client.wp_url, auth, name, termCache); if (id) tagIds.push(id); }
          catch (_) { /* non-fatal */ }
        }

        // Date
        let isoDate = null;
        if (finalDate) {
          const d = new Date(finalDate);
          if (!isNaN(d.getTime())) isoDate = d.toISOString();
        }

        await gate();
        const result = await wpMigrate.createPost(client.wp_url, auth, {
          title:          finalTitle,
          content:        finalHtml,
          status:         post_status,
          slug:           finalSlug,
          date:           isoDate,
          featured_media: featuredMediaId,
          categories:     categoryIds,
          tags:           tagIds,
        });

        created++;
        emit('post_created', {
          url:      post.url,
          post_id:  result.post_id,
          post_url: result.post_url,
          status:   result.status,
        });
      } catch (e) {
        failed++;
        emit('post_failed', { url: post.url, error: e.message });
      }
    }

    emit('done', {
      total:     enriched.length,
      created,
      failed,
      skipped,
      cancelled,
    });
  } catch (err) {
    console.error('[migrate push] error:', err);
    emit('error', { message: err.message });
  }
  res.end();
});

// ─── Brand Voice cross-tool API (authenticated) ───────────────────────────────
// Mounted here so /api/brand-voice/:clientId and /api/brand-voice/by-domain/:domain
// are both available. The router handles auth internally.

app.use('/api/brand-voice', brandVoiceApi);

// ─── Start ───────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`MMW Site Intelligence — listening on :${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'configured' : 'NOT SET'}`);
  // Upgrade bundled schema.org vocab to full live vocabulary in background.
  schemaValidator.preload();
});
