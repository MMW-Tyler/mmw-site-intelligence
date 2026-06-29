/**
 * MMW Site Intelligence — Crawl Engine
 *
 * Lifted from MMW Site Auditor's crawler-engine.js (v1.4) with two changes:
 *   1. Each fetched page also runs through the content extractor (extractor.js),
 *      so we get clean prose body + headings alongside SEO metadata.
 *   2. A persistPage(pageData) callback is called as each page completes,
 *      so the server can write to Supabase incrementally rather than buffering
 *      everything in memory.
 *
 * Exports:
 *   crawl(opts, emit, persistPage) → Promise<summary>
 *
 *   opts: {
 *     targetURL, maxPages, delayMs, concurrency,
 *     htmlSitemap, noSitemap,
 *     _cancelled: () => boolean   // optional: external cancellation check
 *   }
 *   emit(eventType, data): SSE-style event emitter for live progress
 *   persistPage(pageData):  async function that writes one page row to Supabase
 *                           Called once per crawled URL. Errors here are logged
 *                           but don't halt the crawl.
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');
const path  = require('path');
const zlib  = require('zlib');
const { extractContent } = require('./extractor');

const FETCH_TIMEOUT_MS = 20000;
const FETCH_RETRIES    = 2;   // retries on connection-level failures (not HTTP errors)

const SKIP_EXT = new Set([
  '.pdf','.jpg','.jpeg','.png','.gif','.webp','.svg','.ico',
  '.mp4','.mp3','.mov','.zip','.gz','.tar',
  '.css','.js','.woff','.woff2','.ttf','.eot','.map',
]);

// A realistic desktop-Chrome UA. The previous identifying "MMW-Crawler" string
// was being blocked outright (403) by common WAFs (Wordfence/Cloudflare/Sucuri)
// on noindex / pre-launch sites, which prevented authorized first-party audits
// from running at all. A standard browser UA is the norm for SEO crawlers.
// Change this back if a client requires an identifiable crawler UA.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

async function crawl(opts, emit, persistPage) {
  const { targetURL, maxPages, delayMs, concurrency, htmlSitemap, noSitemap } = opts;
  persistPage = persistPage || (async () => {});

  let parsedStart;
  try {
    parsedStart = new url.URL(targetURL);
    if (!['http:','https:'].includes(parsedStart.protocol)) throw new Error('Bad protocol');
  } catch (e) {
    throw new Error('Invalid URL: ' + targetURL);
  }

  const baseDomain = parsedStart.hostname.replace(/^www\./, '');
  const baseOrigin = parsedStart.origin;

  // ── State ─────────────────────────────────────────────────────────────────
  const queue      = [];
  const visited    = new Set();
  const inlinkMap  = {};
  const pageBuffer = []; // for inlink finalization at end
  let crawledCount = 0;
  let activeCount  = 0;
  let sitemapSeeds = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── URL helpers ───────────────────────────────────────────────────────────

  function isSameDomain(hostname) {
    return hostname.replace(/^www\./, '') === baseDomain;
  }

  function decodeEntities(str) {
    return str
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)));
  }

  function normalizeURL(raw, base) {
    try {
      const r = new url.URL(decodeEntities(raw), base);
      if (!['http:','https:'].includes(r.protocol)) return null;
      return r.origin + r.pathname + (r.search || '');
    } catch { return null; }
  }

  // URL patterns that are never real content pages
  const SKIP_PATTERNS = [
    /\/wp-json\//i, /\/wp-admin\//i, /\/wp-includes\//i,
    /\/feed\/?$/i, /\/comments\/feed/i, /\/embed\/?$/i, /\/trackback\/?$/i,
    /[?&]format=(feed|xml|json|rss|atom)/i,
    /[?&](utm_|ref=|source=)/i,
    /\/\d{4}\/\d{2}\/\d{2}\/?$/i,
    /\/\d{4}\/\d{2}\/?$/i,
    /\/\d{4}\/?$/i,
    /^\/category\//i, /\/tag\//i, /\/author\//i,
    /\/page\/\d+\/?$/i,
    /\/category\/\d+\/\d+\/?$/i,
    /\/portfolio-items\//i, /\/attachment\//i,
    /\?p=\d+/i, /\?page_id=\d+/i,
    /\?oembed/i, /\?utm_/i,
    /\/xmlrpc\.php/i, /\/wp-cron\.php/i,
    /\/cdn-cgi\//i,
    /\/search\/?$/i,
  ];

  function isSkippableURL(pageURL) {
    try {
      const p = new url.URL(pageURL);
      return SKIP_PATTERNS.some(re => re.test(p.pathname + (p.search || '')));
    } catch { return true; }
  }

  function shouldCrawl(raw) {
    let p;
    try { p = new url.URL(raw); } catch { return false; }
    if (!isSameDomain(p.hostname)) return false;
    const ext = path.extname(p.pathname).toLowerCase();
    if (SKIP_EXT.has(ext)) return false;
    if (isSkippableURL(raw)) return false;
    const norm = p.origin + p.pathname + (p.search || '');
    return !visited.has(norm);
  }

  // ── HTML metadata helpers ─────────────────────────────────────────────────

  function countWords(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim()
      .split(' ').filter(w => w.length > 1).length;
  }

  function getTag(html, re) {
    const m = html.match(re);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  }

  function getMetaDesc(html) {
    const r1 = /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*?)["']/i;
    const r2 = /<meta[^>]+content\s*=\s*["']([^"']*?)["'][^>]+name\s*=\s*["']description["']/i;
    const m  = html.match(r1) || html.match(r2);
    return m ? m[1].trim() : '';
  }

  function getLinks(html, base) {
    const clean = html
      .replace(/<template[\s\S]*?<\/template>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '');
    const links = [];
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const val = m[1].trim();
      if (!val || val[0] === '#') continue;
      if (/^(javascript|mailto|tel|data|blob):/i.test(val)) continue;
      const n = normalizeURL(val, base);
      if (n) links.push(n);
    }
    return links;
  }

  function getH2s(html) {
    const matches = [];
    const re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, '').trim();
      if (text) matches.push(text);
    }
    return matches;
  }

  function getTitleLength(title) {
    return title.replace(/&amp;/gi,'&').replace(/&[a-z]+;/gi,'').trim().length;
  }

  function getCanonical(html) {
    const m = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i)
            || html.match(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["']canonical["']/i);
    return m ? m[1].trim() : '';
  }

  function hasCallToAction(html) {
    const lower = html.toLowerCase();
    return ['schedule','appointment','book now','book a','request appointment',
            'call us','contact us','get started','free consultation','new patient']
      .some(p => lower.includes(p));
  }

  function checkIndexable(html) {
    const r1 = /<meta[^>]+name\s*=\s*["']robots["'][^>]+content\s*=\s*["']([^"']*?)["']/i;
    const r2 = /<meta[^>]+content\s*=\s*["']([^"']*?)["'][^>]+name\s*=\s*["']robots["']/i;
    const m  = html.match(r1) || html.match(r2);
    if (m && m[1].toLowerCase().includes('noindex')) return 'Non-Indexable';
    return 'Indexable';
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  // One fetch attempt. Returns a result object; statusCode 0 + error means a
  // connection-level failure (timeout/reset/DNS) that fetchURL may retry.
  function attemptFetch(pageURL, hops) {
    hops = hops || 0;
    return new Promise((resolve) => {
      if (hops > 6) { resolve({ url: pageURL, statusCode: 310, error: 'Too many redirects' }); return; }
      let p;
      try { p = new url.URL(pageURL); } catch { resolve({ url: pageURL, statusCode: 0, error: 'Bad URL' }); return; }

      const lib  = p.protocol === 'https:' ? https : http;
      const reqOpts = {
        hostname: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        path: p.pathname + (p.search || ''),
        method: 'GET',
        headers: {
          'User-Agent':                USER_AGENT,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language':           'en-US,en;q=0.9',
          // Advertise compression like a real browser. Requesting "identity" is
          // a common bot tell that WAFs flag; we decompress the response below.
          'Accept-Encoding':           'gzip, deflate, br',
          'Cache-Control':             'no-cache',
          'Pragma':                    'no-cache',
          'Sec-Fetch-Dest':            'document',
          'Sec-Fetch-Mode':            'navigate',
          'Sec-Fetch-Site':            'none',
          'Sec-Fetch-User':            '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection':                'close',
        },
        timeout: FETCH_TIMEOUT_MS,
      };

      const req = lib.request(reqOpts, (res) => {
        const status = res.statusCode;
        if ([301,302,303,307,308].includes(status) && res.headers.location) {
          const dest = normalizeURL(res.headers.location, pageURL);
          res.resume();
          if (dest) fetchURL(dest, hops+1).then(r => resolve({ ...r, originalURL: r.originalURL || pageURL, redirectedVia: status }));
          else resolve({ url: pageURL, statusCode: status, error: 'Bad redirect' });
          return;
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        if (!ct.includes('text/html') && !ct.includes('xml') && !ct.includes('text/plain')) {
          res.resume(); resolve({ url: pageURL, statusCode: status, nonHTML: true, contentType: ct }); return;
        }
        const enc    = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          chunks.push(c);
          size += c.length;
          if (size > 8 * 1024 * 1024) res.destroy();
        });
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          try {
            if (enc === 'gzip')      buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br')      buf = zlib.brotliDecompressSync(buf);
          } catch (e) {
            resolve({ url: pageURL, statusCode: status, error: 'Decompress failed: ' + e.message }); return;
          }
          resolve({ url: pageURL, statusCode: status, body: buf.toString('utf8'), contentType: ct });
        });
        res.on('error', e => resolve({ url: pageURL, statusCode: 0, error: e.message }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ url: pageURL, statusCode: 0, error: 'Timeout' }); });
      req.on('error', e => resolve({ url: pageURL, statusCode: 0, error: e.message }));
      req.end();
    });
  }

  // Fetch with retries on connection-level failures. HTTP responses (incl. 4xx
  // and 5xx) are returned as-is and never retried — only socket resets, DNS
  // errors, and timeouts, which WAFs and flaky hosts often throw on first hit.
  async function fetchURL(pageURL, hops) {
    let res;
    for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
      res = await attemptFetch(pageURL, hops);
      const retryable = res.statusCode === 0 && res.error && res.error !== 'Bad URL';
      if (!retryable || attempt === FETCH_RETRIES) return res;
      await sleep(600 * (attempt + 1));
    }
    return res;
  }

  // ── Sitemaps ──────────────────────────────────────────────────────────────

  function parseXMLSitemapURLs(xml) {
    const urls = [];
    const re = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
    return urls;
  }

  async function fetchXMLSitemap(sitemapURL, depth) {
    depth = depth || 0;
    if (depth > 4) return [];
    const res = await fetchURL(sitemapURL);
    if (!res.body) {
      // Surface why a (possibly nested) sitemap could not be read, instead of
      // silently dropping it — this is the usual cause of "0 URLs parsed".
      const reason = res.error ? res.error
                   : res.statusCode >= 400 ? `HTTP ${res.statusCode}`
                   : res.nonHTML ? `unexpected content-type ${res.contentType || '?'}`
                   : 'empty response';
      emit('log', { message: `  Sitemap not read: ${sitemapURL} (${reason})` });
      return [];
    }
    const locs = parseXMLSitemapURLs(res.body);
    const out  = [];
    for (const loc of locs) {
      let isSub = false;
      try {
        const lp = new url.URL(loc);
        if (lp.pathname.endsWith('.xml') || lp.pathname.toLowerCase().includes('sitemap')) {
          if (isSameDomain(lp.hostname)) { out.push(...await fetchXMLSitemap(loc, depth+1)); isSub = true; }
        }
      } catch {}
      if (!isSub) out.push(loc);
    }
    return out;
  }

  async function seedFromHTMLPage(pageURL) {
    emit('log', { message: `Seeding from HTML sitemap: ${pageURL}` });
    const res = await fetchURL(pageURL);
    if (!res.body) { emit('log', { message: 'Could not fetch HTML sitemap page' }); return 0; }
    const base  = res.url || pageURL;
    const links = getLinks(res.body, base);
    const internal = links.filter(l => {
      try { return isSameDomain(new url.URL(l).hostname) && !isSkippableURL(l); }
      catch { return false; }
    });
    const unique = [...new Set(internal)];
    let queued = 0;
    unique.forEach(u => {
      const n = normalizeURL(u, baseOrigin);
      if (n && !visited.has(n)) { queue.push(n); queued++; }
    });
    emit('log', { message: `HTML sitemap: ${unique.length} links found, ${queued} queued` });
    return unique.length;
  }

  // Seed from a user-supplied sitemap URL, auto-detecting format.
  //   - XML sitemaps (incl. sitemap-index files): parse <loc> entries, follow
  //     nested sitemaps. This is what most sites expose at /sitemap.xml.
  //   - HTML sitemap pages: extract anchor links.
  // Returns the number of URLs queued. Logs the fetch status so a 403/blocked
  // sitemap (common on noindex / pre-launch sites behind a WAF) is visible.
  async function seedFromSitemapURL(sitemapURL) {
    emit('log', { message: `Seeding from sitemap: ${sitemapURL}` });
    const res = await fetchURL(sitemapURL);

    if (res.error) { emit('log', { message: `Sitemap fetch failed: ${res.error}` }); return 0; }
    if (res.statusCode >= 400) {
      emit('log', { message: `Sitemap returned HTTP ${res.statusCode}. The server may be blocking the crawler, so URLs from it cannot be read.` });
    }
    if (!res.body) { emit('log', { message: 'Sitemap response had no body to parse' }); return 0; }

    const body     = res.body;
    const base     = res.url || sitemapURL;
    emit('log', { message: `Sitemap fetched: HTTP ${res.statusCode}, content-type ${res.contentType || '?'}, ${body.length} bytes` });

    // A WAF challenge/interstitial is served as HTML with status 200 or 403/503.
    // Detect it so the user knows the host is gating bots, not that the sitemap
    // is empty.
    if (/just a moment|cf-browser-verification|attention required|enable javascript and cookies|captcha-bypass|_cf_chl/i.test(body)) {
      emit('log', { message: 'Sitemap response looks like a bot-protection challenge page (Cloudflare/WAF). The host is blocking automated requests.' });
      return 0;
    }

    const looksXML = /<\s*(urlset|sitemapindex)[\s>]/i.test(body) || /<loc>\s*https?:\/\//i.test(body);

    let candidates;
    if (looksXML) {
      // fetchXMLSitemap walks nested sitemap-index files and returns page URLs.
      candidates = await fetchXMLSitemap(sitemapURL);
      emit('log', { message: `Detected XML sitemap: ${candidates.length} URLs parsed (including nested sitemaps)` });
    } else {
      candidates = getLinks(body, base);
      emit('log', { message: `Treating as HTML sitemap: ${candidates.length} links found` });
    }

    const internal = candidates.filter(l => {
      try { return isSameDomain(new url.URL(l).hostname) && !isSkippableURL(l); }
      catch { return false; }
    });
    const unique = [...new Set(internal)];
    let queued = 0;
    unique.forEach(u => {
      const n = normalizeURL(u, baseOrigin);
      if (n && !visited.has(n)) { queue.push(n); queued++; }
    });

    if (candidates.length > 0 && unique.length === 0) {
      emit('log', { message: `All ${candidates.length} sitemap URLs were off-domain (not ${baseDomain}) or matched skip rules. Check that the Target URL domain matches the sitemap.` });
    }
    emit('log', { message: `Sitemap seeding: ${unique.length} internal URLs, ${queued} queued` });
    return queued;
  }

  async function discoverAndSeed(origin) {
    const candidates = [];
    try {
      const robots = await fetchURL(`${origin}/robots.txt`);
      if (robots.body) {
        const re = /^Sitemap:\s*(https?:\/\/\S+)/gim;
        let m;
        while ((m = re.exec(robots.body)) !== null) candidates.push(m[1].trim());
      }
    } catch {}
    candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemaps/sitemap.xml`);

    let xmlFound = false;
    for (const candidate of candidates) {
      const res = await fetchURL(candidate);
      if (res.body && res.statusCode === 200 && res.body.includes('<loc>')) {
        const urls = await fetchXMLSitemap(candidate);
        const same = urls.filter(u => { try { return isSameDomain(new url.URL(u).hostname); } catch { return false; } });
        if (same.length > 0) {
          emit('log', { message: `XML sitemap: ${same.length} URLs found at ${candidate}` });
          sitemapSeeds = same.length;
          same.forEach(u => { const n = normalizeURL(u, origin); if (n && !visited.has(n)) queue.push(n); });
          xmlFound = true;
          break;
        } else {
          emit('log', { message: `XML sitemap found but 0 page URLs — trying HTML sitemap fallback` });
        }
      }
    }

    if (!xmlFound) {
      for (const hPath of [`${origin}/sitemap`, `${origin}/site-map`, `${origin}/sitemap.html`, `${origin}/sitemap/`]) {
        const res = await fetchURL(hPath);
        if (res.body && res.statusCode === 200) {
          const links = getLinks(res.body, hPath).filter(l => { try { return isSameDomain(new url.URL(l).hostname); } catch { return false; } });
          if (links.length > 5) {
            const seeded = await seedFromHTMLPage(hPath);
            if (seeded > 0) { sitemapSeeds = seeded; return; }
          }
        }
      }
      emit('log', { message: 'No sitemap found — using link crawling only' });
    }
  }

  // ── Process page (now also extracts content + persists) ───────────────────

  function emptyPage(u, status, redirectTo) {
    return {
      url: u,
      status_code: status,
      redirect_to: redirectTo || null,
      title: '', title_length: 0, h1: '',
      h2_count: 0, h2_sample: '',
      meta_description: '', meta_desc_present: false,
      word_count: 0, inlinks: 0,
      indexability: 'Non-Indexable',
      canonical_url: '', canonical_match: 'Missing',
      has_cta: false,
      headings: null, extracted_body: null, extracted_text: null,
    };
  }

  async function processPage(pageURL) {
    const res = await fetchURL(pageURL);

    // Failed/non-HTML/error
    if (res.error || res.nonHTML || !res.body) {
      const page = emptyPage(res.originalURL || pageURL, res.statusCode || 0, '');
      pageBuffer.push(page);
      try { await persistPage(page); } catch (e) { emit('log', { message: `Persist failed: ${e.message}` }); }
      return;
    }

    const finalURL = res.url || pageURL;
    const html     = res.body;
    const links    = getLinks(html, finalURL);

    // Update inlink map and queue new URLs
    links.forEach(link => { if (link !== finalURL) inlinkMap[link] = (inlinkMap[link] || 0) + 1; });
    links.forEach(link => { if (shouldCrawl(link)) queue.push(link); });

    // If this page was the destination of a redirect, record the redirect source as its own row
    if (res.originalURL && res.originalURL !== finalURL) {
      const srcNorm = normalizeURL(res.originalURL, baseOrigin);
      if (srcNorm && !pageBuffer.find(r => r.url === srcNorm)) {
        const redirectPage = emptyPage(res.originalURL, res.redirectedVia || 301, finalURL);
        pageBuffer.push(redirectPage);
        try { await persistPage(redirectPage); } catch (e) { emit('log', { message: `Persist failed: ${e.message}` }); }
      }
    }

    // Skip if we've already processed the final URL (e.g. multiple paths redirected here)
    if (pageBuffer.find(r => r.url === finalURL)) return;

    // Extract metadata
    const title    = getTag(html, /<title[^>]*>([^<]*)<\/title>/i);
    const h2s      = getH2s(html);
    const canonical= getCanonical(html);
    const metaDesc = getMetaDesc(html);

    // Extract content (Cheerio-based, lifted from Scout)
    const extracted = extractContent(html);

    const page = {
      url:                finalURL,
      status_code:        res.statusCode,
      redirect_to:        null,
      title,
      title_length:       getTitleLength(title),
      h1:                 getTag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
      h2_count:           h2s.length,
      h2_sample:          h2s.slice(0, 2).join(' | '),
      meta_description:   metaDesc,
      meta_desc_present:  !!metaDesc,
      word_count:         countWords(html),
      inlinks:            0, // finalized after crawl ends
      indexability:       checkIndexable(html),
      canonical_url:      canonical,
      canonical_match:    canonical ? (canonical.replace(/\/$/,'') === finalURL.replace(/\/$/,'') ? 'Self' : 'Other') : 'Missing',
      has_cta:            hasCallToAction(html),
      headings:           extracted.headings,
      extracted_body:     extracted.body,
      extracted_text:     extracted.text,
    };

    pageBuffer.push(page);
    try { await persistPage(page); } catch (e) { emit('log', { message: `Persist failed: ${e.message}` }); }
  }

  // ── Main crawl loop ───────────────────────────────────────────────────────

  emit('log', { message: `Starting crawl: ${targetURL}` });
  emit('log', { message: `Settings: max ${maxPages} pages, ${delayMs}ms delay, ${concurrency} concurrent` });

  // Sitemap discovery
  if (!noSitemap) {
    emit('log', { message: 'Discovering sitemap...' });
    if (htmlSitemap) {
      sitemapSeeds = await seedFromSitemapURL(htmlSitemap);
    } else {
      await discoverAndSeed(baseOrigin);
    }
  }

  // Seed start URL
  const normStart = normalizeURL(targetURL, baseOrigin);
  if (normStart && !visited.has(normStart)) queue.unshift(normStart);

  emit('log', { message: `Starting page crawl... (${queue.length} URLs queued)` });
  emit('progress', { crawled: 0, queued: queue.length, total: maxPages });

  while ((queue.length > 0 || activeCount > 0) && crawledCount < maxPages) {
    if (opts._cancelled && opts._cancelled()) break;

    while (activeCount < concurrency && queue.length > 0 && crawledCount < maxPages) {
      const next = queue.shift();
      if (!next) break;
      const norm = normalizeURL(next, baseOrigin);
      if (!norm || visited.has(norm)) continue;
      visited.add(norm);
      crawledCount++;
      activeCount++;

      processPage(norm).then(() => {
        const latest = pageBuffer[pageBuffer.length - 1];
        emit('page', {
          n: crawledCount,
          url: norm,
          status: latest ? latest.status_code : 0,
          words: latest ? latest.word_count : 0,
          title: latest ? latest.title : '',
        });
        emit('progress', { crawled: crawledCount, queued: queue.length, total: maxPages });
      }).catch(err => {
        console.error('[crawl] processPage error:', err);
      }).finally(() => {
        activeCount--;
      });

      if (delayMs > 0) await sleep(delayMs);
    }
    await sleep(50);
  }

  while (activeCount > 0) await sleep(100);

  // Final inlink counts (must be done after all pages processed)
  // We persist these via the bulk-update step in store.js after the loop finishes,
  // because per-page updates here would require N additional DB writes.
  pageBuffer.forEach(r => {
    const a = r.url;
    const b = a.endsWith('/') ? a.slice(0, -1) : a + '/';
    r.inlinks = Math.max(inlinkMap[a] || 0, inlinkMap[b] || 0);
  });

  const ok    = pageBuffer.filter(r => r.status_code >= 200 && r.status_code < 300).length;
  const errs  = pageBuffer.filter(r => r.status_code >= 400).length;
  const withW = pageBuffer.filter(r => r.word_count > 0);
  const avgW  = withW.length ? Math.round(withW.reduce((s, r) => s + r.word_count, 0) / withW.length) : 0;

  const summary = {
    total_pages:    pageBuffer.length,
    ok_pages:       ok,
    error_pages:    errs,
    sitemap_seeds:  sitemapSeeds,
    avg_word_count: avgW,
    inlinks:        inlinkMap, // for bulk update by store.js
  };

  emit('summary', summary);
  return summary;
}

module.exports = { crawl };
