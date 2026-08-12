/**
 * Phase 4 Step 3 — knowledge chunk preparation for future embeddings.
 * READ-ONLY. No OpenAI. No Mongo writes. Does not touch Blog RAG.
 *
 * 1 Area Guide → 1 chunk
 * 1 included FAQ → 1 chunk
 */

const crypto = require('crypto');
const {
  extractActiveAreaGuideKnowledge,
} = require('./areaGuideContentService');
const { extractActiveFaqKnowledge } = require('./faqContentService');

/**
 * Deterministic SHA-256 of normalized chunk content.
 * Trims edges; collapses horizontal whitespace runs; preserves newlines.
 * @param {string} content
 * @returns {string}
 */
const hashChunkContent = (content) => {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .trim();

  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
};

/**
 * @param {string} content
 * @returns {string}
 */
const finalizeContent = (content) =>
  String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

/**
 * Build a sparse chunk object (omit null/undefined/irrelevant keys).
 * @param {object} fields
 * @returns {object}
 */
const buildChunk = (fields) => {
  const content = finalizeContent(fields.content);
  const chunk = {
    sourceType: fields.sourceType,
    sourceId: String(fields.sourceId),
    chunkIndex: 0,
    content,
    contentHash: hashChunkContent(content),
  };

  if (fields.slug) chunk.slug = fields.slug;
  if (fields.title) chunk.title = fields.title;
  if (fields.category) chunk.category = fields.category;
  if (fields.heading) chunk.heading = fields.heading;
  if (fields.question) chunk.question = fields.question;
  if (fields.path) chunk.path = fields.path;
  if (fields.mapQuery) chunk.mapQuery = fields.mapQuery;
  if (typeof fields.order === 'number') chunk.order = fields.order;

  return chunk;
};

/**
 * @param {object} unit - normalized area guide unit from Step 2
 * @returns {object}
 */
const chunkAreaGuideUnit = (unit) => {
  if (!unit || unit.sourceType !== 'area_guide') {
    throw new Error('chunkAreaGuideUnit requires an area_guide unit');
  }

  return buildChunk({
    sourceType: 'area_guide',
    sourceId: unit.sourceId,
    slug: unit.slug,
    title: unit.title,
    path: unit.path,
    mapQuery: unit.mapQuery,
    order: unit.order,
    content: unit.plainText,
  });
};

/**
 * @param {object} unit - normalized FAQ unit from Step 2
 * @returns {object}
 */
const chunkFaqUnit = (unit) => {
  if (!unit || unit.sourceType !== 'faq') {
    throw new Error('chunkFaqUnit requires a faq unit');
  }

  return buildChunk({
    sourceType: 'faq',
    sourceId: unit.sourceId,
    category: unit.page,
    slug: unit.slug || undefined,
    question: unit.question,
    order: unit.order,
    content: unit.plainText,
  });
};

/**
 * Prepare all Phase 4 knowledge chunks (in memory only).
 * @returns {Promise<{ areaGuideChunks: object[], faqChunks: object[], chunks: object[], meta: object }>}
 */
const prepareKnowledgeChunks = async () => {
  const areaUnits = await extractActiveAreaGuideKnowledge();
  const { units: faqUnits, excluded } = await extractActiveFaqKnowledge();

  const areaGuideChunks = areaUnits.map(chunkAreaGuideUnit);
  const faqChunks = faqUnits.map(chunkFaqUnit);
  const chunks = [...areaGuideChunks, ...faqChunks];

  return {
    areaGuideChunks,
    faqChunks,
    chunks,
    meta: {
      areaGuideSources: areaUnits.length,
      faqSources: faqUnits.length,
      careersFaqsExcluded: excluded.careers,
      totalChunks: chunks.length,
    },
  };
};

/**
 * Logical identity for future embedding storage (without embeddingModel yet).
 * @param {object} chunk
 * @returns {string}
 */
const chunkLogicalKey = (chunk) =>
  `${chunk.sourceType}::${chunk.sourceId}::${chunk.chunkIndex}`;

module.exports = {
  hashChunkContent,
  finalizeContent,
  chunkAreaGuideUnit,
  chunkFaqUnit,
  prepareKnowledgeChunks,
  chunkLogicalKey,
};
