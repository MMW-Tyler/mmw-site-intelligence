'use strict';

/**
 * MMW Site Intelligence — Schema Analyzer
 *
 * Provides:
 *   detectPageType(url, siteUrl)          → string
 *   buildBreadcrumb(url, siteUrl)         → JSON-LD object | null
 *   extractExistingTypes(schemasObj)      → string[]
 *   preparePageContext(page, siteUrl)     → enriched page object for Claude
 *
 * BreadcrumbList is generated deterministically here (no Claude needed).
 * All other schema types go through analyzers/schema.js → Claude via schema-gap.js prompt.
 *
 * Pure functions — no DB access, no I/O.
 */

// ─── Page type detection ──────────────────────────────────────────────────────

const SERVICE_PATTERNS = [
  /\/(services?|treatments?|procedures?|therapies?|injectables?|fillers?|botox|laser|skin|body|facial|wellness|weight)(\/|$)/i,
];

const ABOUT_PATTERNS  = [ /\/about(\/|$)/i, /\/our-team(\/|$)/i, /\/meet-the(\/|$)/i, /\/staff(\/|$)/i ];
const BLOG_PATTERNS   = [ /\/(blog|news|articles?|posts?)\//i ];
const CONTACT_PATTERNS = [ /\/(contact|location|find-us|directions?)(\/|$)/i ];
const LEGAL_PATTERNS  = [ /\/(privacy|terms|legal|disclaimer|cookie|accessibility)(\/|$)/i ];
const FAQ_PATTERNS    = [ /\/(faq|faqs|frequently-asked)(\/|$)/i ];
const PROVIDER_PATTERNS = [ /\/(team|providers?|doctors?|physicians?|staff|our-doctor)(\/|$)/i ];

function detectPageType(url, siteUrl) {
  let path;
  try { path = new URL(url).pathname; } catch (_) { return 'general'; }

  const cleanSite = (siteUrl || '').replace(/\/$/, '');
  const cleanUrl  = url.replace(/\/$/, '');
  if (cleanUrl === cleanSite || path === '/') return 'homepage';

  if (LEGAL_PATTERNS.some(r  => r.test(path))) return 'legal';
  if (CONTACT_PATTERNS.some(r => r.test(path))) return 'contact';
  if (FAQ_PATTERNS.some(r    => r.test(path))) return 'faq';
  if (PROVIDER_PATTERNS.some(r => r.test(path))) return 'provider';
  if (ABOUT_PATTERNS.some(r  => r.test(path))) return 'about';
  if (BLOG_PATTERNS.some(r   => r.test(path))) return 'blog_post';
  if (SERVICE_PATTERNS.some(r => r.test(path))) return 'service';

  // Heuristic: paths with 2+ segments and no obvious category → likely a service
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2) return 'service';

  return 'general';
}

// ─── BreadcrumbList (deterministic) ───────────────────────────────────────────

/**
 * Generate a BreadcrumbList schema from a URL path.
 * Returns null for homepages (no breadcrumb needed).
 *
 * Example: https://example.com/services/botox/ →
 *   Home > Services > Botox
 */
function buildBreadcrumb(url, siteUrl) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null; // homepage

  const origin = parsed.origin;
  const items  = [
    {
      '@type':    'ListItem',
      position:   1,
      name:       'Home',
      item:       origin + '/',
    },
  ];

  let pathSoFar = '';
  segments.forEach((seg, i) => {
    pathSoFar += '/' + seg;
    const name  = seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const entry = {
      '@type':  'ListItem',
      position: i + 2,
      name,
    };
    // Last segment doesn't need an item URL (current page)
    if (i < segments.length - 1) {
      entry.item = origin + pathSoFar + '/';
    }
    items.push(entry);
  });

  return {
    '@context':       'https://schema.org',
    '@type':          'BreadcrumbList',
    itemListElement:  items,
  };
}

// ─── Extract existing schema types from WP plugin scan result ─────────────────

/**
 * Given the schemas object returned by the WP plugin's GET /schema/{post_id},
 * extract the @type strings so Claude knows what's already present.
 *
 * The plugin returns: { 'rank_math_schema_mmw_abc': { '@type': 'FAQPage', metadata: {...}, ... }, ... }
 */
function extractExistingTypes(schemasObj) {
  if (!schemasObj || typeof schemasObj !== 'object') return [];
  return Object.values(schemasObj)
    .map(s => s && (s['@type'] || (s.metadata && s.metadata.title)))
    .filter(Boolean);
}

// ─── Prepare page context for Claude ─────────────────────────────────────────

/**
 * Enrich a crawl_pages row with page_type and existing_schema_types
 * so it's ready to send to Claude via schema-gap.js prompt.
 *
 * @param {Object} page     — crawl_pages row (url, title, h1, extracted_body, extracted_text)
 * @param {string} siteUrl  — e.g. 'https://example.com'
 * @param {Object} [scan]   — result from wp.getSchemas for this post (optional)
 * @returns {Object}
 */
function preparePageContext(page, siteUrl, scan) {
  return {
    ...page,
    page_type:             detectPageType(page.url, siteUrl),
    existing_schema_types: scan ? extractExistingTypes(scan.schemas) : [],
  };
}

module.exports = { detectPageType, buildBreadcrumb, extractExistingTypes, preparePageContext };
