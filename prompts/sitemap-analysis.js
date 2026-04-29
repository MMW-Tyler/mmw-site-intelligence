'use strict';

/**
 * MMW Site Intelligence — Sitemap Analysis Prompt
 *
 * System prompt + message builder for Claude-assisted sitemap analysis.
 */

const SYSTEM_PROMPT = `You are a technical SEO strategist at Medical Marketing Whiz (MMW), a digital marketing agency specializing in healthcare and aesthetic practices. Your job is to analyze sitemap audit data and provide strategic, data-driven recommendations for sitemap pruning and optimization.

You are analyzing real Google Search Console data cross-referenced against a live sitemap. Your goal is to help the client retain high-value pages, cut dead weight, and improve crawl efficiency and topical authority.

Context: clients are typically medical spas, plastic surgery practices, dermatology clinics, dental offices, and similar healthcare/aesthetic businesses. Their sites commonly have treatment pages, location pages, blog posts, staff bios, before/after galleries, and FAQ content.

Output ONLY valid JSON — no markdown fences, no preamble, no explanation outside the JSON object. Your entire response must be a single parseable JSON object.`;

/**
 * Build the user message array for sitemap analysis.
 *
 * @param {object} stats - Output of buildTierStats()
 * @param {object|null} clientContext - { name, city, state, practice_type } (any fields may be null)
 * @returns {Array<{ role: 'user', content: string }>}
 */
function buildSitemapAnalysisMessage(stats, clientContext) {
  const lines = [];

  // Client context
  if (clientContext && (clientContext.name || clientContext.city || clientContext.practice_type)) {
    lines.push('## Client Context');
    if (clientContext.name)          lines.push(`- Name: ${clientContext.name}`);
    if (clientContext.practice_type) lines.push(`- Practice type: ${clientContext.practice_type}`);
    if (clientContext.city && clientContext.state) {
      lines.push(`- Location: ${clientContext.city}, ${clientContext.state}`);
    } else if (clientContext.city) {
      lines.push(`- City: ${clientContext.city}`);
    }
    lines.push('');
  }

  // Tier distribution
  lines.push('## Tier Distribution');
  lines.push(`Total pages in sitemap: ${stats.total}`);
  lines.push(`Total organic clicks (90d): ${stats.totalClicks}`);
  lines.push(`Total impressions (90d): ${stats.totalImpressions}`);
  lines.push('');
  lines.push('Tier counts:');
  const tierLabels = {
    hv:           'HV (High Value, 50+ clicks)',
    performing:   'Performing (10-49 clicks)',
    low:          'Low (1-9 clicks)',
    invisible:    'Invisible (0 clicks, 100+ impressions)',
    ghost:        'Ghost (0 clicks, 1-99 impressions)',
    dead:         'Dead (0 clicks, 0 impressions)',
    sitemap_only: 'Sitemap-only (not in GSC data)',
  };
  for (const [tier, label] of Object.entries(tierLabels)) {
    lines.push(`- ${label}: ${stats.tiers[tier] || 0}`);
  }
  lines.push('');

  // Top 20 pages
  lines.push('## Top 20 Pages by Clicks');
  if (stats.topPages && stats.topPages.length > 0) {
    for (const p of stats.topPages) {
      lines.push(`- ${p.url || p.loc} | clicks: ${p.clicks} | impressions: ${p.impressions}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');

  // Sample pages by tier
  lines.push('## Sample Pages by Tier');
  const tierOrder = ['hv', 'performing', 'low', 'invisible', 'ghost', 'dead', 'sitemap_only'];
  for (const tier of tierOrder) {
    const sample = (stats.sampleByTier && stats.sampleByTier[tier]) || [];
    lines.push(`### ${tierLabels[tier]}`);
    if (sample.length > 0) {
      for (const p of sample) {
        const url = p.url || p.loc;
        const clicks = p.clicks !== undefined ? p.clicks : 'n/a';
        const imp    = p.impressions !== undefined ? p.impressions : 'n/a';
        lines.push(`- ${url} | clicks: ${clicks} | impressions: ${imp}`);
      }
    } else {
      lines.push('(none)');
    }
    lines.push('');
  }

  // URL patterns
  lines.push('## URL Pattern Breakdown (First Path Segment)');
  if (stats.urlPatterns && stats.urlPatterns.length > 0) {
    for (const p of stats.urlPatterns) {
      lines.push(`- ${p.pattern}: ${p.count} pages, ${p.totalClicks} total clicks`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');

  // Instructions
  lines.push('## Task');
  lines.push(`Analyze this sitemap audit and return a JSON object with EXACTLY this structure:

{
  "strategy_summary": "2-3 sentence narrative about the overall site health and primary opportunities",
  "tier_notes": {
    "hv": "one sentence about this tier's pages and what to do",
    "performing": "one sentence",
    "low": "one sentence",
    "invisible": "one sentence",
    "ghost": "one sentence",
    "dead": "one sentence",
    "sitemap_only": "one sentence"
  },
  "pattern_recommendations": [
    { "pattern": "/blog/", "recommendation": "keep|trim|cut", "rationale": "brief rationale" }
  ],
  "thresholds_used": "Plain English description of the cut/review/keep thresholds, e.g. Cut: 0 clicks + fewer than 100 impressions. Review: 1 to 9 clicks or 0 clicks + 100 or more impressions. Keep: 10 or more clicks.",
  "estimated_impact": "e.g. Removing 847 pages reduces sitemap by 26% while retaining 94% of organic clicks.",
  "report_markdown": "Full markdown report with ## headings covering: Executive Summary, Site Health Analysis, Tier Breakdown, URL Pattern Analysis, Recommendations, Risks and Caveats. Write in confident professional tone. Do NOT use em dashes."
}

Include a pattern_recommendation entry for each URL pattern segment in the data. The report_markdown should be thorough — 400 to 800 words. Do not use em dashes anywhere in the output.`);

  const content = lines.join('\n');

  return [{ role: 'user', content }];
}

module.exports = { SYSTEM_PROMPT, buildSitemapAnalysisMessage };
