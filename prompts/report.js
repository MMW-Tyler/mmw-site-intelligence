'use strict';

/**
 * MMW Site Intelligence — Optimization Report Prompts
 *
 * Used by the Clients tab's "Generate Report" feature. Claude receives
 * a full picture of the client, crawl stats, audit findings, and the
 * optimization history, then produces a polished Markdown report.
 *
 * When built_by_mmw = true, the narrative frames work as ongoing
 * optimization rather than an audit of problems — so the client sees
 * proactive improvement, not a list of things that were wrong.
 */

const SYSTEM_PROMPT = `You are a senior digital marketing strategist at MMW (Medical Marketing Whiz), \
a medical marketing agency specializing in aesthetic clinics, medical spas, and specialty \
healthcare practices.

You are writing an optimization report for a client. Your tone should be:
- Professional but accessible — no jargon the client can't understand
- Confident and forward-looking — focus on improvements and outcomes
- Specific — reference actual page titles, URLs, and data points

Output format: clean Markdown only. Use headings (##), bullet lists, and bold for emphasis. \
No HTML tags. No em dashes. No preamble like "Here is your report" — start directly with the first heading.

Framing guidance:
- When built_by_mmw is true: frame all findings as part of MMW's ongoing optimization work. \
  Use language like "we identified opportunities", "we refined", "our team optimized". \
  Avoid any language that implies the site had problems before MMW's involvement.
- When built_by_mmw is false: frame findings as audit discoveries and resolutions. \
  Acknowledge the baseline state, then describe what was improved and why.

Report structure (use these exact section headings):
1. ## Executive Summary
2. ## Site Overview
3. ## Issues Identified
4. ## SEO Optimizations
5. ## Schema Additions
6. ## Summary & Next Steps

Keep the report readable in 5 minutes. Be specific but not exhaustive.`;

/**
 * Build the user-turn message for report generation.
 *
 * @param {Object} client       — { name, city, state, practice_type, built_by_mmw, tagline }
 * @param {Object} crawlSummary — { page_count, finished_at, domain }
 * @param {Object} auditSummary — { issues: [{category, severity, count}] } or null
 * @param {Array}  seoHistory   — array of seo_optimizations rows
 * @param {Array}  schemaHistory — array of schema_optimizations rows
 * @returns {Array} messages array for the Claude API
 */
function buildReportUserMessage(client, crawlSummary, auditSummary, seoHistory, schemaHistory) {
  const loc = [client.city, client.state].filter(Boolean).join(', ');
  const practiceLabel = client.practice_type
    ? client.practice_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : 'Healthcare Practice';

  const clientBlock = [
    `Client: ${client.name}`,
    loc ? `Location: ${loc}` : null,
    `Practice type: ${practiceLabel}`,
    client.tagline ? `Tagline: ${client.tagline}` : null,
    `Built by MMW: ${client.built_by_mmw ? 'yes' : 'no'}`,
  ].filter(Boolean).join('\n');

  const crawlBlock = crawlSummary
    ? [
        `Domain: ${crawlSummary.domain || '(unknown)'}`,
        `Pages crawled: ${crawlSummary.page_count || 0}`,
        `Crawl date: ${crawlSummary.finished_at ? new Date(crawlSummary.finished_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'unknown'}`,
      ].join('\n')
    : 'No crawl data available.';

  let auditBlock = 'No audit data available.';
  if (auditSummary && auditSummary.issues && auditSummary.issues.length > 0) {
    auditBlock = auditSummary.issues
      .map(i => `- ${i.category} (${i.severity}): ${i.count} occurrence${i.count !== 1 ? 's' : ''}`)
      .join('\n');
  }

  let seoBlock = 'No SEO optimizations on record.';
  if (seoHistory && seoHistory.length > 0) {
    const lines = seoHistory.slice(0, 30).map(row => {
      const titleChanged = row.after_title && row.after_title !== row.before_title;
      const metaChanged  = row.after_meta  && row.after_meta  !== row.before_meta;
      const changes = [];
      if (titleChanged) changes.push(`title: "${row.before_title || '(none)'}" → "${row.after_title}"`);
      if (metaChanged)  changes.push(`meta updated`);
      return `- ${row.url}\n  ${changes.join('; ') || 'pushed'}`;
    });
    seoBlock = `${seoHistory.length} page${seoHistory.length !== 1 ? 's' : ''} optimized:\n${lines.join('\n')}`;
  }

  let schemaBlock = 'No schema additions on record.';
  if (schemaHistory && schemaHistory.length > 0) {
    const lines = schemaHistory.slice(0, 20).map(row =>
      `- ${row.url} — ${row.schema_type || 'Schema'} added`
    );
    schemaBlock = `${schemaHistory.length} schema block${schemaHistory.length !== 1 ? 's' : ''} pushed:\n${lines.join('\n')}`;
  }

  const text = `Generate an optimization report for the following client.

--- CLIENT PROFILE ---
${clientBlock}

--- SITE OVERVIEW ---
${crawlBlock}

--- AUDIT FINDINGS ---
${auditBlock}

--- SEO OPTIMIZATIONS PUSHED ---
${seoBlock}

--- SCHEMA ADDITIONS PUSHED ---
${schemaBlock}

Write the full report now using the six-section structure from your instructions.`;

  return [{ role: 'user', content: text }];
}

module.exports = { SYSTEM_PROMPT, buildReportUserMessage };
