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

// Weebly image wrappers — unwrap href-less <a> around images, strip multicol layout tables
const WEEBLY_AUTHOR_BIO_TAIL = `
<div class="paragraph"><p>Real post content goes here and survives.</p></div>
<hr style="visibility:hidden;">
<div class="wsite-multicol-table-wrap"><table class="wsite-multicol-table"><tbody><tr>
  <td class="wsite-multicol-col">
    <div class="wsite-image"><a> <img src="/uploads/x/author.jpg" alt="Picture"> </a></div>
  </td>
  <td class="wsite-multicol-col">
    <div class="paragraph">Dr. Barrett believes that effective healthcare is a collaborative partnership. This is boilerplate author bio that should NOT be migrated as post body.</div>
  </td>
</tr></tbody></table></div>`;

const HREFLESS_LINK_AROUND_IMG = `
<div class="wsite-image"><a> <img src="/uploads/x.jpg" alt="alt"> </a></div>
<div class="paragraph">More text after image.</div>
`;
const cleanedHrefless = m.cleanWeeblyArtifacts(HREFLESS_LINK_AROUND_IMG);
ok('cleanWeeblyArtifacts unwraps href-less <a> around images',
   !/<a[^>]*>\s*<img/i.test(cleanedHrefless) && cleanedHrefless.includes('<img'));

const normalizedTail = m.normalizePostBody(WEEBLY_AUTHOR_BIO_TAIL, { platform: 'weebly' });
ok('normalizePostBody keeps the real post text', normalizedTail.includes('Real post content goes here'));
ok('normalizePostBody strips wsite-multicol author-bio block',
   !normalizedTail.includes('boilerplate author bio') &&
   !/<table/.test(normalizedTail));
ok('normalizePostBody final HTML has no empty <a>',
   !/<a>\s*<\/a>|<a>\s*<img/.test(normalizedTail));

// removeImageFromHtml — used to drop the featured image from the body so
// WordPress doesn't render it twice. Caption text must be preserved.
const BODY_WITH_FEATURED = `
<div class="wsite-image">
  <a> <img src="/uploads/hero.jpg" alt="Hero"> </a>
  <div style="font-size:90%">Photo by Kelly Sikkema on Unsplash</div>
</div>
<p>The actual post starts here. <img src="/uploads/inline.jpg" alt="inline"></p>
`;
const stripped = m.removeImageFromHtml(BODY_WITH_FEATURED, '/uploads/hero.jpg');
ok('removeImageFromHtml drops the matching <img>',
   !stripped.includes('hero.jpg'));
ok('removeImageFromHtml preserves the caption text next to the dropped image',
   stripped.includes('Photo by Kelly Sikkema on Unsplash'));
ok('removeImageFromHtml leaves other inline images alone',
   stripped.includes('inline.jpg'));
ok('removeImageFromHtml is a no-op when src is null',
   m.removeImageFromHtml(BODY_WITH_FEATURED, null) === BODY_WITH_FEATURED);

// slugFromUrl — slug derives from URL's last path segment (canonical for the
// post), so generic crawl titles don't collapse multiple posts into one.
ok('slugFromUrl returns last path segment normalized',
   m.slugFromUrl('https://www.wellnessminneapolis.com/articles/advanced-cardiac-testing-for-early-detection') ===
   'advanced-cardiac-testing-for-early-detection');
ok('slugFromUrl handles trailing slash',
   m.slugFromUrl('https://x.com/articles/post-name/') === 'post-name');
ok('slugFromUrl returns "" for invalid URL',
   m.slugFromUrl('not a url') === '' && m.slugFromUrl('') === '');
ok('slugFromUrl handles uppercase and ignores query',
   m.slugFromUrl('https://x.com/Blog/Post-Name?foo=bar') === 'post-name');

// Two posts with the same generic crawl title but different URLs get unique slugs
const ambiguousTitlePages = [
  { url: 'https://x.com/articles/advanced-cardiac-testing-for-early-detection',
    status_code: 200, indexability: 'Indexable', h1: '',
    title: 'Articles | Blog | Health Blog | Wellness Blog | Nutrition Articles',
    word_count: 1048, extracted_body: '', extracted_text: '' },
  { url: 'https://x.com/articles/back-to-school-tips-for-success-this-year',
    status_code: 200, indexability: 'Indexable', h1: '',
    title: 'Articles | Blog | Health Blog | Wellness Blog | Nutrition Articles',
    word_count: 1430, extracted_body: '', extracted_text: '' },
];
const ambig = m.detectBlogPosts(ambiguousTitlePages, { minWordCount: 100 });
const slugs = ambig.map(p => p.slug);
ok('detectBlogPosts produces unique slugs from URLs even when titles collide',
   slugs.length === 2 && new Set(slugs).size === 2,
   JSON.stringify(slugs));
ok('detectBlogPosts slug is the URL last segment, not the generic title',
   slugs.includes('advanced-cardiac-testing-for-early-detection') &&
   slugs.includes('back-to-school-tips-for-success-this-year'));

// Platform-chrome images (Weebly's PDF icon, etc.) — skipped from extraction
// AND stripped from the body
const BODY_WITH_PDF_ICON = `
<p>Read the report: <a href="/uploads/report.pdf"><img src="https://www.weebly.com/weebly/images/file_icons/pdf.png" alt="pdf"></a></p>
<p>Hero: <img src="/uploads/photo.jpg" alt="real"></p>`;
const realImgs = m.extractInlineImages(BODY_WITH_PDF_ICON);
ok('extractInlineImages skips Weebly file_icons chrome',
   realImgs.length === 1 && realImgs[0].original_url.endsWith('photo.jpg'));
const cleanedIcons = m.cleanWeeblyArtifacts(BODY_WITH_PDF_ICON);
ok('cleanWeeblyArtifacts removes Weebly UI-chrome <img>',
   !cleanedIcons.toLowerCase().includes('weebly.com/weebly/images') &&
   cleanedIcons.includes('photo.jpg'));

// pagesAsCandidates — converts crawl rows without URL-pattern filtering, so
// sample-test / push respect the user's custom selection (e.g. /drbarrettblog/)
const nonStandardPages = [
  { url: 'https://x.com/drbarrettblog/post-a', status_code: 200, indexability: 'Indexable',
    title: 'Post A', h1: 'Post A', word_count: 600, extracted_body: '', extracted_text: 'words' },
  { url: 'https://x.com/drbarrettblog/post-b', status_code: 200, indexability: 'Indexable',
    title: 'Post B', h1: 'Post B', word_count: 700, extracted_body: '', extracted_text: 'words' },
];
const cands = m.pagesAsCandidates(nonStandardPages);
ok('pagesAsCandidates keeps non-standard URLs that detectBlogPosts would drop',
   cands.length === 2);
ok('pagesAsCandidates produces sample-pick-compatible objects',
   cands[0].slug === 'post-a' && cands[1].slug === 'post-b' && cands[0].word_count === 600);

// Sanity: detectBlogPosts (defaults) DROPS these same URLs, confirming the
// reason we needed pagesAsCandidates in the first place
const droppedByDefaults = m.detectBlogPosts(nonStandardPages, { minWordCount: 1 });
ok('detectBlogPosts with default patterns drops non-standard URLs (the bug pagesAsCandidates works around)',
   droppedByDefaults.length === 0);

// ─── Elementor (WordPress) single-post template ──────────────────────────────
// Real-world shape: the post body lives in the theme-post-content widget,
// and the same template wrapper carries share buttons, an author box, a
// "Latest Post" sidebar with other posts' thumbnails, and a newsletter form.
// None of the classic WP selectors (.entry-content etc.) exist.

const ELEMENTOR_FULL_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Why Men’s Testosterone Levels Plateau | HWC of Texas</title>
  <meta property="og:title" content="Why Men’s Testosterone Levels Plateau">
  <meta property="og:image" content="https://hwcoftexas.com/wp-content/uploads/2025/07/testosterone-featured.jpg">
  <meta property="article:published_time" content="2025-07-02T10:00:00-05:00">
</head>
<body>
  <a class="skip-link screen-reader-text" href="#content">Skip to content</a>
  <main id="content">
  <div data-elementor-type="single-post" class="elementor elementor-location-single post-18019 post">
    <div class="elementor-element elementor-widget elementor-widget-heading">
      <div class="elementor-widget-container"><h6><a href="/blog/category/hormones/">Hormones</a></h6></div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-heading">
      <div class="elementor-widget-container"><h1>Why Men’s Testosterone Levels Plateau</h1></div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-post-info">
      <div class="elementor-widget-container"><ul><li><time>July 2, 2025</time></li><li>No Comments</li></ul></div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-theme-post-content">
      <div class="elementor-widget-container">
        <p>Most men do not notice it happening all at once. There is no single morning when you wake up and feel fundamentally different. Instead, it accumulates over months and years, and workouts that used to produce results begin to feel unrewarding.</p>
        <p>Understanding what is happening physiologically, and what options exist to address it, changes the conversation from resigned acceptance to informed choice.</p>
      </div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-share-buttons">
      <div class="elementor-widget-container">Share this : facebook twitter linkedin whatsapp</div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-author-box">
      <div class="elementor-widget-container"><img src="https://secure.gravatar.com/avatar/abc?s=300" alt="Picture of HWC">Hormone Wellness Center of Texas</div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-elementskit-category-list">
      <div class="elementor-widget-container"><h4>Categories</h4></div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-form">
      <div class="elementor-widget-container">Signup for our newsletter to get updated information.</div>
    </div>
    <div class="elementor-element elementor-widget elementor-widget-posts">
      <div class="elementor-widget-container">
        <h4>Latest Post</h4>
        <article class="elementor-post"><img src="https://hwcoftexas.com/wp-content/uploads/2026/07/image-1.png">
          <a href="/blog/other-post/">Why some doctors hesitate about HRT or TRT</a></article>
      </div>
    </div>
  </div>
  </main>
</body>
</html>`;

const elementorBody = m.extractPostBody(ELEMENTOR_FULL_PAGE, 'wordpress');
ok('extractPostBody (Elementor) picks the theme-post-content widget',
   elementorBody.includes('Most men do not notice it happening') &&
   elementorBody.includes('resigned acceptance to informed choice'));
ok('extractPostBody (Elementor) excludes the Latest Post sidebar',
   !elementorBody.includes('Latest Post') &&
   !elementorBody.includes('2026/07/image-1.png') &&
   !elementorBody.includes('Why some doctors hesitate'));
ok('extractPostBody (Elementor) excludes share buttons / author box / newsletter',
   !elementorBody.includes('Share this') &&
   !elementorBody.includes('gravatar.com') &&
   !elementorBody.toLowerCase().includes('newsletter'));
ok('extractPostBody (Elementor) excludes the post-info meta row',
   !elementorBody.includes('No Comments'));

const elementorMeta = m.extractMetadataFromHtml(ELEMENTOR_FULL_PAGE);
ok('extractMetadataFromHtml reads og:image as featured_image',
   elementorMeta.featured_image === 'https://hwcoftexas.com/wp-content/uploads/2025/07/testosterone-featured.jpg');
ok('extractMetadataFromHtml featured_image is null when absent',
   m.extractMetadataFromHtml(WEEBLY_BLOG_PAGE).featured_image === null);
ok('extractMetadataFromHtml (Elementor) still reads title and date',
   elementorMeta.title.includes('Testosterone') &&
   elementorMeta.pub_date === '2025-07-02T10:00:00-05:00');

// The extracted Elementor body should carry no inline images at all here —
// previously the sidebar thumbnails leaked in and the first one was wrongly
// promoted to featured image.
ok('extractInlineImages (Elementor) finds no sidebar/author images in the body',
   m.extractInlineImages(elementorBody).length === 0);

// ─── featuredImageCandidates / buildArchivedPost ─────────────────────────────
// These back the "archive now, import later" flow: freezing a blog's post
// HTML + image bytes while the source site is still up, so migration can
// finish later even if the old site has since been decommissioned.

const featCandOg = m.featuredImageCandidates(
  ELEMENTOR_FULL_PAGE, m.extractMetadataFromHtml(ELEMENTOR_FULL_PAGE),
  'https://hwcoftexas.com/blog/why-mens-testosterone-levels-plateau/');
ok('featuredImageCandidates puts og:image first when present',
   featCandOg.candidates[0].source === 'og' &&
   featCandOg.candidates[0].absUrl === 'https://hwcoftexas.com/wp-content/uploads/2025/07/testosterone-featured.jpg');
ok('featuredImageCandidates rawSrc is null when og:image has no inline duplicate',
   featCandOg.candidates[0].rawSrc === null);

const featCandInline = m.featuredImageCandidates(
  WEEBLY_FULL_PAGE, m.extractMetadataFromHtml(WEEBLY_FULL_PAGE),
  'https://www.wellnessminneapolis.com/articles/acne');
ok('featuredImageCandidates falls back to first inline image when no og:image',
   featCandInline.candidates.length === 1 && featCandInline.candidates[0].source === 'inline' &&
   featCandInline.candidates[0].rawSrc === '/uploads/1/3/1/0/13106539/header.jpg');

// Fake downloader: records what it was asked to fetch, fails on demand.
function fakeDownloader(opts) {
  opts = opts || {};
  const calls = [];
  const fn = async (absUrl) => {
    calls.push(absUrl);
    if (opts.failOn && opts.failOn.includes(absUrl)) throw new Error('simulated fetch failure');
    return { buf: Buffer.from('fake-bytes-' + absUrl), mimeType: 'image/jpeg', filename: (absUrl.split('/').pop() || 'img.jpg') };
  };
  fn.calls = calls;
  return fn;
}

// Note: this file is plain CommonJS (no top-level await), so the async
// archive-builder tests below run in an IIFE whose promise the "Summary"
// section at the bottom explicitly waits on before printing totals / exiting —
// otherwise the exit-code check would race ahead of these assertions.
const archiveTestsDone = (async () => {
  // Case 1: og:image present and downloadable — becomes featured, no inline
  // duplicate to strip (this fixture has no <img> tags in the body).
  {
    const dl = fakeDownloader();
    const post = { url: 'https://hwcoftexas.com/blog/why-mens-testosterone-levels-plateau/', title: '', pub_date: null, author: null, category: null, slug: null };
    const { record, events } = await m.buildArchivedPost(post, ELEMENTOR_FULL_PAGE, 'wordpress', dl);
    ok('buildArchivedPost (og:image case) sets featured_image from og:image',
       record.featured_image && record.featured_image.original_url ===
       'https://hwcoftexas.com/wp-content/uploads/2025/07/testosterone-featured.jpg');
    ok('buildArchivedPost (og:image case) has no inline images to strip/keep',
       record.images.length === 0);
    ok('buildArchivedPost (og:image case) emits one image_archived(featured) event',
       events.length === 1 && events[0].type === 'image_archived' && events[0].featured === true);
    ok('buildArchivedPost (og:image case) keeps the post body text',
       record.html.includes('Most men do not notice it happening'));
  }

  // Case 2: no og:image — first inline image (Weebly header) is promoted to
  // featured AND stripped from the body so it doesn't render twice.
  {
    const dl = fakeDownloader();
    const post = { url: 'https://www.wellnessminneapolis.com/articles/acne', title: '', pub_date: null, author: null, category: null, slug: null };
    const { record } = await m.buildArchivedPost(post, WEEBLY_FULL_PAGE, 'weebly', dl);
    ok('buildArchivedPost (inline-fallback case) promotes first inline image to featured',
       record.featured_image && record.featured_image.original_url.endsWith('header.jpg'));
    ok('buildArchivedPost (inline-fallback case) strips the promoted image from the body',
       !record.html.includes('header.jpg'));
    ok('buildArchivedPost (inline-fallback case) leaves no duplicate in images[]',
       record.images.length === 0);
  }

  // Case 3: og:image download fails — falls back to the first inline image
  // instead of leaving the post with no featured image.
  {
    const failUrl = 'https://hwcoftexas.com/wp-content/uploads/2025/07/testosterone-featured.jpg';
    const htmlWithBrokenOgAndInline = ELEMENTOR_FULL_PAGE.replace(
      '<div class="elementor-widget-container">\n        <p>Most men do not notice it happening all at once.',
      '<div class="elementor-widget-container">\n        <img src="/uploads/hero.jpg" alt="hero">\n        <p>Most men do not notice it happening all at once.'
    );
    const dl = fakeDownloader({ failOn: [failUrl] });
    const post = { url: 'https://hwcoftexas.com/blog/why-mens-testosterone-levels-plateau/', title: '', pub_date: null, author: null, category: null, slug: null };
    const { record, events } = await m.buildArchivedPost(post, htmlWithBrokenOgAndInline, 'wordpress', dl);
    ok('buildArchivedPost (og:image failure case) falls back to the first inline image',
       record.featured_image && record.featured_image.original_url.endsWith('hero.jpg'),
       JSON.stringify(record.featured_image));
    ok('buildArchivedPost (og:image failure case) records the og:image failure event',
       events.some(e => e.type === 'image_failed' && e.featured === true));
    ok('buildArchivedPost (og:image failure case) strips the promoted hero image from the body',
       !record.html.includes('hero.jpg'));
  }

  // Case 4: multiple inline images beyond the featured one are all kept.
  {
    const multiImgHtml = `<html><head></head><body><div class="entry-content">
      <p>Intro text with enough words to pass extraction thresholds for this fixture case.</p>
      <img src="/img/one.jpg" alt="one">
      <p>More content in between images to keep the extractor happy about body length here.</p>
      <img src="/img/two.jpg" alt="two">
    </div></body></html>`;
    const dl = fakeDownloader();
    const post = { url: 'https://example.com/blog/multi', title: 'Multi', pub_date: null, author: null, category: null, slug: null };
    const { record } = await m.buildArchivedPost(post, multiImgHtml, 'wordpress', dl);
    ok('buildArchivedPost (multi-image case) promotes the first image to featured',
       record.featured_image && record.featured_image.original_url.endsWith('one.jpg'));
    ok('buildArchivedPost (multi-image case) keeps the second image inline',
       record.images.length === 1 && record.images[0].original_url === '/img/two.jpg');
  }
})();

// ─── Summary ─────────────────────────────────────────────────────────────────

archiveTestsDone.then(() => {
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch(e => {
  console.error('Async archive-builder tests threw:', e);
  process.exit(1);
});
