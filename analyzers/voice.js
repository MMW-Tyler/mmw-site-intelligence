'use strict';

/**
 * MMW Site Intelligence — Voice Analyzer
 *
 * Orchestrates the Brand Voice analysis using the Anthropic Claude API.
 * Takes an array of page objects (must include extracted_text), streams the
 * Claude response, and returns the parsed profile JSON.
 *
 * Pure in the "no DB access" sense — caller is responsible for fetching pages
 * from Supabase and persisting the returned profile.
 *
 * Exports:
 *   analyzeVoice(pages, onEvent)   → Promise<profile>
 *   shouldDefaultCheck(page)       → boolean
 */

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, buildUserMessage } = require('../prompts/voice-analysis');

// ─── Default-check heuristics for the Voice page picker ──────────────────────
// Slightly stricter than Scout: voice analysis benefits from richer content.

const VOICE_WORD_THRESHOLD = 200;

const EXCLUDE_URL_PATTERNS = [
  /\/(cart|checkout|my-account|login|register|wp-login|wp-admin|wp-json|feed|xmlrpc)\/?$/i,
  /\/page\/\d+\/?$/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|zip)$/i,
];

function shouldDefaultCheck(page) {
  if (!page.url) return false;
  const sc = page.status_code || 0;
  if (sc < 200 || sc >= 300) return false;
  if (page.indexability === 'Non-Indexable') return false;
  if ((page.word_count || 0) < VOICE_WORD_THRESHOLD) return false;
  if (EXCLUDE_URL_PATTERNS.some(re => re.test(page.url))) return false;
  return true;
}

// ─── Voice analysis ───────────────────────────────────────────────────────────

const MAX_PAGES          = 50;   // cap to keep context and cost reasonable
const MAX_CHARS_PER_PAGE = 3000; // truncate each page's extracted_text

/**
 * Analyze a set of pages and return a structured Brand Voice profile.
 *
 * @param {Array}    pages    — crawl_pages rows (must have extracted_text)
 * @param {Function} onEvent  — callback(type, data) for progress events ('log')
 * @param {Object}   [opts]   — optional: { signal } AbortSignal to cancel the stream
 * @returns {Promise<Object>} — the profile object matching the schema in voice-analysis.js
 */
async function analyzeVoice(pages, onEvent, opts) {
  const emit = onEvent || (() => {});
  const signal = (opts && opts.signal) || undefined;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');

  const client = new Anthropic({ apiKey });

  // Filter to pages with usable text, cap count, truncate each
  const ready = pages
    .filter(p => (p.extracted_text || '').trim().length > 100)
    .slice(0, MAX_PAGES)
    .map(p => ({
      ...p,
      extracted_text: (p.extracted_text || '').slice(0, MAX_CHARS_PER_PAGE),
    }));

  if (ready.length === 0) {
    throw new Error('No pages with extracted text found. Try re-crawling the site.');
  }

  emit('log', { message: `Sending ${ready.length} page${ready.length === 1 ? '' : 's'} to Claude Opus for analysis...` });

  const userContent = buildUserMessage(ready);

  // Stream the response so we can emit progress events and avoid proxy timeouts
  const stream = client.messages.stream({
    model:      'claude-opus-4-7',
    max_tokens: 4096,
    thinking:   { type: 'adaptive' },
    system: [
      {
        type:          'text',
        text:          SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: userContent },
    ],
  }, ...(signal ? [{ signal }] : []));

  let thinkingStarted = false;
  let writingStarted  = false;
  let fullText        = '';

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'thinking' && !thinkingStarted) {
        thinkingStarted = true;
        emit('log', { message: 'Thinking through the content...' });
      }
      if (event.content_block.type === 'text' && !writingStarted) {
        writingStarted = true;
        emit('log', { message: 'Writing brand voice profile...' });
      }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullText += event.delta.text;
    }
  }

  emit('log', { message: 'Parsing profile...' });

  // Strip any accidental markdown code fences Claude might add
  const cleaned = fullText.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/,    '')
    .trim();

  let profile;
  try {
    profile = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(
      'Could not parse brand voice profile from Claude response. ' +
      'Raw output started with: ' + fullText.slice(0, 300)
    );
  }

  return profile;
}

module.exports = { analyzeVoice, shouldDefaultCheck, VOICE_WORD_THRESHOLD };
