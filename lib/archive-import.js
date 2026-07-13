'use strict';

/**
 * MMW Site Intelligence — Migration Archive Import (shared logic)
 *
 * Validates and inserts a migration archive JSON (the shape documented in
 * docs/wayback-archive-format.md) into migration_archives. Used by both the
 * CLI importer (scripts/import-migration-archive.js) and the token-gated
 * HTTP endpoint (POST /api/admin/import-archive in server.js) — kept here
 * once so the two never drift.
 */

const cheerio = require('cheerio');
const store   = require('../crawl/store');

/**
 * Re-checks the invariants the archive format relies on: required fields,
 * unique slugs, and the byte-for-byte match between each <img src> in a
 * post's html and its images[]/featured_image record. Returns an array of
 * human-readable problem strings — empty means the archive is safe to import.
 */
function validateArchive(archive) {
  const problems = [];
  if (!archive || !archive.data || !Array.isArray(archive.data.posts)) {
    problems.push('data.posts is missing or not an array');
    return problems;
  }

  const slugSeen = new Map();
  archive.data.posts.forEach((p, i) => {
    const label = `posts[${i}] (${p.url || 'no url'})`;
    ['url', 'title', 'slug', 'html'].forEach(f => {
      if (!p[f]) problems.push(`${label}: missing required field "${f}"`);
    });
    if (p.slug) {
      if (slugSeen.has(p.slug)) problems.push(`${label}: duplicate slug "${p.slug}" (also posts[${slugSeen.get(p.slug)}])`);
      slugSeen.set(p.slug, i);
    }

    const $ = cheerio.load(p.html || '', null, false);
    const srcsInHtml = new Set();
    $('img').each((_, el) => { const s = $(el).attr('src'); if (s) srcsInHtml.add(s); });

    const recorded = new Set((p.images || []).map(img => img.original_url));
    if (p.featured_image && srcsInHtml.has(p.featured_image.original_url)) {
      problems.push(`${label}: featured_image still appears as an <img> in html (should have been stripped)`);
    }
    srcsInHtml.forEach(src => {
      const isFeatured = p.featured_image && p.featured_image.original_url === src;
      if (!recorded.has(src) && !isFeatured) {
        problems.push(`${label}: <img src="${src}"> has no matching images[] entry — would stay broken after import`);
      }
    });

    (p.images || []).forEach((img, j) => {
      const l = `${label} images[${j}]`;
      if (!img.original_url || !img.filename || !img.mime_type || !img.data_base64) {
        problems.push(`${l}: missing a required field`);
      }
      if (img.data_base64 && img.data_base64.startsWith('data:')) {
        problems.push(`${l}: data_base64 has a "data:" prefix (should be raw base64)`);
      }
    });
    if (p.featured_image) {
      const f = p.featured_image;
      if (!f.original_url || !f.filename || !f.mime_type || !f.data_base64) {
        problems.push(`${label} featured_image: missing a required field`);
      }
      if (f.data_base64 && f.data_base64.startsWith('data:')) {
        problems.push(`${label} featured_image: data_base64 has a "data:" prefix (should be raw base64)`);
      }
    }
  });
  return problems;
}

/**
 * Validates, then inserts the archive into migration_archives.
 * Throws (with a `problems` array attached) if validation fails.
 *
 * @param {Object} archive - { name, source_url, platform, data: { posts, errors } }
 * @param {Object} [opts]
 * @param {string} [opts.domain] - overrides the client domain derived from archive.source_url
 * @param {string} [opts.name] - overrides archive.name
 * @returns {{ archiveId: string, domain: string, postCount: number, imageCount: number }}
 */
async function importArchive(archive, opts) {
  opts = opts || {};
  const problems = validateArchive(archive);
  if (problems.length > 0) {
    const err = new Error(`Archive validation failed with ${problems.length} problem(s)`);
    err.problems = problems;
    throw err;
  }

  const posts = archive.data.posts;
  const imageCount = posts.reduce((n, p) => n + (p.images || []).length + (p.featured_image ? 1 : 0), 0);

  const domain = store.normalizeDomain(opts.domain || archive.source_url);
  if (!domain) {
    const err = new Error('Could not determine a client domain — pass domain explicitly.');
    err.problems = [];
    throw err;
  }

  const clientId = await store.upsertClient(domain, null);
  const archiveId = await store.createMigrationArchive({
    clientId,
    crawlId:    null, // no live crawl backs this archive
    name:       opts.name || archive.name || `${domain} blog recovery`,
    sourceUrl:  archive.source_url || null,
    platform:   archive.platform || archive.data.platform || 'unknown',
    postCount:  posts.length,
    imageCount,
    data:       archive.data,
  });

  return { archiveId, domain, postCount: posts.length, imageCount };
}

module.exports = { validateArchive, importArchive };
