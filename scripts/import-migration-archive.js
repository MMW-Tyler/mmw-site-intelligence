'use strict';

/**
 * MMW Site Intelligence — Migration Archive Importer
 *
 * Loads a migration archive JSON file (matching the shape documented in
 * docs/wayback-archive-format.md) and inserts it into the migration_archives
 * table, so it shows up in the Migrate tab's "Archived Migrations" panel
 * ready to Import. Built for cases where the archive was assembled outside
 * this app's live crawl flow — e.g. recovered from the Wayback Machine
 * after a site relaunch dropped the old blog content.
 *
 * Run this wherever SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are actually
 * configured for this app (its .env, or the environment it normally runs
 * in) — this sandbox does not have them.
 *
 * Usage:
 *   node scripts/import-migration-archive.js <path-to-archive.json> [options]
 *
 * Options:
 *   --domain=example.com   Client domain to attach the archive to.
 *                           Defaults to the domain in the archive's source_url.
 *                           Looks up (or creates) the client by domain — does
 *                           not touch an existing client's name/WP credentials.
 *   --name="..."            Override the archive's display name.
 *   --dry-run               Validate and print a summary; don't write to the DB.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const store   = require('../crawl/store');
const cheerio = require('cheerio');

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) args[a.slice(2)] = true;
      else args[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      args._.push(a);
    }
  }
  return args;
}

function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\/.*$/, '');
  return s;
}

// Same validation the human review pass did before handing this archive
// back — re-run here so a bad file fails loudly instead of silently
// producing broken imports later.
function validate(archive) {
  const problems = [];
  if (!archive.data || !Array.isArray(archive.data.posts)) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args._[0];
  if (!filePath) {
    console.error('Usage: node scripts/import-migration-archive.js <path-to-archive.json> [--domain=example.com] [--name="..."] [--dry-run]');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  const archive = JSON.parse(raw);

  const problems = validate(archive);
  const posts = (archive.data && archive.data.posts) || [];
  const imageCount = posts.reduce((n, p) => n + (p.images || []).length + (p.featured_image ? 1 : 0), 0);

  console.log(`Archive: "${archive.name || '(unnamed)'}"`);
  console.log(`Source:  ${archive.source_url || '(none)'}`);
  console.log(`Posts:   ${posts.length}`);
  console.log(`Images:  ${imageCount}`);
  console.log(`Logged errors in archive: ${(archive.data && archive.data.errors || []).length}`);
  console.log('');

  if (problems.length > 0) {
    console.error(`VALIDATION FAILED — ${problems.length} problem(s):`);
    problems.forEach(p => console.error('  ✕ ' + p));
    process.exit(1);
  }
  console.log('Validation passed.');

  if (args['dry-run']) {
    console.log('\n--dry-run set — not writing to the database.');
    return;
  }

  const domain = args.domain ? normalizeDomain(args.domain) : normalizeDomain(archive.source_url);
  if (!domain) {
    console.error('Could not determine a client domain — pass --domain=example.com explicitly.');
    process.exit(1);
  }
  const clientId = await store.upsertClient(domain, null);

  const archiveId = await store.createMigrationArchive({
    clientId,
    crawlId:    null, // no live crawl backs this archive
    name:       args.name || archive.name || `${domain} blog recovery`,
    sourceUrl:  archive.source_url || null,
    platform:   archive.platform || (archive.data && archive.data.platform) || 'unknown',
    postCount:  posts.length,
    imageCount,
    data:       archive.data,
  });

  console.log(`\nInserted migration_archives row ${archiveId} for client domain "${domain}".`);
  console.log('It will now show up in the Migrate tab\'s "Archived Migrations" panel for that client.');
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
