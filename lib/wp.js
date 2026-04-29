'use strict';

/**
 * MMW Site Intelligence — WordPress API Client
 *
 * All calls go through the MMW plugin (/wp-json/mmw/v1/).
 * Auth uses HTTP Basic with WordPress Application Passwords (WP 5.6+).
 * Node 18+ built-in fetch is used — no extra dependencies.
 *
 * All functions throw on auth failure, plugin-not-found, or HTTP errors.
 * Callers are responsible for catching and surfacing errors.
 */

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authHeader(wpUsername, wpAppPassword) {
  const creds = Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64');
  return { Authorization: `Basic ${creds}` };
}

function base(siteUrl) {
  return siteUrl.replace(/\/$/, '');
}

async function wpFetch(url, options = {}) {
  let res;
  try {
    if (!options.signal) options.signal = AbortSignal.timeout(30_000);
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`Network error reaching ${url}: ${netErr.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('WordPress credentials rejected (401/403). Check username and application password.');
  }

  if (res.status === 404) {
    // Distinguish "plugin not installed" from "post not found"
    const body = await res.json().catch(() => ({}));
    if (body.code === 'rest_no_route') {
      throw new Error('MMW Plugin is not installed or activated on this site.');
    }
    throw new Error(`Not found (404): ${url}`);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status} from ${url}`);
  }

  return res.json();
}

// ─── Plugin health ────────────────────────────────────────────────────────────

/**
 * Ping the plugin. Returns { ok, version, site, name } or throws.
 */
async function ping(siteUrl, wpUsername, wpAppPassword) {
  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/ping`, {
    headers: authHeader(wpUsername, wpAppPassword),
  });
}

// ─── URL → Post ID ────────────────────────────────────────────────────────────

/**
 * Resolve a single URL to a WordPress post ID.
 * Returns { url, post_id, found }.
 */
async function lookupUrl(siteUrl, wpUsername, wpAppPassword, url) {
  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/lookup-url`, {
    method:  'POST',
    headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ url }),
  });
}

/**
 * Bulk resolve URLs to WordPress post IDs.
 * Returns { results: [{ url, post_id, found }, ...] }.
 * Caps at 200 URLs per call to stay within reasonable request sizes.
 */
async function lookupUrls(siteUrl, wpUsername, wpAppPassword, urls) {
  const results = [];
  const CHUNK   = 100;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    const data  = await wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/lookup-urls`, {
      method:  'POST',
      headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ urls: chunk }),
    });
    results.push(...(data.results || []));
  }
  return results;
}

// ─── Schema reads ─────────────────────────────────────────────────────────────

/**
 * Get all Rank Math schemas on a single post.
 * Returns { post_id, count, schemas: { [meta_key]: schemaObject } }.
 */
async function getSchemas(siteUrl, wpUsername, wpAppPassword, postId) {
  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/schema/${postId}`, {
    headers: authHeader(wpUsername, wpAppPassword),
  });
}

/**
 * Bulk read schemas for multiple post IDs.
 * Returns { results: [{ post_id, count, schemas }, ...] }.
 */
async function getSchemasBulk(siteUrl, wpUsername, wpAppPassword, postIds) {
  const results = [];
  const CHUNK   = 50;
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    const data  = await wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/schemas/bulk`, {
      method:  'POST',
      headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ post_ids: chunk }),
    });
    results.push(...(data.results || []));
  }
  return results;
}

// ─── Schema deploy ────────────────────────────────────────────────────────────

/**
 * Deploy a single schema to a WordPress post.
 * The plugin handles Rank Math PHP serialization and the metadata envelope.
 * Returns { ok, meta_key, updated }.
 */
async function deploySchema(siteUrl, wpUsername, wpAppPassword, { postId, schemaType, schema }) {
  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/schema`, {
    method:  'POST',
    headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ post_id: postId, schema_type: schemaType, schema }),
  });
}

// ─── Schema delete ────────────────────────────────────────────────────────────

/**
 * Delete MMW-managed schemas from a post.
 * Pass metaKeys to delete specific ones, or omit to delete all MMW schemas on the post.
 */
async function deleteSchemas(siteUrl, wpUsername, wpAppPassword, postId, metaKeys) {
  const body = { post_id: postId };
  if (Array.isArray(metaKeys)) body.meta_keys = metaKeys;

  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/schema/${postId}`, {
    method:  'DELETE',
    headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// ─── SEO meta ─────────────────────────────────────────────────────────────────

/**
 * Write Rank Math SEO title and/or meta description to a post.
 * Pass null to skip a field. Returns { ok, post_id, updated: [...fieldNames] }.
 */
async function writeSeoMeta(siteUrl, wpUsername, wpAppPassword, { postId, title, description, focusKeyword }) {
  const payload = { post_id: postId };
  if (title       != null) payload.title        = title;
  if (description != null) payload.description  = description;
  if (focusKeyword != null) payload.focus_keyword = focusKeyword;

  return wpFetch(`${base(siteUrl)}/wp-json/mmw/v1/seo-meta`, {
    method:  'POST',
    headers: { ...authHeader(wpUsername, wpAppPassword), 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
}

module.exports = { ping, lookupUrl, lookupUrls, getSchemas, getSchemasBulk, deploySchema, deleteSchemas, writeSeoMeta };
