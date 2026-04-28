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

const engine = require('./crawl/engine');
const store  = require('./crawl/store');
const jobs   = require('./jobs');
const audit  = require('./analyzers/audit');

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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`MMW Site Intelligence — listening on :${PORT}`);
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'configured' : 'NOT SET'}`);
});
