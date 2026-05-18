'use strict';

/**
 * Lightweight sanity tests for analyzers/migrate.js
 * Run: node analyzers/migrate.test.js
 *
 * Not Jest — just a script that exercises the pure functions against
 * a handful of canned fixtures. Prints PASS/FAIL summaries. Designed
 * as cheap insurance before each deploy.
 */

const m = require('./migrate');

let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else      { failed++; console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}

// ─── Fixture: Weebly post ────────────────────────────────────────────────────

const WEEBLY_HTML = `
<div class="wsite-section-content">
  <div class="wsite-section-elements">
    <div class="paragraph">
      <p><span style="color:rgb(0, 0, 0)">Authored by <a href="/team/dr-barrett">Dr. Barrett</a></span></p>
    </div>
    <div class="wsite-image">
      <img src="/uploads/1/3/1/0/13106539/header.jpg" alt="Wellness header">
    </div>
    <div class="paragraph">
      <p><span style="color:rgb(0, 0, 0)">In our practice we have long believed that the body has remarkable capacity to heal itself when given the right support. We see this every day in our patients.</span></p>
    </div>
    <h2>Why integrative care matters</h2>
    <div class="paragraph">
      <p>Integrative care brings together conventional medicine and evidence-based complementary therapies.</p>
    </div>
    <p>[<a href="http://twitter.com/share?url=https://example.com/article">Tweet</a>]</p>
    <p>Comments are closed.</p>
  </div>
</div>
`;

const cleaned   = m.cleanWeeblyArtifacts(WEEBLY_HTML);
ok('cleanWeeblyArtifacts removes wsite-image div wrapper',
   !cleaned.includes('class="wsite-image"'),
   cleaned.slice(0, 200));
ok('cleanWeeblyArtifacts removes twitter share residue',
   !cleaned.toLowerCase().includes('twitter.com/share'));
ok('cleanWeeblyArtifacts removes "Comments are closed."',
   !cleaned.toLowerCase().includes('comments are closed'));
ok('cleanWeeblyArtifacts preserves H2 heading',
   cleaned.includes('Why integrative care matters'));
ok('cleanWeeblyArtifacts unwraps inline color span (text preserved)',
   cleaned.includes('Authored by') && cleaned.includes('Dr. Barrett'));

const normalized = m.normalizePostBody(WEEBLY_HTML, { platform: 'weebly' });
ok('normalizePostBody emits sanitized output for Weebly',
   normalized.includes('<h2>') && normalized.includes('<p>') && !normalized.includes('<div'),
   normalized.slice(0, 200));
ok('normalizePostBody keeps img tag',
   normalized.includes('<img'));

const imgs = m.extractInlineImages(WEEBLY_HTML);
ok('extractInlineImages finds the header image',
   imgs.length === 1 && imgs[0].original_url === '/uploads/1/3/1/0/13106539/header.jpg');

const rewritten = m.rewriteImageUrls(
  '<p><img src="/uploads/1/3/1/0/13106539/header.jpg" alt="x"></p>',
  { '/uploads/1/3/1/0/13106539/header.jpg': 'https://wp.example.com/wp-content/uploads/2024/01/header.jpg' }
);
ok('rewriteImageUrls swaps image src',
   rewritten.includes('wp.example.com/wp-content/uploads/2024/01/header.jpg'));

// ─── Fixture: WordPress RSS ──────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Wellness Minneapolis</title>
    <link>https://www.wellnessminneapolis.com/</link>
    <item>
      <title>Why we love integrative medicine</title>
      <link>https://www.wellnessminneapolis.com/articles/why-we-love</link>
      <pubDate>Wed, 04 Sep 2024 14:30:00 -0500</pubDate>
      <dc:creator>Dr. Barrett</dc:creator>
      <category>Integrative Medicine</category>
      <category>Wellness</category>
      <guid>https://www.wellnessminneapolis.com/articles/why-we-love</guid>
      <description>A short summary.</description>
      <content:encoded><![CDATA[<p>The full HTML body.</p>]]></content:encoded>
    </item>
    <item>
      <title>Sleep tips</title>
      <link>https://www.wellnessminneapolis.com/articles/sleep-tips</link>
      <pubDate>Mon, 10 Jun 2024 09:00:00 -0500</pubDate>
      <dc:creator>Dr. Aidanne</dc:creator>
      <category>Sleep</category>
    </item>
  </channel>
</rss>`;

const rssItems = m.parseRssFeed(RSS_XML);
ok('parseRssFeed returns 2 items', rssItems.length === 2, JSON.stringify(rssItems).slice(0, 200));
ok('parseRssFeed extracts title',
   rssItems[0] && rssItems[0].title === 'Why we love integrative medicine');
ok('parseRssFeed extracts author from dc:creator',
   rssItems[0] && rssItems[0].author === 'Dr. Barrett');
ok('parseRssFeed extracts categories array',
   rssItems[0] && Array.isArray(rssItems[0].categories) && rssItems[0].categories.includes('Wellness'));
ok('parseRssFeed extracts content:encoded',
   rssItems[0] && rssItems[0].content_html.includes('full HTML body'));
ok('parseRssFeed handles missing content_html',
   rssItems[1] && rssItems[1].title === 'Sleep tips');

ok('parseRssFeed returns [] on malformed input', m.parseRssFeed('not xml at all').length === 0);
ok('parseRssFeed returns [] on null',            m.parseRssFeed(null).length === 0);

// ─── mergeRssWithPages ───────────────────────────────────────────────────────

const candidates = [
  { url: 'https://www.wellnessminneapolis.com/articles/why-we-love', title: '', word_count: 600 },
  { url: 'https://www.wellnessminneapolis.com/articles/sleep-tips/', title: 'Sleep', word_count: 400 },
  { url: 'https://www.wellnessminneapolis.com/contact',              title: 'Contact', word_count: 50 },
];
const merged = m.mergeRssWithPages(rssItems, candidates);
ok('mergeRssWithPages enriches matching URL',
   merged[0].rss_enriched === true && merged[0].author === 'Dr. Barrett' &&
   merged[0].category === 'Integrative Medicine');
ok('mergeRssWithPages handles trailing-slash mismatch',
   merged[1].rss_enriched === true && merged[1].author === 'Dr. Aidanne');
ok('mergeRssWithPages leaves unmatched pages alone',
   merged[2].rss_enriched !== true);

// ─── detectBlogPosts ─────────────────────────────────────────────────────────

const pages = [
  { url: 'https://example.com/articles/post-one',     status_code: 200, indexability: 'Indexable', h1: 'Post one',  word_count: 400, extracted_body: '<p>Content here</p>', extracted_text: 'Content here' },
  { url: 'https://example.com/articles/post-two/',    status_code: 200, indexability: 'Indexable', h1: 'Post two',  word_count: 250, extracted_body: '<p>x</p>',           extracted_text: 'x' },
  { url: 'https://example.com/about',                  status_code: 200, indexability: 'Indexable', h1: 'About',    word_count: 500, extracted_body: '<p>about</p>',       extracted_text: 'about' },
  { url: 'https://example.com/contact',                status_code: 200, indexability: 'Indexable', h1: 'Contact',  word_count: 200, extracted_body: '<p>x</p>',           extracted_text: 'x' },
  { url: 'https://example.com/page/2',                 status_code: 200, indexability: 'Indexable', h1: 'List',     word_count: 800, extracted_body: '<p>list</p>',        extracted_text: 'list' },
  { url: 'https://example.com/articles/bad',           status_code: 404, indexability: 'Indexable', h1: 'Gone',     word_count: 0,   extracted_body: '',                   extracted_text: '' },
];
const detected = m.detectBlogPosts(pages, { minWordCount: 150 });
const detectedUrls = detected.map(d => d.url);
ok('detectBlogPosts includes /articles/ posts',
   detectedUrls.includes('https://example.com/articles/post-one') &&
   detectedUrls.includes('https://example.com/articles/post-two/'));
ok('detectBlogPosts excludes /about, /contact, paginated, error pages',
   !detectedUrls.some(u => /\/about|\/contact|\/page\/2|\/bad$/.test(u)));
ok('detectBlogPosts sets default_checked true when URL pattern matches',
   detected.every(d => d.url.match(/\/articles\//) ? d.default_checked : true));

// ─── buildSlug ───────────────────────────────────────────────────────────────

ok('buildSlug normalizes title',          m.buildSlug('Why We Love Integrative Medicine!')      === 'why-we-love-integrative-medicine');
ok('buildSlug strips quotes',             m.buildSlug("It’s a great day")                   === 'it-s-a-great-day' || m.buildSlug("It’s a great day").startsWith('it'));
ok('buildSlug falls back to URL last seg', m.buildSlug('', 'https://example.com/articles/cool/')  === 'cool');
ok('buildSlug never returns empty',       m.buildSlug('', '')                                      === 'post');

// ─── detectPlatform ──────────────────────────────────────────────────────────

ok('detectPlatform → weebly from URL',     m.detectPlatform('https://x.weebly.com')               === 'weebly');
ok('detectPlatform → squarespace from HTML', m.detectPlatform('https://x.com', '<div class="sqs-block">x</div>') === 'squarespace');
ok('detectPlatform → wordpress from HTML',  m.detectPlatform('https://x.com', '<link href="/wp-content/themes/x.css">') === 'wordpress');
ok('detectPlatform → unknown',              m.detectPlatform('https://x.com', '<div>nothing</div>') === 'unknown');

// ─── pickRepresentativeSamples ───────────────────────────────────────────────

const sampleCandidates = [
  { url: 'a', image_count: 0, word_count: 1000, _extracted_body: '<p>x</p>' },
  { url: 'b', image_count: 5, word_count: 200,  _extracted_body: '<p>x</p>' },
  { url: 'c', image_count: 1, word_count: 500,  _extracted_body: '<h2>x</h2><ul><li>x</li></ul><blockquote>x</blockquote>' },
  { url: 'd', image_count: 0, word_count: 100,  _extracted_body: '<p>x</p>' },
];
const samples = m.pickRepresentativeSamples(sampleCandidates);
ok('pickRepresentativeSamples returns 3', samples.length === 3);
ok('pickRepresentativeSamples picks the most images',
   samples.some(s => s.url === 'b'));
ok('pickRepresentativeSamples picks longest',
   samples.some(s => s.url === 'a'));
ok('pickRepresentativeSamples picks most complex',
   samples.some(s => s.url === 'c'));

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
