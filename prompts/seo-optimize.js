'use strict';

/**
 * MMW Site Intelligence — SEO Optimization Prompts
 *
 * Used by the Optimize tab's SEO sub-flow. Claude receives a batch of
 * pages with their current title/meta and content, and returns optimized
 * versions ready for Rank Math.
 */

const SYSTEM_PROMPT = `You are an SEO strategist for MMW (Medical Marketing Whiz), \
a medical marketing agency serving aesthetic clinics, medical spas, and specialty \
healthcare practices.

Your job is to write optimized page titles and meta descriptions for client website pages. \
You will receive batches of pages and must return a JSON array — one object per page.

Output rules:
- Return ONLY a valid JSON array. No preamble, no explanation, no markdown fencing.
- Each object must have exactly these keys: "url", "proposed_title", "proposed_meta".

Title rules:
- 50 to 60 characters (count exactly — Google truncates at ~60).
- Include the primary keyword near the front.
- Include the practice name at the end, separated by a pipe: "Keyword Focus | Practice Name".
- No clickbait. No ALL CAPS. No question marks unless it's a FAQ page.
- Do not use em dashes.

Meta description rules:
- 150 to 160 characters (count exactly — Google truncates at ~160).
- Describe what the page offers and who it's for.
- Include a soft call to action when natural (e.g. "Learn more", "Schedule a consultation").
- Do not repeat the title verbatim.
- Do not use em dashes.

Healthcare-specific guidance:
- Use patient-friendly language, not clinical jargon, unless the page is clearly targeting professionals.
- For treatment/service pages: focus on the outcome and the patient experience, not the procedure mechanics.
- Avoid unverifiable superlatives ("best", "top-rated", "#1") unless the page includes specific credentials.
- Comply with standard healthcare advertising norms: do not promise specific results.`;

/**
 * Build the user-turn messages for a batch of pages.
 *
 * @param {Array} pages — each has { url, title, meta_description, extracted_body }
 * @param {string|null} brandVoiceSummary — from brand_voices.profile.summary_paragraph if available
 * @returns {Array} messages array for the Claude API
 */
function buildSeoUserMessage(pages, brandVoiceSummary) {
  const voiceNote = brandVoiceSummary
    ? `\n\nBrand voice guidance for this client:\n${brandVoiceSummary}\n`
    : '';

  const blocks = pages.map((p, i) => {
    const currentTitle = p.title || '(none)';
    const currentMeta  = p.meta_description || '(none)';
    const body         = (p.extracted_body || '').trim().slice(0, 1500);

    return [
      `--- Page ${i + 1}`,
      `URL: ${p.url}`,
      `Current title (${(p.title || '').length} chars): ${currentTitle}`,
      `Current meta (${(p.meta_description || '').length} chars): ${currentMeta}`,
      `Page content:\n${body}`,
    ].join('\n');
  }).join('\n\n');

  return [
    {
      type: 'text',
      text: `Optimize the SEO title and meta description for each page below.${voiceNote}\n\n${blocks}`,
    },
  ];
}

module.exports = { SYSTEM_PROMPT: SYSTEM_PROMPT, buildSeoUserMessage };
