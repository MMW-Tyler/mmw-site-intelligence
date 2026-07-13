'use strict';

/**
 * MMW Site Intelligence — Migration Archive Importer (CLI)
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
 * in). If that's inconvenient (e.g. a host with no shell access), see
 * POST /api/admin/import-archive in server.js instead — same logic,
 * reachable over HTTP from wherever the app is already running.
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

const { validateArchive, importArchive } = require('../lib/archive-import');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args._[0];
  if (!filePath) {
    console.error('Usage: node scripts/import-migration-archive.js <path-to-archive.json> [--domain=example.com] [--name="..."] [--dry-run]');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  const archive = JSON.parse(raw);

  const posts = (archive.data && archive.data.posts) || [];
  const imageCount = posts.reduce((n, p) => n + (p.images || []).length + (p.featured_image ? 1 : 0), 0);

  console.log(`Archive: "${archive.name || '(unnamed)'}"`);
  console.log(`Source:  ${archive.source_url || '(none)'}`);
  console.log(`Posts:   ${posts.length}`);
  console.log(`Images:  ${imageCount}`);
  console.log(`Logged errors in archive: ${(archive.data && archive.data.errors || []).length}`);
  console.log('');

  const problems = validateArchive(archive);
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

  const result = await importArchive(archive, { domain: args.domain, name: args.name });
  console.log(`\nInserted migration_archives row ${result.archiveId} for client domain "${result.domain}".`);
  console.log('It will now show up in the Migrate tab\'s "Archived Migrations" panel for that client.');
}

main().catch(err => {
  console.error('Import failed:', err.message);
  if (err.problems) err.problems.forEach(p => console.error('  ✕ ' + p));
  process.exit(1);
});
