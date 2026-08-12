/**
 * Area Guide public knowledge extraction (Phase 4 Step 2).
 * READ-ONLY. No OpenAI. No agent hydration. No Blog RAG reuse.
 *
 * Allowed content: title, about, keyHighlights[].title
 * Excluded: agentOrders, agents, listingsSearch, image, timestamps
 */

const AreaGuide = require('../models/AreaGuide');

const FORBIDDEN_OUTPUT_KEYS = [
  'agentOrders',
  'agents',
  'listingsSearch',
  'image',
  'createdAt',
  'updatedAt',
  '__v',
];

/**
 * @param {unknown} value
 * @returns {string}
 */
const asTrimmedString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * Normalize one Area Guide document into a public knowledge unit.
 * Does not invent or rewrite editorial content.
 *
 * @param {object} doc
 * @returns {object|null}
 */
const normalizeAreaGuide = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.isActive === false) return null;

  const title = asTrimmedString(doc.title);
  const about = asTrimmedString(doc.about);
  if (!title || !about) return null;

  const highlights = Array.isArray(doc.keyHighlights) ? doc.keyHighlights : [];
  const highlightTexts = highlights
    .map((h) => asTrimmedString(h && h.title))
    .filter(Boolean);

  const blocks = [{ type: 'about', text: about }];
  for (const text of highlightTexts) {
    blocks.push({ type: 'highlight', text });
  }

  const plainParts = [`Title:\n${title}`, '', `About:\n${about}`];
  if (highlightTexts.length) {
    plainParts.push('', 'Key Highlights:');
    for (const text of highlightTexts) {
      plainParts.push(`- ${text}`);
    }
  }

  const plainText = plainParts.join('\n').trim();
  if (!plainText) return null;

  const unit = {
    sourceType: 'area_guide',
    sourceId: String(doc._id),
    slug: asTrimmedString(doc.slug) || null,
    title,
    path: asTrimmedString(doc.path) || null,
    mapQuery: asTrimmedString(doc.mapQuery) || null,
    order: typeof doc.order === 'number' ? doc.order : null,
    blocks,
    plainText,
    stats: {
      aboutLength: about.length,
      highlightCount: highlightTexts.length,
      plainTextLength: plainText.length,
    },
  };

  assertNoForbiddenFields(unit);
  return unit;
};

/**
 * @param {object} unit
 */
const assertNoForbiddenFields = (unit) => {
  for (const key of FORBIDDEN_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(unit, key)) {
      throw new Error(`Area guide knowledge leaked forbidden field: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(unit, 'image')) {
    throw new Error('Area guide knowledge leaked image field');
  }
};

/**
 * Load active Area Guides directly from the model (no includeAgents).
 * @returns {Promise<object[]>}
 */
const extractActiveAreaGuideKnowledge = async () => {
  const docs = await AreaGuide.find({ isActive: true })
    .select('order slug title about keyHighlights mapQuery path isActive')
    .sort({ order: 1 })
    .lean();

  return docs.map(normalizeAreaGuide).filter(Boolean);
};

module.exports = {
  normalizeAreaGuide,
  extractActiveAreaGuideKnowledge,
  FORBIDDEN_OUTPUT_KEYS,
};
