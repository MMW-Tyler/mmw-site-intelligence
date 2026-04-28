'use strict';

/**
 * MMW Site Intelligence — Brand Voice Cross-Tool API
 *
 * These endpoints are called by other MMW tools (Content Engine,
 * Press Release Writer, etc.) to fetch a client's brand voice profile.
 * Auth is required: pass the shared secret in the X-MMW-API-Key header.
 *
 * Routes (mounted at /api/brand-voice in server.js):
 *   GET /api/brand-voice/:clientId         — fetch profile by Supabase client UUID
 *   GET /api/brand-voice/by-domain/:domain — fetch profile by client domain
 */

const express = require('express');
const store   = require('../crawl/store');

const router = express.Router();

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const expected = process.env.MMW_INTERNAL_API_KEY;
  if (!expected) {
    // Key not configured — fail closed rather than open
    return res.status(503).json({ error: 'Brand Voice API is not configured (MMW_INTERNAL_API_KEY not set)' });
  }
  const provided = req.headers['x-mmw-api-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid X-MMW-API-Key header' });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/by-domain/:domain', requireApiKey, async (req, res) => {
  try {
    const bv = await store.getBrandVoiceByDomain(req.params.domain);
    if (!bv) return res.status(404).json({ error: 'No brand voice profile found for this domain' });
    res.json(bv);
  } catch (err) {
    console.error('[brand-voice api] by-domain error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:clientId', requireApiKey, async (req, res) => {
  try {
    const bv = await store.getBrandVoice(req.params.clientId);
    if (!bv) return res.status(404).json({ error: 'No brand voice profile found for this client' });
    res.json(bv);
  } catch (err) {
    console.error('[brand-voice api] by-clientId error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
