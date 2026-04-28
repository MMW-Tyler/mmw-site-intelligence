/**
 * MMW Site Intelligence — Content Extractor
 *
 * Lifted from MMW Content Scout's extractContent() with one addition:
 * we now also return `text` — the full plain-text content of the page —
 * for use by the Brand Voice analyzer. The `body` field is unchanged
 * (compressed prose, ~2800 chars max) for Scout-style content blocks.
 *
 * Exports:
 *   extractContent(html) → { headings, body, text }
 *
 *   headings: [{ tag: 'h2'|'h3', text: '...' }]
 *   body:     compressed prose (~10 paragraphs, deduplicated, noise-filtered)
 *   text:     full plain-text after stripping nav/footer/widgets/scripts
 */

'use strict';

const cheerio = require('cheerio');

const STRIP_SELECTORS = [
  'nav','header','footer','.nav','.header','.footer',
  '.menu','.site-branding','.site-footer','.site-header',
  '.sidebar','.widget','.widget-area','.widget_recent_entries',
  '.widget_recent_comments','.widget_categories','.widget_tag_cloud',
  '.recent-posts','.related-posts','.post-list','.blog-list',
  '.elementor-posts','.elementor-posts-container',
  '.elementor-widget-posts','.elementor-widget-recent-posts',
  '.elementor-widget-archive-posts',
  '[class*="recent-post"]','[class*="related-post"]',
  '[class*="blog-post"]','[class*="post-grid"]','[class*="post-card"]',
  '[class*="news-grid"]','[class*="latest-post"]',
  '.posts-grid','.post-feed','.blog-feed','.archive-list',
  '.elementor-menu-anchor','.elementor-widget-spacer',
  '.elementor-widget-divider','.elementor-widget-wp-widget-nav_menu',
  '.social','.share','.cookie','.popup','.modal',
  '.breadcrumb','.comments','#comments',
  '[class*="cookie"]','[class*="popup"]','[class*="banner"]',
  '[class*="newsletter"]','[id*="cookie"]','[id*="popup"]',
  'script','style','noscript','iframe','form',
  '.wp-block-navigation','.wp-block-site-tagline',
];

const NOISE_PATTERNS = [
  /^\s*(home|about|contact|blog|services|back to top|read more|learn more|click here|schedule|book now|call us|get started|privacy policy|terms of use|sitemap|all rights reserved)\s*$/i,
  /^[\s\|\-\•\·\*]+$/,
  /^\d{3}[-.\s]?\d{3}[-.\s]?\d{4}$/,
  /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[\s\-:]+/i,
  /^\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i,
  /^by\s+[a-z\s]+\s*\|/i,
  /^\d+\s+(min|minute)\s+read/i,
  /^(leave a comment|no comments|post navigation|previous post|next post)/i,
  /^(tags?|categories?|filed under|posted in):/i,
];

const MAX_BODY_CHARS = 2800;
const MAX_TEXT_CHARS = 12000; // cap full text per page so voice analysis stays bounded

const CONTENT_SELECTORS = [
  '.elementor-widget-text-editor .elementor-widget-container',
  '.elementor-text-editor',
  '.entry-content','.post-content','.page-content',
  '.site-content main','main .content','main article',
  'main','article.page','article','#content',
];

function extractContent(html) {
  const $ = cheerio.load(html);

  // Strip noise elements
  STRIP_SELECTORS.forEach(sel => { try { $(sel).remove(); } catch (_) {} });

  // Strip "related articles" style boxes — short article tags with dates
  $('article').each((_, el) => {
    const text = $(el).text().trim();
    const hasDate = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i.test(text);
    if (hasDate && text.split(/\s+/).length < 200) $(el).remove();
  });

  // Headings (H2/H3 only — H1 is captured separately by the engine)
  const headings = [];
  const seenH = new Set();
  $('h2, h3').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (!text || text.length < 4 || text.length > 100) return;
    if (seenH.has(text)) return;
    if (/^(recent|related|latest|popular|you may also|more from|read also)/i.test(text)) return;
    seenH.add(text);
    headings.push({ tag: el.tagName.toLowerCase(), text });
  });

  // Find main content container
  let $content = null;
  for (const sel of CONTENT_SELECTORS) {
    if ($(sel).length) { $content = $(sel).first(); break; }
  }
  if (!$content) $content = $('body');

  // Compressed body — paragraphs + list items, deduplicated, noise-filtered
  const seen = new Set();
  const paragraphs = [];
  let totalChars = 0;

  $content.find('p, li').each((_, el) => {
    if (totalChars >= MAX_BODY_CHARS) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 30) return;
    if (text.split(' ').length < 6) return;
    if (NOISE_PATTERNS.some(p => p.test(text))) return;
    if (seen.has(text)) return;
    const linkDensity = $(el).find('a').length / Math.max(1, text.split(' ').length);
    if (linkDensity > 0.3) return;
    seen.add(text);
    const chunk = text.slice(0, 400);
    paragraphs.push(chunk);
    totalChars += chunk.length;
  });

  const body = paragraphs.slice(0, 10).join('\n\n');

  // Full text (for voice analysis) — same content area, less aggressive trimming
  let text = $content.text()
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  return { headings, body, text };
}

module.exports = { extractContent, STRIP_SELECTORS, NOISE_PATTERNS };
