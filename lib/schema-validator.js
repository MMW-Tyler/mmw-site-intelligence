'use strict';

/**
 * Schema.org vocabulary validator.
 *
 * Uses a bundled curated vocabulary (lib/schemaorg-vocab.js) as the primary
 * source so validation works without network access. On first use it also
 * attempts to download the full schema.org vocabulary and cache it locally
 * for a richer property coverage — but the bundled vocab is always the
 * fallback so validation never fails due to network issues.
 *
 * Exports:
 *   validateSchema(schemaObj)    → Promise<{ valid, errors, warnings }>
 *   validateSchemas(schemasArr)  → Promise<Array<{ valid, errors, warnings }>>
 *   preload()                    → Promise<void>  (call at server startup)
 */

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const bundled = require('./schemaorg-vocab');

const VOCAB_URL      = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
const CACHE_PATH     = path.join(os.tmpdir(), 'mmw-schemaorg-index.json');
const CACHE_TTL      = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT  = 15_000;

// In-memory cache — starts as the bundled vocab, upgraded to live vocab on success.
let memIndex = bundled;

// ─── Vocab loading ─────────────────────────────────────────────────────────────

function stripPrefix(id) {
  if (!id || typeof id !== 'string') return null;
  return id.replace(/^schema:/, '').replace(/^https?:\/\/schema\.org\//, '');
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function buildIndex(graph) {
  const types      = new Set();
  const propDomains = new Map();
  const parents    = new Map();

  for (const item of graph) {
    const id       = stripPrefix(item['@id']);
    if (!id) continue;
    const itemTypes = toArray(item['@type']);

    if (itemTypes.includes('rdfs:Class')) {
      types.add(id);
      const ps = toArray(item['rdfs:subClassOf'])
        .map(p => stripPrefix(p['@id'] || p))
        .filter(Boolean);
      parents.set(id, new Set(ps));
    }

    if (itemTypes.includes('rdf:Property')) {
      const domains = toArray(item['schema:domainIncludes'])
        .map(d => stripPrefix(d['@id'] || d))
        .filter(Boolean);
      propDomains.set(id, new Set(domains));
    }
  }

  return { types, propDomains, parents };
}

function deserializeIndex(raw) {
  return {
    types:      new Set(raw.types),
    propDomains: new Map(Object.entries(raw.propDomains).map(([k, v]) => [k, new Set(v)])),
    parents:    new Map(Object.entries(raw.parents).map(([k, v]) => [k, new Set(v)])),
  };
}

function serializeIndex(idx) {
  return {
    types:      [...idx.types],
    propDomains: Object.fromEntries([...idx.propDomains].map(([k, v]) => [k, [...v]])),
    parents:    Object.fromEntries([...idx.parents].map(([k, v]) => [k, [...v]])),
  };
}

async function tryLoadLiveVocab() {
  // Try disk cache
  try {
    const stat = fs.statSync(CACHE_PATH);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) {
      return deserializeIndex(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')));
    }
  } catch (_) {}

  // Fetch from schema.org
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(VOCAB_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/ld+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vocab = await res.json();
    const idx   = buildIndex(vocab['@graph'] || []);
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(serializeIndex(idx)), 'utf8');
    } catch (_) {}
    return idx;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call at server startup to attempt vocab upgrade (non-blocking).
 * Validation works immediately using the bundled vocab if the fetch fails.
 */
async function preload() {
  try {
    const live = await tryLoadLiveVocab();
    // Merge live data: live vocab is superset of bundled, so replace.
    memIndex = live;
    console.log(`[schema-validator] schema.org vocabulary loaded (${memIndex.types.size} types, ${memIndex.propDomains.size} properties)`);
  } catch (err) {
    console.log(`[schema-validator] using bundled vocabulary (${bundled.types.size} types) — ${err.message}`);
  }
}

// ─── Type hierarchy helper ─────────────────────────────────────────────────────

function getAncestors(typeName, parentsMap, visited = new Set()) {
  if (visited.has(typeName)) return visited;
  visited.add(typeName);
  const ps = parentsMap.get(typeName) || new Set();
  for (const p of ps) getAncestors(p, parentsMap, visited);
  return visited;
}

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a single JSON-LD schema object.
 *
 * @param {Object} schemaObj
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
async function validateSchema(schemaObj) {
  const errors   = [];
  const warnings = [];

  if (!schemaObj || typeof schemaObj !== 'object' || Array.isArray(schemaObj)) {
    return { valid: false, errors: ['Schema must be a JSON object'], warnings };
  }

  // @context
  const ctx = schemaObj['@context'];
  if (!ctx || !String(ctx).includes('schema.org')) {
    errors.push('"@context" must be "https://schema.org"');
  }

  // @type
  const type = schemaObj['@type'];
  if (!type) {
    errors.push('"@type" is required');
    return { valid: false, errors, warnings };
  }

  const idx = memIndex;

  if (!idx.types.has(type)) {
    errors.push(`"${type}" is not a recognized schema.org type — check https://schema.org/${encodeURIComponent(type)}`);
  }

  // Property validation
  const typeChain = getAncestors(type, idx.parents);

  for (const key of Object.keys(schemaObj)) {
    if (key.startsWith('@')) continue;

    if (!idx.propDomains.has(key)) {
      errors.push(`"${key}" is not a recognized schema.org property — check https://schema.org/${encodeURIComponent(key)}`);
      continue;
    }

    const validDomains = idx.propDomains.get(key);
    if (validDomains.size > 0) {
      const applicable = [...typeChain].some(t => validDomains.has(t));
      if (!applicable) {
        const sample = [...validDomains].slice(0, 3).join(', ');
        warnings.push(`"${key}" is not a standard property of ${type} (typically used on: ${sample})`);
      }
    }

    // Validate nested @type one level deep
    const val = schemaObj[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && val['@type']) {
      if (!idx.types.has(val['@type'])) {
        errors.push(`Nested "@type" "${val['@type']}" on property "${key}" is not a recognized schema.org type`);
      }
    }
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v && typeof v === 'object' && v['@type'] && !idx.types.has(v['@type'])) {
          errors.push(`Nested "@type" "${v['@type']}" at "${key}[${i}]" is not a recognized schema.org type`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate an array of schema objects.
 */
async function validateSchemas(schemas) {
  return Promise.all(schemas.map(s => validateSchema(s)));
}

module.exports = { validateSchema, validateSchemas, preload };
