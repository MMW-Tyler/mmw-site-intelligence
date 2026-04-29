'use strict';

/**
 * MMW Site Intelligence — Scout Analyzer
 *
 * Generates Markdown content blocks from crawled pages for use as AI context.
 * Same output format as the legacy MMW Content Scout tool, but reads from the
 * shared crawl instead of re-fetching.
 *
 * Pure functions only — no DB access, no I/O.
 *
 * Exports:
 *   shouldDefaultCheck(page)              → boolean
 *   formatPageBlock(page)                 → string
 *   formatBatch(pages, opts)              → string
 *   formatManifest(batchMeta, opts)       → string
 *   buildBatches(pages, batchSize)        → Array<Array<page>>
 */

// ─── Default-check heuristics ─────────────────────────────────────────────────
// Pages that pass these checks are selected by default in the Scout picker.
// The user can change any selection before generating.

const BODY_THRESHOLD = 150; // word_count below this = low-content page

const EXCLUDE_URL_PATTERNS = [
  /\/(cart|checkout|my-account|login|register|wp-login|wp-admin|wp-json|feed|xmlrpc)\/?$/i,
  /\/page\/\d+\/?$/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip)$/i,
];

function shouldDefaultCheck(page) {
  if (!page.url) return false;
  const sc = page.status_code || 0;
  if (sc < 200 || sc >= 300) return false;
  if (page.indexability === 'Non-Indexable') return false;
  if ((page.word_count || 0) < BODY_THRESHOLD) return false;
  if (EXCLUDE_URL_PATTERNS.some(re => re.test(page.url))) return false;
  return true;
}

// ─── Markdown formatting ──────────────────────────────────────────────────────

function formatPageBlock(page) {
  const lines = [];

  const title = ((page.title || page.h1 || page.url) + '').trim();
  lines.push(title);
  lines.push(`URL: ${page.url}`);
  if (page.h1 && page.h1.trim()) {
    lines.push(`H1: ${page.h1.trim()}`);
  }

  const headings = Array.isArray(page.headings) ? page.headings : [];
  if (headings.length > 0) {
    lines.push('Page sections:');
    headings.forEach(h => lines.push(h.text));
  }

  const body = (page.extracted_body || '').trim();
  if (body) {
    lines.push('Content:');
    lines.push(body);
  }

  return lines.join('\n');
}

function formatBatch(pages, opts) {
  opts = opts || {};
  const siteName   = opts.siteName    || 'Site';
  const batchNum   = opts.batchNumber || 1;
  const batchTotal = opts.batchTotal  || 1;
  const start      = opts.startIndex  || 0;
  const crawlDate  = opts.crawlDate   || new Date().toISOString().split('T')[0];

  const header = [
    `${siteName} — Content Reference`,
    `Batch: ${batchNum} of ${batchTotal} | URLs ${start + 1}–${start + pages.length} of ${opts.totalPages || pages.length}`,
    `Crawled: ${crawlDate}`,
    `Purpose: Source-of-truth for content generation. Each block = URL, title, H1, headings, compressed body (~700 tokens max per page).`,
    `> USAGE: Find the matching URL block and use as factual foundation for content generation. Do not contradict existing claims, terminology, or described procedures.`,
    '---',
    '',
  ].join('\n');

  const blocks = pages.map(p => formatPageBlock(p)).join('\n---\n');
  return header + blocks + '\n---\n';
}

function formatManifest(batchMeta, opts) {
  opts = opts || {};
  const siteName  = opts.siteName || 'Site';
  const total     = batchMeta.reduce((sum, b) => sum + b.count, 0);
  const date      = new Date().toISOString().split('T')[0];
  const batchWord = batchMeta.length === 1 ? 'batch' : 'batches';

  const lines = [
    `# Content Scout — ${siteName}`,
    `Generated: ${date}`,
    `Total pages: ${total} across ${batchMeta.length} ${batchWord}`,
    '',
  ];

  batchMeta.forEach(b => {
    lines.push(`- **${b.filename}** — pages ${b.startIndex + 1}–${b.startIndex + b.count} (${b.count} pages)`);
  });

  lines.push('');
  return lines.join('\n');
}

// ─── Batch splitting ──────────────────────────────────────────────────────────

function buildBatches(pages, batchSize) {
  const batches = [];
  for (let i = 0; i < pages.length; i += batchSize) {
    batches.push(pages.slice(i, i + batchSize));
  }
  return batches;
}

module.exports = {
  shouldDefaultCheck,
  formatPageBlock,
  formatBatch,
  formatManifest,
  buildBatches,
  BODY_THRESHOLD,
};
