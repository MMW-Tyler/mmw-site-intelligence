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
  { url: 'a', image_count: 0, word_count: 1000 },
  { url: 'b', image_count: 5, word_count: 200  },
  { url: 'c', image_count: 1, word_count: 500  },
  { url: 'd', image_count: 0, word_count: 100  },
];
const samples = m.pickRepresentativeSamples(sampleCandidates);
ok('pickRepresentativeSamples returns 3', samples.length === 3);
ok('pickRepresentativeSamples picks one with images', samples.some(s => s.url === 'b'));
ok('pickRepresentativeSamples picks longest',          samples.some(s => s.url === 'a'));

// ─── extractPostBody / extractMetadataFromHtml ───────────────────────────────

const WEEBLY_FULL_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Acne — Acknowledging Frustration | Wellness Minneapolis</title>
  <meta property="article:published_time" content="2018-04-12T10:00:00-05:00">
  <meta name="author" content="Dr. Sara Jean Barrett">
</head>
<body>
  <div id="wsite-header" class="wsite-header"><nav>menu items here</nav></div>
  <div id="wsite-content">
    <div class="wsite-section-elements">
      <div class="paragraph"><h1>Acne: Acknowledging Frustration, Finding Solutions</h1></div>
      <div class="wsite-image"><img src="/uploads/1/3/1/0/13106539/header.jpg" alt="Acne header"></div>
      <div class="paragraph"><p>Acne is one of the most frustrating skin conditions to manage. Most patients have tried many treatments before they walk through our doors. This article explores root causes and what really helps.</p></div>
      <h2>Common root causes</h2>
      <div class="paragraph"><p>Hormonal imbalances, gut microbiome disruption, and chronic inflammation are the three big drivers we see in clinic.</p></div>
      <div class="paragraph"><p>Comments are closed.</p></div>
    </div>
  </div>
  <div id="wsite-footer"><p>© 2024 Wellness Minneapolis</p></div>
  <div class="wsite-com-displaying">Recent comments listing here</div>
</body>
</html>`;

const extractedBody = m.extractPostBody(WEEBLY_FULL_PAGE, 'weebly');
ok('extractPostBody picks Weebly content area',
   extractedBody.includes('Acne is one of the most frustrating') &&
   extractedBody.includes('Common root causes'));
ok('extractPostBody strips wsite-header / wsite-footer',
   !extractedBody.toLowerCase().includes('menu items here') &&
   !extractedBody.includes('© 2024'));
ok('extractPostBody strips wsite-com-displaying (comments listing)',
   !extractedBody.includes('Recent comments listing'));

const meta = m.extractMetadataFromHtml(WEEBLY_FULL_PAGE);
ok('extractMetadataFromHtml gets title from <title>',
   meta.title.includes('Acne'));
ok('extractMetadataFromHtml gets H1 from the post body',
   meta.h1 === 'Acne: Acknowledging Frustration, Finding Solutions');
ok('extractMetadataFromHtml reads article:published_time',
   meta.pub_date === '2018-04-12T10:00:00-05:00');
ok('extractMetadataFromHtml reads author meta',
   meta.author === 'Dr. Sara Jean Barrett');

// End-to-end: fetch-then-normalize pipeline
const e2e = m.normalizePostBody(extractedBody, { platform: 'weebly' });
ok('end-to-end: normalized HTML keeps content paragraphs',
   e2e.includes('Acne is one of the most frustrating') && e2e.includes('<h2>Common root causes</h2>'));
ok('end-to-end: normalized HTML drops "Comments are closed."',
   !e2e.toLowerCase().includes('comments are closed'));
ok('end-to-end: normalized HTML emits sanitized tags only (no div)',
   !/<div/i.test(e2e));

// ─── Weebly blog-content variant (real-world Wellness Minneapolis markup) ───

const WEEBLY_BLOG_PAGE = `<!DOCTYPE html>
<html>
<head><title>Acupuncture for Trigger Finger | Wellness Minneapolis</title></head>
<body>
  <div id="wsite-header"><nav>site menu</nav></div>
  <div id="wsite-content">
    <div id="blog-post-487609475861189751" class="blog-post">
      <div class="blog-header">
        <h2 class="blog-title"><a href="//x/articles/acupuncture-for-trigger-finger">Acupuncture for trigger finger</a></h2>
        <p class="blog-date"><span class="date-text">4/17/2015</span></p>
      </div>
      <div class="blog-separator">&nbsp;</div>
      <div class="blog-content">
        <div class="paragraph" style="text-align:left;">By Marian Kimball Eichinger, LAc</div>
        <blockquote><span style="color:rgb(160,160,160);">The patient is thrilled that she was able to treat her trigger finger without surgery.</span></blockquote>
        <div class="paragraph"><p>I would like to share my experience successfully treating trigger finger with acupuncture. After a complete round of acupuncture treatments, my patient has full use of her fingers and did not have to endure surgery and the recovery process therein.</p></div>
        <h2>What is trigger finger?</h2>
        <div class="paragraph"><p>Trigger Finger is a condition otherwise known as stenosing tenosynovitis.</p></div>
      </div>
      <div class="blog-social">
        <div class="blog-fb-like"><fb:like href="..."></fb:like></div>
        <a class="twitter-share-button" href="http://twitter.com/share?url=...">Tweet</a>
      </div>
      <div class="blog-comments-bottom"></div>
      <div class="blog-post-separator"></div>
    </div>
    <div id="commentArea">
      <div class="blog-comment-area">
        <div class="blogCommentWrap">
          <div class="blogCommentHeading"><div class="blogCommentAuthor"><span class="name">Nick G Triantafillou</span></div></div>
          <div class="blogCommentText"><p>This is a visitor comment that should NEVER end up in the migrated post body.</p></div>
        </div>
        <div class="blog-notice-comments-closed">Comments are closed.</div>
      </div>
    </div>
  </div>
  <div id="wsite-footer">© 2024 Wellness Minneapolis</div>
</body>
</html>`;

const blogBody = m.extractPostBody(WEEBLY_BLOG_PAGE, 'weebly');
ok('extractPostBody (blog-content variant) picks .blog-content',
   blogBody.includes('share my experience successfully treating trigger finger') &&
   blogBody.includes('What is trigger finger?'));
ok('extractPostBody (blog-content variant) excludes .blog-header title duplicate',
   !blogBody.includes('class="blog-title"'));
ok('extractPostBody (blog-content variant) excludes #commentArea',
   !blogBody.includes('visitor comment that should NEVER') &&
   !blogBody.toLowerCase().includes('comments are closed'));
ok('extractPostBody (blog-content variant) excludes .blog-social',
   !blogBody.toLowerCase().includes('twitter.com/share') &&
   !blogBody.toLowerCase().includes('blog-fb-like'));

const blogMeta = m.extractMetadataFromHtml(WEEBLY_BLOG_PAGE);
ok('extractMetadataFromHtml reads .blog-title for Weebly',
   blogMeta.h1 === 'Acupuncture for trigger finger');
ok('extractMetadataFromHtml reads .blog-date for Weebly',
   (blogMeta.pub_date || '').includes('4/17/2015'));

const blogE2E = m.normalizePostBody(blogBody, { platform: 'weebly' });
ok('end-to-end (blog-content variant): keeps the post H2',
   blogE2E.includes('What is trigger finger'));
ok('end-to-end (blog-content variant): keeps the blockquote',
   blogE2E.toLowerCase().includes('<blockquote'));
ok('end-to-end (blog-content variant): all div wrappers stripped',
   !/<div/i.test(blogE2E));

// URL exclude: Weebly previous/next pagination
const paginationPages = [
  { url: 'https://x.com/articles/previous/2',  status_code: 200, indexability: 'Indexable', h1: 'archive', word_count: 17000, extracted_body: '<p>x</p>', extracted_text: 'x' },
  { url: 'https://x.com/articles/next/3',      status_code: 200, indexability: 'Indexable', h1: 'archive', word_count: 17000, extracted_body: '<p>x</p>', extracted_text: 'x' },
  { url: 'https://x.com/articles/real-post',   status_code: 200, indexability: 'Indexable', h1: 'Post',    word_count: 500,   extracted_body: '<p>x</p>', extracted_text: 'x' },
];
const paginationDetected = m.detectBlogPosts(paginationPages, { minWordCount: 100 });
ok('detectBlogPosts excludes /previous/N pagination',
   !paginationDetected.some(d => /\/previous\/\d/.test(d.url)));
ok('detectBlogPosts excludes /next/N pagination',
   !paginationDetected.some(d => /\/next\/\d/.test(d.url)));
ok('detectBlogPosts keeps the real article URL',
   paginationDetected.some(d => /real-post$/.test(d.url)));

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
