'use strict';

/**
 * MMW Site Intelligence — WordPress Migration REST Client
 *
 * Standard /wp-json/wp/v2/ endpoints. Separate from lib/wp.js (which
 * targets the MMW plugin's custom routes) because migration uses core
 * WP REST exclusively. Same Basic auth pattern with application
 * passwords.
 *
 * All functions throw on auth/network/HTTP errors. Callers catch and
 * surface to the UI.
 */

const FormData = require('form-data');

function authHeader(username, appPassword) {
  const creds = Buffer.from(`${username}:${(appPassword || '').replace(/\s+/g, '')}`).toString('base64');
  return { Authorization: `Basic ${creds}` };
}

function base(siteUrl) {
  return String(siteUrl || '').replace(/\/$/, '');
}

async function wpFetch(url, options) {
  options = options || {};
  if (!options.signal) options.signal = AbortSignal.timeout(60_000);
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`Network error reaching ${url}: ${netErr.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('WordPress credentials rejected (401/403). Check username and application password.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

// ─── Auth verification ───────────────────────────────────────────────────────

async function verifyCredentials(wpUrl, username, appPassword) {
  if (!wpUrl || !username || !appPassword) {
    return { ok: false, error: 'Missing WordPress URL, username, or application password' };
  }
  try {
    const data = await wpFetch(`${base(wpUrl)}/wp-json/wp/v2/users/me?context=edit`, {
      headers: authHeader(username, appPassword),
    });
    const capabilities = data.capabilities || {};
    const needed = ['publish_posts', 'upload_files'];
    const missing = needed.filter(c => !capabilities[c]);
    return {
      ok:           missing.length === 0,
      user_id:      data.id,
      user_name:    data.name,
      user_slug:    data.slug,
      capabilities: Object.keys(capabilities).filter(k => capabilities[k]),
      missing:      missing.length > 0 ? missing : undefined,
      error:        missing.length > 0 ? `User is missing required capabilities: ${missing.join(', ')}` : undefined,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Media ────────────────────────────────────────────────────────────────────

/**
 * Upload a media file. `buffer` is a Node Buffer.
 * Returns { media_id, source_url } or throws.
 */
async function uploadMedia(wpUrl, auth, { buffer, filename, mimeType, alt }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadMedia: buffer must be a Node Buffer');
  if (!filename) throw new Error('uploadMedia: filename is required');

  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType || 'application/octet-stream' });
  if (alt) form.append('alt_text', String(alt));

  const headers = Object.assign({}, authHeader(auth.username, auth.appPassword), form.getHeaders());

  // form-data exposes getBuffer + getLength; Node fetch accepts a Buffer body.
  const body = form.getBuffer();
  headers['Content-Length'] = String(body.length);

  let res;
  try {
    res = await fetch(`${base(wpUrl)}/wp-json/wp/v2/media`, {
      method:  'POST',
      headers,
      body,
      signal:  AbortSignal.timeout(120_000),
    });
  } catch (netErr) {
    throw new Error(`Network error uploading media: ${netErr.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('WordPress credentials rejected (401/403) during media upload.');
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.message || `Media upload failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return { media_id: data.id, source_url: data.source_url };
}

async function deleteMedia(wpUrl, auth, mediaId) {
  return wpFetch(`${base(wpUrl)}/wp-json/wp/v2/media/${mediaId}?force=true`, {
    method:  'DELETE',
    headers: authHeader(auth.username, auth.appPassword),
  });
}

// ─── Taxonomies (categories + tags) ──────────────────────────────────────────

function makeTermCache() { return new Map(); }

async function ensureTerm(wpUrl, auth, taxonomy, name, cache) {
  if (!name) return null;
  const key = `${taxonomy}:${String(name).toLowerCase()}`;
  if (cache && cache.has(key)) return cache.get(key);

  const route = taxonomy === 'category' ? 'categories' : 'tags';
  const headers = Object.assign({}, authHeader(auth.username, auth.appPassword));

  // Search first
  const searchUrl = `${base(wpUrl)}/wp-json/wp/v2/${route}?search=${encodeURIComponent(name)}&per_page=10`;
  const found = await wpFetch(searchUrl, { headers });
  const match = Array.isArray(found) ? found.find(t => (t.name || '').toLowerCase() === String(name).toLowerCase()) : null;
  if (match) {
    if (cache) cache.set(key, match.id);
    return match.id;
  }

  // Create
  const created = await wpFetch(`${base(wpUrl)}/wp-json/wp/v2/${route}`, {
    method:  'POST',
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    body:    JSON.stringify({ name: String(name) }),
  });
  if (cache) cache.set(key, created.id);
  return created.id;
}

async function ensureCategory(wpUrl, auth, name, cache) {
  return ensureTerm(wpUrl, auth, 'category', name, cache);
}

async function ensureTag(wpUrl, auth, name, cache) {
  return ensureTerm(wpUrl, auth, 'tag', name, cache);
}

async function deleteCategory(wpUrl, auth, categoryId) {
  return wpFetch(`${base(wpUrl)}/wp-json/wp/v2/categories/${categoryId}?force=true`, {
    method:  'DELETE',
    headers: authHeader(auth.username, auth.appPassword),
  });
}

// ─── Posts ───────────────────────────────────────────────────────────────────

async function createPost(wpUrl, auth, payload) {
  const body = {
    title:   payload.title         || '',
    content: payload.content       || '',
    excerpt: payload.excerpt       || '',
    status:  payload.status        || 'draft',
    slug:    payload.slug          || undefined,
    date:    payload.date          || undefined,
  };
  if (payload.featured_media) body.featured_media = payload.featured_media;
  if (Array.isArray(payload.categories) && payload.categories.length) body.categories = payload.categories;
  if (Array.isArray(payload.tags)       && payload.tags.length)       body.tags       = payload.tags;

  const data = await wpFetch(`${base(wpUrl)}/wp-json/wp/v2/posts`, {
    method:  'POST',
    headers: Object.assign({}, authHeader(auth.username, auth.appPassword), { 'Content-Type': 'application/json' }),
    body:    JSON.stringify(body),
  });
  return { post_id: data.id, post_url: data.link, status: data.status };
}

async function findPostBySlug(wpUrl, auth, slug) {
  if (!slug) return null;
  const url = `${base(wpUrl)}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=any&per_page=5&context=edit`;
  const data = await wpFetch(url, { headers: authHeader(auth.username, auth.appPassword) });
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// ─── Rate-limited request wrapper ────────────────────────────────────────────

function rateLimiter(intervalMs) {
  intervalMs = intervalMs || 700;
  let last = 0;
  return async function gate() {
    const now  = Date.now();
    const wait = Math.max(0, last + intervalMs - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
}

// 1x1 transparent PNG for connection test
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

module.exports = {
  verifyCredentials,
  uploadMedia,
  deleteMedia,
  ensureCategory,
  ensureTag,
  deleteCategory,
  createPost,
  findPostBySlug,
  makeTermCache,
  rateLimiter,
  authHeader,
  TEST_PNG,
};
