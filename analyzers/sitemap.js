'use strict';

/**
 * MMW Site Intelligence — Sitemap Analyzer
 *
 * Pure functions for parsing, cross-referencing, and tiering sitemap + GSC data.
 */

// ─── parseSitemapXml ──────────────────────────────────────────────────────────

/**
 * Parse a standard XML sitemap (urlset) string.
 * Returns deduplicated Array<{ loc, lastmod, priority, changefreq }>.
 * Throws if root element is <sitemapindex>.
 */
function parseSitemapXml(xmlString) {
  if (/<sitemapindex[\s>]/i.test(xmlString)) {
    throw new Error(
      'Sitemap index detected. Please upload the individual page sitemaps, not the index file.'
    );
  }

  // Helper: extract text content from a tag, supporting CDATA
  function extractTag(block, tag) {
    const re = new RegExp(
      `<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*<\\/${tag}>`,
      'i'
    );
    const m = re.exec(block);
    if (!m) return null;
    const val = (m[1] !== undefined ? m[1] : m[2] || '').trim();
    return val || null;
  }

  // Split on <url> blocks
  const urlBlocks = [];
  const urlRe = /<url[\s>]([\s\S]*?)<\/url>/gi;
  let match;
  while ((match = urlRe.exec(xmlString)) !== null) {
    urlBlocks.push(match[1]);
  }

  const seen = new Set();
  const results = [];

  for (const block of urlBlocks) {
    const loc = extractTag(block, 'loc');
    if (!loc) continue;

    const norm = normalizeUrl(loc);
    if (seen.has(norm)) continue;
    seen.add(norm);

    results.push({
      loc,
      lastmod:    extractTag(block, 'lastmod'),
      priority:   extractTag(block, 'priority'),
      changefreq: extractTag(block, 'changefreq'),
    });
  }

  return results;
}

// ─── parseGscCsv ─────────────────────────────────────────────────────────────

/**
 * Parse a Google Search Console CSV export.
 * Finds the header row by looking for "clicks" (case-insensitive).
 * Returns Array<{ url, clicks, impressions, ctr, position }> sorted by clicks desc.
 */
function parseGscCsv(csvString) {
  const lines = csvString.split(/\r?\n/);

  // Detect separator: if header row contains tabs, use tab; else comma
  let headerIdx = -1;
  let sep = ',';

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('clicks')) {
      headerIdx = i;
      // Detect separator from this line
      sep = lines[i].includes('\t') ? '\t' : ',';
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error('Could not find header row containing "Clicks" in GSC CSV export.');
  }

  function splitLine(line) {
    if (sep === '\t') return line.split('\t');
    // Simple CSV split (handles quoted fields)
    const result = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        result.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur);
    return result;
  }

  const headers = splitLine(lines[headerIdx]).map(h => h.trim().toLowerCase().replace(/\s+/g, ' '));

  // Find column indices
  // URL column: "page", "top pages", or first column
  let urlIdx = headers.findIndex(h => h === 'page' || h === 'top pages');
  if (urlIdx === -1) urlIdx = 0;

  const clicksIdx      = headers.findIndex(h => h === 'clicks');
  const impressionsIdx = headers.findIndex(h => h === 'impressions');
  const ctrIdx         = headers.findIndex(h => h === 'ctr');
  const positionIdx    = headers.findIndex(h => h === 'position');

  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = splitLine(line);
    const url  = (cols[urlIdx] || '').trim().replace(/^"|"$/g, '');
    if (!url.startsWith('http')) continue;

    const rawCtr = (cols[ctrIdx] || '0').trim().replace('%', '').replace(/^"|"$/g, '');

    rows.push({
      url,
      clicks:      parseInt((cols[clicksIdx]      || '0').replace(/^"|"$/g, ''), 10) || 0,
      impressions: parseInt((cols[impressionsIdx]  || '0').replace(/^"|"$/g, ''), 10) || 0,
      ctr:         parseFloat(rawCtr) || 0,
      position:    parseFloat((cols[positionIdx]   || '0').replace(/^"|"$/g, '')) || 0,
    });
  }

  rows.sort((a, b) => b.clicks - a.clicks);
  return rows;
}

// ─── normalizeUrl ─────────────────────────────────────────────────────────────

/**
 * Normalize a URL for comparison purposes.
 * Lowercases, strips trailing slash (except root), strips protocol + www.
 */
function normalizeUrl(url) {
  let u = (url || '').trim().toLowerCase();
  // Strip protocol
  u = u.replace(/^https?:\/\//, '');
  // Strip www.
  u = u.replace(/^www\./, '');
  // Strip trailing slash unless it's just the root path
  if (u.endsWith('/') && u.indexOf('/') < u.length - 1) {
    u = u.replace(/\/+$/, '');
  }
  return u;
}

// ─── crossReference ──────────────────────────────────────────────────────────

/**
 * Join sitemap entries and GSC rows on normalized URL.
 * Returns { matched, sitemapOnly, gscOnly }.
 */
function crossReference(sitemapEntries, gscRows) {
  // Build GSC lookup by normalized URL
  const gscMap = new Map();
  for (const row of gscRows) {
    gscMap.set(normalizeUrl(row.url), row);
  }

  // Build sitemap set of normalized URLs
  const sitemapMap = new Map();
  for (const entry of sitemapEntries) {
    sitemapMap.set(normalizeUrl(entry.loc), entry);
  }

  const matched     = [];
  const sitemapOnly = [];

  for (const [norm, entry] of sitemapMap) {
    const gsc = gscMap.get(norm);
    if (gsc) {
      matched.push({
        url:        entry.loc,
        loc:        entry.loc,
        lastmod:    entry.lastmod,
        priority:   entry.priority,
        changefreq: entry.changefreq,
        clicks:      gsc.clicks,
        impressions: gsc.impressions,
        ctr:         gsc.ctr,
        position:    gsc.position,
      });
    } else {
      sitemapOnly.push({
        url:        entry.loc,
        loc:        entry.loc,
        lastmod:    entry.lastmod,
        priority:   entry.priority,
        changefreq: entry.changefreq,
      });
    }
  }

  // GSC-only: in GSC but not in sitemap
  const gscOnly = [];
  for (const [norm, row] of gscMap) {
    if (!sitemapMap.has(norm)) {
      gscOnly.push(row);
    }
  }

  return { matched, sitemapOnly, gscOnly };
}

// ─── assignTier ───────────────────────────────────────────────────────────────

/**
 * Assign a tier string given { clicks, impressions }.
 * Pass undefined/null clicks to get 'sitemap_only'.
 */
function assignTier(page) {
  const { clicks, impressions } = page;
  if (clicks === undefined || clicks === null) return 'sitemap_only';
  if (clicks >= 50)                             return 'hv';
  if (clicks >= 10)                             return 'performing';
  if (clicks >= 1)                              return 'low';
  if (clicks === 0 && impressions >= 100)       return 'invisible';
  if (clicks === 0 && impressions >= 1)         return 'ghost';
  return 'dead';
}

// ─── detectUrlPatterns ────────────────────────────────────────────────────────

/**
 * Detect common first path-segment patterns across all pages.
 * Returns top 15 by count, sorted by count descending.
 */
function detectUrlPatterns(pages) {
  const counts = new Map(); // pattern → { count, totalClicks }

  for (const page of pages) {
    const url = page.url || page.loc || '';
    let path;
    try {
      path = new URL(url).pathname;
    } catch (_) {
      path = url.replace(/^https?:\/\/[^/]+/, '') || '/';
    }

    // Extract first path segment
    const parts = path.split('/').filter(Boolean);
    const segment = parts.length > 0 ? parts[0] : '(root)';

    if (!counts.has(segment)) {
      counts.set(segment, { pattern: '/' + segment + '/', count: 0, totalClicks: 0 });
    }
    const entry = counts.get(segment);
    entry.count++;
    entry.totalClicks += (page.clicks || 0);
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ─── buildTierStats ───────────────────────────────────────────────────────────

/**
 * Given all pages (matched + sitemapOnly with tier assigned), return stats.
 */
function buildTierStats(pages) {
  const tiers = { hv: 0, performing: 0, low: 0, invisible: 0, ghost: 0, dead: 0, sitemap_only: 0 };

  let totalClicks      = 0;
  let totalImpressions = 0;

  for (const p of pages) {
    const t = p.tier || assignTier(p);
    if (tiers[t] !== undefined) tiers[t]++;
    totalClicks      += (p.clicks      || 0);
    totalImpressions += (p.impressions || 0);
  }

  const sorted = [...pages].sort((a, b) => (b.clicks || 0) - (a.clicks || 0));

  function sample(tier, n) {
    return pages.filter(p => p.tier === tier).slice(0, n);
  }

  return {
    total:            pages.length,
    tiers,
    totalClicks,
    totalImpressions,
    topPages:         sorted.slice(0, 20),
    sampleByTier: {
      hv:          sample('hv',          5),
      performing:  sample('performing',  5),
      low:         sample('low',         8),
      invisible:   sample('invisible',   8),
      ghost:       sample('ghost',       8),
      dead:        sample('dead',        5),
      sitemap_only: sample('sitemap_only', 5),
    },
    urlPatterns: detectUrlPatterns(pages),
  };
}

// ─── applyDefaultDecisions ────────────────────────────────────────────────────

const TIER_DEFAULT_DECISION = {
  hv:           'keep',
  performing:   'keep',
  low:          'review',
  invisible:    'review',
  ghost:        'cut',
  dead:         'cut',
  sitemap_only: 'review',
};

/**
 * Return a new array of pages with a `decision` field added.
 */
function applyDefaultDecisions(pages) {
  return pages.map(p => ({
    ...p,
    decision: TIER_DEFAULT_DECISION[p.tier] || 'review',
  }));
}

// ─── buildProposedSitemapXml ──────────────────────────────────────────────────

const TIER_PRIORITY = {
  hv:           '1.0',
  performing:   '0.8',
  low:          '0.6',
  invisible:    '0.6',
  ghost:        '0.6',
  dead:         '0.6',
  sitemap_only: '0.5',
  review:       '0.6',
};

const TIER_CHANGEFREQ = {
  hv:           'weekly',
  performing:   'monthly',
};

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a valid XML sitemap from pages where decision !== 'cut'.
 */
function buildProposedSitemapXml(pages, siteUrl) {
  // Filter out cut pages
  const keep = pages.filter(p => p.decision !== 'cut');

  // Sort: hv first, then performing, then others by clicks descending
  const tierOrder = { hv: 0, performing: 1 };
  keep.sort((a, b) => {
    const ta = tierOrder[a.tier] !== undefined ? tierOrder[a.tier] : 2;
    const tb = tierOrder[b.tier] !== undefined ? tierOrder[b.tier] : 2;
    if (ta !== tb) return ta - tb;
    return (b.clicks || 0) - (a.clicks || 0);
  });

  const urlEntries = keep.map(p => {
    const loc        = escXml(p.url || p.loc || '');
    const priority   = TIER_PRIORITY[p.tier]    || '0.6';
    const changefreq = TIER_CHANGEFREQ[p.tier]  || 'monthly';
    const lastmodTag = p.lastmod ? `\n    <lastmod>${escXml(p.lastmod)}</lastmod>` : '';

    return `  <url>
    <loc>${loc}</loc>${lastmodTag}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;
}

// ─── buildDecisionCsv ─────────────────────────────────────────────────────────

/**
 * Build a CSV with columns: URL, Tier, Decision, Clicks, Impressions, CTR, Position, Notes.
 * Sort: cuts first, then reviews, then keeps.
 */
function buildDecisionCsv(pages) {
  const decisionOrder = { cut: 0, review: 1, keep: 2 };

  const sorted = [...pages].sort((a, b) => {
    const da = decisionOrder[a.decision] !== undefined ? decisionOrder[a.decision] : 1;
    const db = decisionOrder[b.decision] !== undefined ? decisionOrder[b.decision] : 1;
    return da - db;
  });

  function csvEscape(val) {
    const s = String(val === null || val === undefined ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const header = 'URL,Tier,Decision,Clicks,Impressions,CTR,Position,Notes';
  const rows = sorted.map(p => [
    csvEscape(p.url || p.loc || ''),
    csvEscape(p.tier     || ''),
    csvEscape(p.decision || ''),
    csvEscape(p.clicks      !== undefined ? p.clicks      : ''),
    csvEscape(p.impressions !== undefined ? p.impressions : ''),
    csvEscape(p.ctr         !== undefined ? p.ctr         : ''),
    csvEscape(p.position    !== undefined ? p.position    : ''),
    csvEscape(p.notes       || ''),
  ].join(','));

  return [header, ...rows].join('\n');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseSitemapXml,
  parseGscCsv,
  normalizeUrl,
  crossReference,
  assignTier,
  buildTierStats,
  detectUrlPatterns,
  applyDefaultDecisions,
  buildProposedSitemapXml,
  buildDecisionCsv,
};
