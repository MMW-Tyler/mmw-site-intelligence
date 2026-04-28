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

const engine       = require('./crawl/engine');
const store        = require('./crawl/store');
const jobs         = require('./jobs');
const audit        = require('./analyzers/audit');
const scout        = require('./analyzers/scout');
const voice        = require('./analyzers/voice');
const brandVoiceApi = require('./api/brand-voice');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
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

    const batchMeta = batches.map((pages, i) => {
      const filename = `batch-${String(i + 1).padStart(3, '0')}.md`;
      zip.file(filename, scout.formatBatch(pages, {
        siteName:    name,
        batchNumber: i + 1,
        batchTotal:  batches.length,
        startIndex:  i * batchSize,
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

    const profile = await voice.analyzeVoice(pages, emit);

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

// ─── Brand Voice cross-tool API (authenticated) ───────────────────────────────
// Mounted here so /api/brand-voice/:clientId and /api/brand-voice/by-domain/:domain
// are both available. The router handles auth internally.

app.use('/api/brand-voice', brandVoiceApi);

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`MMW Site Intelligence — listening on :${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'configured' : 'NOT SET'}`);
});
