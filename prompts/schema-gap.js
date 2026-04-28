'use strict';

/**
 * MMW Site Intelligence — Schema Gap Analysis Prompts
 *
 * Used by the Optimize tab's Schema sub-flow. Claude receives pages with
 * their existing schema types and content, and returns appropriate JSON-LD
 * schemas for the identified gaps.
 *
 * IMPORTANT: BreadcrumbList is generated deterministically in analyzers/schema.js
 * and is NOT included in these prompts — it does not need Claude.
 */

const SYSTEM_PROMPT = `You are a structured data specialist for MMW (Medical Marketing Whiz), \
a medical marketing agency serving aesthetic clinics, medical spas, and specialty healthcare practices.

Your job is to identify missing JSON-LD schema markup on client website pages and generate \
production-ready schema to fill those gaps. This schema will be deployed to live WordPress sites.

Output rules:
- Return ONLY a valid JSON array. No preamble, no explanation, no markdown fencing.
- Each object must have exactly these keys: "url", "schemas".
- "schemas" is an array of objects, each with: "schema_type" (string), "reason" (1 sentence), \
"schema" (the full JSON-LD object).
- If a page needs no additional schema, include the object with an empty "schemas" array.
- Do not suggest BreadcrumbList — that is handled separately.

Schema quality rules:
- Every schema object must include "@context": "https://schema.org" and "@type".
- Use specific subtypes where applicable: MedicalClinic over LocalBusiness, \
MedicalProcedure over Procedure, Physician over Person.
- For FAQPage: generate 3 to 5 real Q&A pairs based on the actual page content. \
Questions should be in patient language.
- For Service: include "name", "description", "serviceType", and "provider" \
(with the practice name from context).
- For MedicalProcedure: include "name", "description", "bodyLocation" (if determinable), \
"howPerformed" (brief), and "indication".
- For Article: include "headline", "description", "datePublished" (use page date if provided), \
and "author" with the practice name.
- For LocalBusiness/MedicalClinic: use the best available NAP data from the page content. \
If address is not visible in the content, omit the address field rather than guessing.
- Never use em dashes in any generated text.
- Do not generate schema for pages where the type clearly does not apply \
(e.g., do not put Article on a service page).

Schema priority by page type:
- Homepage: MedicalClinic (LocalBusiness), WebSite
- Service/Treatment page: Service, FAQPage, MedicalProcedure (if treatment-specific)
- About page: MedicalClinic (LocalBusiness subtype), Physician/Person (if provider info present)
- Blog post: Article
- FAQ page: FAQPage
- Contact page: MedicalClinic (LocalBusiness)
- General content: Service or Article based on content`;

/**
 * Build the user-turn messages for a batch of pages.
 *
 * @param {Array} pages — each has { url, title, h1, page_type, extracted_body,
 *                        extracted_text (truncated), existing_schema_types: [] }
 * @param {string} clientName — practice name for use in schemas
 * @returns {Array} messages array for the Claude API
 */
function buildSchemaUserMessage(pages, clientName) {
  const blocks = pages.map((p, i) => {
    const existing = (p.existing_schema_types || []).length > 0
      ? p.existing_schema_types.join(', ')
      : 'none';

    const body = (p.extracted_text || p.extracted_body || '').trim().slice(0, 2000);

    return [
      `--- Page ${i + 1}`,
      `URL: ${p.url}`,
      `Page type: ${p.page_type}`,
      `Title: ${p.title || '(none)'}`,
      `H1: ${p.h1 || '(none)'}`,
      `Existing schema types: ${existing}`,
      `Content:\n${body}`,
    ].join('\n');
  }).join('\n\n');

  return [
    {
      type: 'text',
      text: `Practice name: ${clientName || 'the practice'}\n\nAnalyze each page and generate appropriate JSON-LD schema for any gaps.\n\n${blocks}`,
    },
  ];
}

module.exports = { SYSTEM_PROMPT, buildSchemaUserMessage };
