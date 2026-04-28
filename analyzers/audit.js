/**
 * MMW Site Intelligence — Audit Analyzer
 *
 * Reads pages from a finalized crawl and produces:
 *   • summary stats (counts, averages)
 *   • flagged issues (thin content, missing meta, title length, cannibalization)
 *   • CSV export string
 *
 * Pure functions only — no DB access, no I/O. The server passes in pages,
 * the analyzer returns derived data. This makes it trivial to unit test.
 *
 * Exports:
 *   analyze(pages, options) → { summary, pages, issues }
 *   buildCSV(pages)         → string
 */

'use strict';

// ─── Thresholds ──────────────────────────────────────────────────────────────
// Stashed in code rather than as UI knobs. If the team wants to tune these
// per-client later, we expose them in the Audit tab UI then.

const DEFAULTS = {
  thinWordCount:       300,   // pages below this are flagged as thin
  titleMinLength:      30,    // <30 chars = "Too Short"
  titleMaxLength:      60,    // >60 chars = "Too Long"
  metaMinLength:       80,    // <80 chars = "Too Short"
  metaMaxLength:       160,   // >160 chars = "Too Long"
  cannibalSimilarity:  0.85,  // title similarity threshold for "near duplicate"
};

// ─── Public: analyze ─────────────────────────────────────────────────────────

function analyze(pages, opts) {
  opts = { ...DEFAULTS, ...(opts || {}) };
  pages = pages || [];

  const indexable = pages.filter(p => p.indexability === 'Indexable' && p.status_code >= 200 && p.status_code < 300);

  // ── Per-page issue tagging ────────────────────────────────────────────────
  // We attach a `flags` array to each page so the table UI can render badges.
  const flagged = pages.map(p => {
    const flags = [];

    if (p.status_code === 0) flags.push('fetch_failed');
    if (p.status_code >= 400) flags.push('http_error');
    if (p.redirect_to) flags.push('redirect');
    if (p.indexability === 'Non-Indexable') flags.push('noindex');

    if (p.status_code >= 200 && p.status_code < 300) {
      if (!p.title) flags.push('title_missing');
      else if (p.title_length < opts.titleMinLength) flags.push('title_short');
      else if (p.title_length > opts.titleMaxLength) flags.push('title_long');

      if (!p.meta_desc_present) flags.push('meta_missing');
      else {
        const mlen = (p.meta_description || '').length;
        if (mlen < opts.metaMinLength) flags.push('meta_short');
        else if (mlen > opts.metaMaxLength) flags.push('meta_long');
      }

      if (!p.h1) flags.push('h1_missing');
      if (p.word_count < opts.thinWordCount) flags.push('thin');
      if (!p.has_cta) flags.push('no_cta');
      if (p.canonical_match === 'Other') flags.push('canonical_other');
    }

    return { ...p, flags };
  });

  // ── Cannibalization clusters ──────────────────────────────────────────────
  // Group indexable pages by normalized title; clusters of 2+ are suspect.
  const cannibalClusters = findCannibalClusters(indexable, opts.cannibalSimilarity);

  // Annotate flagged pages with cannibal flag + cluster id
  const cannibalUrlMap = new Map();
  cannibalClusters.forEach((cluster, idx) => {
    cluster.urls.forEach(url => cannibalUrlMap.set(url, idx));
  });
  flagged.forEach(p => {
    if (cannibalUrlMap.has(p.url)) {
      p.flags.push('cannibal');
      p.cannibalClusterId = cannibalUrlMap.get(p.url);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = {
    total:          pages.length,
    ok:             pages.filter(p => p.status_code >= 200 && p.status_code < 300).length,
    redirects:      pages.filter(p => p.status_code >= 300 && p.status_code < 400).length,
    errors:         pages.filter(p => p.status_code >= 400 || p.status_code === 0).length,
    indexable:      indexable.length,
    nonIndexable:   pages.filter(p => p.indexability === 'Non-Indexable').length,
    avgWordCount:   avg(indexable.map(p => p.word_count || 0)),
    issues: {
      thin:               countByFlag(flagged, 'thin'),
      titleMissing:       countByFlag(flagged, 'title_missing'),
      titleShort:         countByFlag(flagged, 'title_short'),
      titleLong:          countByFlag(flagged, 'title_long'),
      metaMissing:        countByFlag(flagged, 'meta_missing'),
      metaShort:          countByFlag(flagged, 'meta_short'),
      metaLong:           countByFlag(flagged, 'meta_long'),
      h1Missing:          countByFlag(flagged, 'h1_missing'),
      noCta:              countByFlag(flagged, 'no_cta'),
      canonicalOther:     countByFlag(flagged, 'canonical_other'),
      cannibalClusters:   cannibalClusters.length,
      cannibalPages:      cannibalUrlMap.size,
    },
  };

  return {
    summary,
    pages: flagged,
    cannibalClusters,
  };
}

// ─── Cannibalization ─────────────────────────────────────────────────────────
// Strategy: normalize titles (lowercase, strip site-name suffix, collapse
// punctuation), group exact matches first, then bucket near-duplicates by
// shared meaningful word set. We avoid pure string-similarity (Levenshtein,
// etc.) because chiropractor sites have lots of legitimately similar titles
// (e.g. "Knee Pain | Chiropractor Tracy CA" vs "Hip Pain | Chiropractor Tracy CA").
//
// The signal we care about: pages targeting the same primary topic.
// Heuristic: take the first "phrase" before a separator (|, –, -, :), then
// flag exact matches of that phrase. This catches the realistic cannibal
// case (two pages titled "Knee Pain Treatment" both ranking for the same query)
// without false-positiving on the site-name suffix.

function findCannibalClusters(pages, _similarity) {
  const buckets = new Map();
  for (const p of pages) {
    const key = normalizeTitleForCannibal(p.title || '');
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  const clusters = [];
  for (const [key, group] of buckets) {
    if (group.length < 2) continue;
    clusters.push({
      key,
      titles: [...new Set(group.map(p => p.title))],
      urls:   group.map(p => p.url),
      pages:  group,
    });
  }

  // Largest clusters first — those are the most actionable
  clusters.sort((a, b) => b.urls.length - a.urls.length);
  return clusters;
}

function normalizeTitleForCannibal(title) {
  if (!title) return '';
  // Take the part before the first separator (site-name suffix removal)
  const primary = title.split(/\s*[|–\-:]\s*/)[0];
  return primary
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CSV builder ─────────────────────────────────────────────────────────────
// Cleaned-up column names — no longer mirroring Screaming Frog since MMW
// doesn't use it. Column order optimized for "what does the auditor look at first."

const CSV_COLUMNS = [
  ['url',                 'URL'],
  ['status_code',         'Status'],
  ['indexability',        'Indexability'],
  ['title',               'Title'],
  ['title_length',        'Title Length'],
  ['title_flag',          'Title Flag'],          // derived
  ['meta_description',    'Meta Description'],
  ['meta_desc_present',   'Has Meta'],
  ['h1',                  'H1'],
  ['h2_count',            'H2 Count'],
  ['h2_sample',           'H2 Sample'],
  ['word_count',          'Word Count'],
  ['inlinks',             'Internal Inlinks'],
  ['canonical_url',       'Canonical URL'],
  ['canonical_match',     'Canonical Match'],
  ['has_cta',             'Has CTA'],
  ['redirect_to',         'Redirects To'],
  ['flags',               'Issue Flags'],         // derived
];

function buildCSV(pages, opts) {
  opts = { ...DEFAULTS, ...(opts || {}) };
  const headerRow = CSV_COLUMNS.map(([_, label]) => csvEscape(label)).join(',');
  const lines = [headerRow];

  for (const p of pages) {
    const titleFlag = !p.title ? 'Missing'
                    : p.title_length < opts.titleMinLength ? 'Too Short'
                    : p.title_length > opts.titleMaxLength ? 'Too Long'
                    : 'Good';
    const flagsStr = (p.flags || []).join(';');

    const row = CSV_COLUMNS.map(([key]) => {
      let v;
      if      (key === 'title_flag') v = titleFlag;
      else if (key === 'flags')      v = flagsStr;
      else if (key === 'meta_desc_present') v = p[key] ? 'Yes' : 'No';
      else if (key === 'has_cta')           v = p[key] ? 'Yes' : 'No';
      else                                  v = p[key];
      return csvEscape(v);
    }).join(',');
    lines.push(row);
  }
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function avg(nums) {
  const filtered = nums.filter(n => n > 0);
  if (!filtered.length) return 0;
  return Math.round(filtered.reduce((a, b) => a + b, 0) / filtered.length);
}

function countByFlag(pages, flag) {
  return pages.filter(p => p.flags.includes(flag)).length;
}

module.exports = { analyze, buildCSV, DEFAULTS };
