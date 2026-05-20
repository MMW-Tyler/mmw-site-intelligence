'use strict';

/**
 * MMW Site Intelligence — Migrate Analyzer
 *
 * Blog migration helpers. All functions are pure: no fetch, no DB, no fs.
 * Input is crawl_pages rows (with extracted_body/extracted_text) plus an
 * optional parsed RSS feed. Output is candidate post lists, normalized
 * HTML, image inventories, and detected metadata.
 *
 * Exports:
 *   detectBlogPosts(pages, options)         → array of candidate posts
 *   parseRssFeed(xmlString)                 → array of RSS items
 *   mergeRssWithPages(rssItems, crawlPages) → enriched page objects
 *   extractInlineImages(html)               → array of { original_url, alt, ... }
 *   rewriteImageUrls(html, urlMap)          → rewritten HTML
 *   cleanWeeblyArtifacts(html)              → cleaner HTML
 *   cleanSquarespaceArtifacts(html)         → cleaner HTML
 *   cleanWixArtifacts(html)                 → cleaner HTML
 *   cleanGodaddyArtifacts(html)             → cleaner HTML
 *   normalizePostBody(html, options)        → final WP-ready HTML
 *   buildSlug(title, fallbackUrl)           → slug string
 *   detectPlatform(siteUrl, html?)          → platform identifier
 *   pickRepresentativeSamples(pages)        → up to 3 representative pages
 *   wordCount(text)                         → integer
 *   extractPostBody(fullHtml, platform)     → inner HTML of the post body
 *   extractMetadataFromHtml(fullHtml)       → { title, h1, pub_date, author }
 */

const cheerio        = require('cheerio');
const { XMLParser }  = require('fast-xml-parser');
const sanitizeHtml   = require('sanitize-html');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_URL_PATTERNS = [
  /\/articles\//i,
  /\/blog\//i,
  /\/posts?\//i,
  /\/news\//i,
  /\/journal\//i,
  /\/insights\//i,
  /\/stories\//i,
];

const EXCLUDE_URL_PATTERNS = [
  /\/(cart|checkout|my-account|login|register|wp-login|wp-admin|wp-json|feed|xmlrpc)\/?$/i,
  /\/(contact|about|services|team|staff|location|hours|pricing|appointment|book|schedule)\/?$/i,
  /\/page\/\d+\/?$/i,
  /\/(previous|next)\/\d+\/?$/i,
  /\/(category|tag|author|archive)\//i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip)$/i,
];

const ALLOWED_TAGS = [
  'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i',
  'blockquote', 'img', 'figure', 'figcaption',
  'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

const ALLOWED_ATTR = {
  a:    ['href', 'title', 'rel'],
  img:  ['src', 'alt', 'title', 'width', 'height', 'srcset', 'sizes'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wordCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function normalizeUrl(url) {
  if (!url) return '';
  let s = String(url).trim();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\/$/, '');
  s = s.split('#')[0];
  s = s.split('?')[0];
  return s.toLowerCase();
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function absoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (_) {
    return maybeRelative;
  }
}

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform(siteUrl, samplePageHtml) {
  const url  = String(siteUrl || '').toLowerCase();
  const html = String(samplePageHtml || '').toLowerCase();

  if (url.includes('weebly.com') || html.includes('wsite-') || html.includes('weebly')) return 'weebly';
  if (html.includes('squarespace') || html.includes('sqs-block')) return 'squarespace';
  if (html.includes('wix.com')  || html.includes('_wixclibrary')  || html.includes('wix-image')) return 'wix';
  if (html.includes('godaddy')  || html.includes('go-daddy')      || html.includes('uxbuilder')) return 'godaddy';
  if (html.includes('/wp-content/') || html.includes('wp-json')   || html.includes('wordpress')) return 'wordpress';
  return 'unknown';
}

// ─── Blog post detection ──────────────────────────────────────────────────────

function detectBlogPosts(pages, options) {
  options = options || {};
  const customPatterns = Array.isArray(options.urlPatterns) ? options.urlPatterns : [];
  const urlPatterns    = customPatterns.length > 0
    ? customPatterns.map(p => p instanceof RegExp ? p : new RegExp(escapeRegex(p), 'i'))
    : DEFAULT_URL_PATTERNS;
  const minWordCount   = typeof options.minWordCount === 'number' ? options.minWordCount : 150;

  const candidates = [];

  for (const p of (pages || [])) {
    if (!p || !p.url) continue;
    const sc = p.status_code || 0;
    if (sc < 200 || sc >= 300) continue;
    if (p.indexability === 'Non-Indexable') continue;
    if (EXCLUDE_URL_PATTERNS.some(re => re.test(p.url))) continue;

    const matchesUrl = urlPatterns.some(re => re.test(p.url));
    const wc         = p.word_count || wordCount(p.extracted_text || '');
    const hasBody    = !!((p.extracted_body || '').trim());
    const hasH1      = !!((p.h1 || '').trim());

    // Score: URL pattern match alone is enough; otherwise need body content + H1 + length
    let score = 0;
    if (matchesUrl) score += 3;
    if (hasBody)    score += 1;
    if (hasH1)      score += 1;
    if (wc >= minWordCount) score += 1;

    // URL-pattern matches are trusted even when the crawler's extracted_body
    // is sparse (common with Weebly/Wix sites the extractor doesn't know).
    // The actual post HTML is fetched live during sample-test and push.
    const isCandidate = matchesUrl ? (wc >= 50)
                                    : (hasBody && hasH1 && wc >= minWordCount);
    if (!isCandidate) continue;

    const images = hasBody ? extractInlineImages(p.extracted_body || '') : [];

    candidates.push({
      url:              p.url,
      title:            (p.title || p.h1 || '').trim(),
      h1:               (p.h1 || '').trim(),
      word_count:       wc,
      image_count:      images.length,
      pub_date:         null,
      author:           null,
      category:         null,
      slug:             slugFromUrl(p.url) || buildSlug(p.title || p.h1 || '', p.url),
      rss_enriched:     false,
      default_checked:  matchesUrl,
      _extracted_body:  p.extracted_body || '',
      _score:           score,
    });
  }

  // Sort by URL pattern match first then by score desc
  candidates.sort((a, b) => (b._score - a._score) || a.url.localeCompare(b.url));
  return candidates;
}

// ─── RSS parsing ──────────────────────────────────────────────────────────────

function parseRssFeed(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return [];
  try {
    const parser = new XMLParser({
      ignoreAttributes:    false,
      attributeNamePrefix: '@_',
      cdataPropName:       '#cdata',
      trimValues:          true,
    });
    const doc = parser.parse(xmlString);

    const channel = doc && doc.rss && doc.rss.channel;
    const atom    = doc && doc.feed;
    let items     = [];

    if (channel) {
      const raw = channel.item;
      items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return items.map(it => rssItemFromChannel(it));
    }
    if (atom) {
      const raw = atom.entry;
      items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return items.map(it => atomEntryToRss(it));
    }
    return [];
  } catch (_) {
    return [];
  }
}

function readText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    if (node['#cdata']) return String(node['#cdata']);
    if (node['#text']) return String(node['#text']);
  }
  return '';
}

function rssItemFromChannel(item) {
  const title       = readText(item.title);
  const link        = readText(item.link);
  const pubDate     = readText(item.pubDate || item['dc:date'] || item.published || '');
  const author      = readText(item['dc:creator'] || item.author || '');
  const guid        = readText(item.guid || '');
  const description = readText(item.description || '');
  const contentHtml = readText(item['content:encoded'] || description);

  let categories = item.category || [];
  if (!Array.isArray(categories)) categories = categories ? [categories] : [];
  categories = categories.map(c => readText(c)).filter(Boolean);

  return {
    title:        title.trim(),
    link:         link.trim(),
    pub_date:     pubDate.trim() || null,
    author:       author.trim()  || null,
    categories,
    content_html: contentHtml,
    guid:         guid.trim() || null,
  };
}

function atomEntryToRss(entry) {
  const title = readText(entry.title);
  let link    = '';
  if (Array.isArray(entry.link)) {
    const alt = entry.link.find(l => (l['@_rel'] || 'alternate') === 'alternate');
    link = alt ? (alt['@_href'] || '') : (entry.link[0]['@_href'] || '');
  } else if (entry.link && typeof entry.link === 'object') {
    link = entry.link['@_href'] || '';
  }
  const pubDate     = readText(entry.published || entry.updated || '');
  const author      = entry.author ? readText(entry.author.name || entry.author) : '';
  const contentHtml = readText(entry.content || entry.summary || '');
  let categories    = entry.category || [];
  if (!Array.isArray(categories)) categories = categories ? [categories] : [];
  categories = categories.map(c => (c['@_term'] || readText(c))).filter(Boolean);

  return {
    title:        title.trim(),
    link:         link.trim(),
    pub_date:     pubDate.trim() || null,
    author:       author.trim()  || null,
    categories,
    content_html: contentHtml,
    guid:         readText(entry.id || '') || null,
  };
}

// ─── Merge RSS with crawl pages ───────────────────────────────────────────────

function mergeRssWithPages(rssItems, candidates) {
  if (!Array.isArray(rssItems) || rssItems.length === 0) return candidates;
  const map = new Map();
  for (const item of rssItems) {
    if (item.link) map.set(normalizeUrl(item.link), item);
  }

  return (candidates || []).map(c => {
    const item = map.get(normalizeUrl(c.url));
    if (!item) return c;
    return {
      ...c,
      title:        c.title || item.title || '',
      pub_date:     item.pub_date || c.pub_date,
      author:       item.author   || c.author,
      category:     (item.categories && item.categories[0]) || c.category,
      _rss_content: item.content_html || '',
      rss_enriched: true,
    };
  });
}

// ─── Image extraction & rewriting ─────────────────────────────────────────────

// Platform-chrome image URLs we never want to migrate — Weebly auto-inserts
// these next to PDF download links, file icons, etc. They're UI, not content.
const PLATFORM_CHROME_IMG_PATTERNS = [
  /weebly\.com\/weebly\/images\//i,
  /squarespace\.com\/static\/.*icons?\//i,
  /wix-static\.com\/.*icons?\//i,
];

function isPlatformChromeImage(src) {
  return PLATFORM_CHROME_IMG_PATTERNS.some(re => re.test(src));
}

function extractInlineImages(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src) return;
    if (src.startsWith('data:')) return;
    if (isPlatformChromeImage(src)) return;
    if (seen.has(src)) return;
    seen.add(src);
    out.push({
      original_url: src,
      alt:          $(el).attr('alt') || '',
      width:        parseInt($(el).attr('width'), 10) || null,
      height:       parseInt($(el).attr('height'), 10) || null,
    });
  });
  return out;
}

function rewriteImageUrls(html, urlMap) {
  if (!html || !urlMap) return html || '';
  const $ = cheerio.load(html, null, false);
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && urlMap[src]) $(el).attr('src', urlMap[src]);
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map(part => {
        const trimmed = part.trim();
        const [u, descriptor] = trimmed.split(/\s+/, 2);
        const mapped = urlMap[u] || u;
        return descriptor ? `${mapped} ${descriptor}` : mapped;
      }).join(', ');
      $(el).attr('srcset', rewritten);
    }
  });
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && urlMap[href]) $(el).attr('href', urlMap[href]);
  });
  return $.html();
}

// Remove a specific <img> from a body HTML by its src — used to avoid
// duplicating the featured image inside the post body. Sibling caption
// elements (e.g. "Photo by X @ Unsplash") are preserved.
function removeImageFromHtml(html, src) {
  if (!html || !src) return html || '';
  const $ = cheerio.load(html, null, false);
  $('img').each((_, el) => {
    if ($(el).attr('src') === src) $(el).remove();
  });
  return $.html();
}

// ─── Platform-specific cleaners ───────────────────────────────────────────────

function cleanWeeblyArtifacts(html) {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);

  // Drop entirely: layout-only multicol tables Weebly appends to posts (spacers
  // or boilerplate author-bio blocks). WordPress handles author bios via
  // user profile fields — they don't belong in post body.
  $('.wsite-multicol-table-wrap, .wsite-multicol-table, .wsite-multicol').remove();

  // Drop Weebly UI-chrome images (PDF icons, etc.) from the body so they don't
  // render in WP pointing back at the Weebly CDN.
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (isPlatformChromeImage(src)) $(el).remove();
  });

  // Unwrap typical Weebly container divs
  const unwrapSelectors = [
    'div.wsite-image',
    'div.wsite-multicol-col', 'div.wsite-spacer', 'div.wsite-section-content',
    'div.wsite-section-elements', 'div.paragraph', 'div.imageWrapper',
    'div.imageCaption', 'div.captioned-image-container',
  ];
  unwrapSelectors.forEach(sel => $(sel).each((_, el) => { $(el).replaceWith($(el).contents()); }));

  // Remove Twitter share residue: [](http://twitter.com/share?...) or anchors to share urls
  $('a').each((_, el) => {
    const href = ($(el).attr('href') || '').toLowerCase();
    const txt  = $(el).text().trim();
    if (href.includes('twitter.com/share') || href.includes('twitter.com/intent') ||
        href.includes('facebook.com/sharer') || href.includes('linkedin.com/share')) {
      if (txt.length < 25) $(el).remove();
    }
  });

  // "Comments are closed" + Weebly's inline comments
  $('div.wsite-com-displaying, div.wsite-com-listing, div.wsite-comments').remove();
  $('p, div').each((_, el) => {
    const t = $(el).text().trim().toLowerCase();
    if (t === 'comments are closed.' || t === 'comments are closed') $(el).remove();
  });

  // Remove empty inline color spans
  $('span').each((_, el) => {
    const style = ($(el).attr('style') || '').toLowerCase();
    if (style.includes('color:rgb(0, 0, 0)') || style.includes('color: rgb(0, 0, 0)') ||
        style.includes('color:#000') || style === '') {
      // Replace span with its contents
      $(el).replaceWith($(el).contents());
    }
  });

  // Strip empty paragraphs
  $('p').each((_, el) => {
    if (!$(el).text().trim() && $(el).find('img').length === 0) $(el).remove();
  });

  // Weebly often wraps images in href-less <a> tags (<a> <img ...></a>).
  // Unwrap them so we don't ship dead links.
  $('a').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) { $(el).replaceWith($(el).contents()); }
  });

  return $.html();
}

function cleanSquarespaceArtifacts(html) {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);
  const unwrapSelectors = [
    'div.sqs-block', 'div.sqs-block-content', 'div.sqs-block-html',
    'div.sqs-html-content', 'div.image-block-wrapper', 'div.image-block-outer-wrapper',
  ];
  unwrapSelectors.forEach(sel => $(sel).each((_, el) => { $(el).replaceWith($(el).contents()); }));
  $('div[class*="sqs-share"], div[class*="post-tags"], div[class*="post-author"]').remove();
  return $.html();
}

function cleanWixArtifacts(html) {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);
  $('[data-hook*="post-share"], [data-hook*="rating"], [data-hook*="comment"]').remove();
  $('div[class*="wix-image"]').each((_, el) => { $(el).replaceWith($(el).contents()); });
  return $.html();
}

function cleanGodaddyArtifacts(html) {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);
  $('[class*="x-share"], [class*="x-comments"]').remove();
  return $.html();
}

const PLATFORM_CLEANERS = {
  weebly:      cleanWeeblyArtifacts,
  squarespace: cleanSquarespaceArtifacts,
  wix:         cleanWixArtifacts,
  godaddy:     cleanGodaddyArtifacts,
};

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizePostBody(html, options) {
  options = options || {};
  if (!html) return '';

  const platform = options.platform || 'unknown';
  const cleaner  = PLATFORM_CLEANERS[platform];
  let working    = cleaner ? cleaner(html) : html;

  // Strip Weebly "Authored by" lines if they appear at the very top (will be set via metadata)
  // Keep the rest.

  // Sanitize with allowlist
  working = sanitizeHtml(working, {
    allowedTags:       ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTR,
    allowedSchemes:    ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      'b': 'strong',
      'i': 'em',
    },
  });

  // Whitespace cleanup: collapse multiple blank paragraphs
  working = working.replace(/(<p>\s*<\/p>\s*){2,}/g, '<p></p>');
  working = working.replace(/\s+\n/g, '\n').trim();

  return working;
}

// ─── Slug builder ─────────────────────────────────────────────────────────────

function buildSlug(title, fallbackUrl) {
  let s = String(title || '').trim().toLowerCase();
  if (!s && fallbackUrl) {
    try {
      const u = new URL(fallbackUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      s = parts[parts.length - 1] || '';
    } catch (_) {
      s = '';
    }
  }
  s = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'post';
}

// For migration, the canonical slug is whatever the source URL's last path
// segment was — that's the URL customers and search engines have always
// known, and it sidesteps cases where the crawled title was a generic
// archive fallback (e.g. "Articles | Blog | Health Blog | ...").
function slugFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return buildSlug(parts[parts.length - 1] || '', '');
  } catch (_) {
    return '';
  }
}

// ─── Extract post body from full HTML ────────────────────────────────────────
// Given a freshly-fetched source page, isolate the post body so it can be
// normalized and pushed. Pure function — caller is responsible for the fetch.

const PLATFORM_BODY_SELECTORS = {
  weebly: [
    // Most specific first — Weebly's blog template wraps each post in
    // .blog-post and the body content alone is in .blog-content.
    'div.blog-content',
    'div.blog-post',
    // Page-level fallbacks for non-blog Weebly content
    '.wsite-section-elements',
    '.wsite-section-content',
    '#wsite-content',
  ],
  wordpress: [
    '.entry-content',
    'article.post .post-content',
    'article .entry-content',
    'main article',
  ],
  squarespace: [
    '.blog-item-content',
    '.sqs-html-content',
    'article .body',
    'article',
  ],
  wix: [
    '[data-hook="post-description"]',
    '.post-content',
    'article',
  ],
  godaddy: [
    '.entry-content',
    '.post-content',
    'article',
  ],
};

const GENERIC_BODY_SELECTORS = [
  'article .entry-content',
  'article .post-content',
  '.entry-content',
  '.post-content',
  '.page-content',
  'main article',
  'article',
  'main',
  '#content',
];

const BODY_STRIP_SELECTORS = [
  'nav', 'header', 'footer', '.nav', '.header', '.footer',
  '.menu', '.site-branding', '.site-footer', '.site-header',
  '.sidebar', '.widget', '.widget-area',
  '.related-posts', '.related', '.also-read',
  '.share', '.social', '.share-buttons', '.sharedaddy',
  '.author-bio', '.post-author', '.author-box',
  '.cookie', '.popup', '.modal',
  '.breadcrumb', '.comments', '#comments', '.comment-respond',
  '.wsite-com-displaying', '.wsite-com-listing', '.wsite-comments',
  '.wsite-header', '.wsite-footer', '.wsite-nav',
  '.wsite-search-content', '.wsite-blog-aside', '.blog-sidebar',
  '#wsite-header', '#wsite-footer', '#wsite-nav',
  // Weebly blog template noise (header/title/date/social/comments/separators)
  '.blog-header', '.blog-social', '.blog-fb-like',
  '.blog-comments-bottom', '.blog-post-separator', '.blog-separator',
  '.blog-notice-comments-closed',
  '#commentArea', '.blog-comment-area', '.blogCommentWrap',
  '.blogCommentHeading', '.blogCommentText', '.blogCommentOptions',
  '.blogCommentReplyWrapper',
  // Weebly layout-only multicol tables — usually spacers or boilerplate
  // author-bio blocks appended after the actual post content.
  '.wsite-multicol-table-wrap', '.wsite-multicol-table',
  '.wsite-multicol', '.wsite-spacer',
  '.imgPusher',
  'script', 'style', 'noscript', 'iframe', 'form',
];

function extractPostBody(fullHtml, platform) {
  if (!fullHtml) return '';
  const $ = cheerio.load(fullHtml);

  // Strip universal noise first
  BODY_STRIP_SELECTORS.forEach(sel => { try { $(sel).remove(); } catch (_) {} });

  const platformSelectors = PLATFORM_BODY_SELECTORS[platform] || [];
  const all = platformSelectors.concat(GENERIC_BODY_SELECTORS);

  for (const sel of all) {
    const $el = $(sel).first();
    if ($el.length && $el.text().trim().length > 200) {
      return $el.html() || '';
    }
  }
  // Last resort: take body
  const $body = $('body').first();
  return $body.length ? ($body.html() || '') : fullHtml;
}

// ─── Extract metadata from full HTML ─────────────────────────────────────────
// Used as fallback when RSS doesn't provide title/date/author/h1.

function extractMetadataFromHtml(fullHtml) {
  if (!fullHtml) return { title: '', h1: '', pub_date: null, author: null };
  const $ = cheerio.load(fullHtml);

  // Title: og:title → Weebly .blog-title → <title>
  const blogTitle = $('.blog-title').first().text().trim();
  const title = ($('meta[property="og:title"]').attr('content') ||
                 blogTitle ||
                 $('title').text() || '').trim();

  // Prefer the H1 inside the main content area (not site-wide H1)
  let h1 = '';
  for (const sel of ['article h1', '.entry-content h1', '.post-content h1', '.wsite-section-elements h1', '.blog-title', 'main h1', 'h1']) {
    const t = $(sel).first().text().trim();
    if (t) { h1 = t; break; }
  }

  // Date: og:published_time, article:published_time, <time> tag, common meta,
  // Weebly .blog-date .date-text
  let pubDate = null;
  const dateCandidates = [
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="article:published_time"]').attr('content'),
    $('meta[property="og:published_time"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
    $('meta[name="pubdate"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('.blog-date .date-text').first().text().trim(),
    $('.blog-date').first().text().trim(),
  ].filter(Boolean);
  if (dateCandidates.length > 0) pubDate = dateCandidates[0];

  // Author: meta or .author / .byline element
  let author = $('meta[name="author"]').attr('content') ||
               $('meta[property="article:author"]').attr('content') ||
               $('.author-name, .byline, .post-author, [rel="author"]').first().text().trim() ||
               null;
  if (author) author = author.replace(/^by\s+/i, '').trim();

  return {
    title: title || h1,
    h1,
    pub_date: pubDate || null,
    author:   author || null,
  };
}

// ─── Representative sample picker ─────────────────────────────────────────────

function pickRepresentativeSamples(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const sorted = candidates.slice();

  // Sort by word_count desc; pick longest, median, and one with images (or shortest)
  const byWords = sorted.slice().sort((a, b) => (b.word_count || 0) - (a.word_count || 0));
  const withImg = sorted.slice().filter(c => (c.image_count || 0) > 0)
                                 .sort((a, b) => (b.image_count || 0) - (a.image_count || 0));

  const picks = [];
  const seen  = new Set();
  function add(p) {
    if (!p || seen.has(p.url)) return;
    seen.add(p.url);
    picks.push(p);
  }

  if (withImg[0]) add(withImg[0]);
  add(byWords[0]);
  const midIdx = Math.floor(byWords.length / 2);
  add(byWords[midIdx]);

  // Fill up to 3 from the head if needed
  for (const p of byWords) {
    if (picks.length >= 3) break;
    add(p);
  }
  return picks.slice(0, 3);
}

module.exports = {
  detectBlogPosts,
  parseRssFeed,
  mergeRssWithPages,
  extractInlineImages,
  rewriteImageUrls,
  removeImageFromHtml,
  cleanWeeblyArtifacts,
  cleanSquarespaceArtifacts,
  cleanWixArtifacts,
  cleanGodaddyArtifacts,
  normalizePostBody,
  buildSlug,
  slugFromUrl,
  detectPlatform,
  pickRepresentativeSamples,
  wordCount,
  normalizeUrl,
  absoluteUrl,
  extractPostBody,
  extractMetadataFromHtml,
  DEFAULT_URL_PATTERNS,
  EXCLUDE_URL_PATTERNS,
};
