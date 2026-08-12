/**
 * Reusable Atlas Vector Search over the unified `ai_knowledge` collection.
 *
 * Single production entry point for semantic retrieval.
 * Does NOT generate chat answers — retrieval only.
 */

const AiKnowledge = require('../models/AiKnowledge');
const { SOURCE_TYPES } = require('../models/AiKnowledge');
const {
  generateEmbedding,
  EmbeddingServiceError,
} = require('./embeddingService');

const VECTOR_INDEX_NAME = 'ai_knowledge_vector_index';
const DEFAULT_LIMIT = 5;
const DEFAULT_NUM_CANDIDATES = 40;
const MAX_LIMIT = 20;
const MAX_NUM_CANDIDATES = 200;

class VectorSearchError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, category?: string }} [options]
   */
  constructor(message, { statusCode = 502, category = 'vector_search_error' } = {}) {
    super(message);
    this.name = 'VectorSearchError';
    this.statusCode = statusCode;
    this.category = category;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
const asTrimmedString = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return '';
};

/**
 * Normalize optional sourceType / sourceTypes into a unique allowed list.
 * @param {{ sourceType?: string, sourceTypes?: string[] }} options
 * @returns {string[]|null} null = no filter
 */
const resolveSourceTypes = (options = {}) => {
  const raw = [];

  if (typeof options.sourceType === 'string' && options.sourceType.trim()) {
    raw.push(options.sourceType.trim());
  }

  if (Array.isArray(options.sourceTypes)) {
    options.sourceTypes.forEach((value) => {
      if (typeof value === 'string' && value.trim()) {
        raw.push(value.trim());
      }
    });
  }

  if (!raw.length) return null;

  const unique = [...new Set(raw)];
  const invalid = unique.filter((type) => !SOURCE_TYPES.includes(type));

  if (invalid.length) {
    throw new VectorSearchError(
      `Unsupported sourceType(s): ${invalid.join(', ')}`,
      { statusCode: 400, category: 'invalid_request' }
    );
  }

  return unique;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
const clampPositiveInt = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
};

/**
 * Map an aggregation row to a safe retrieval result.
 * Never includes embedding / embeddingHash.
 * @param {object} row
 * @returns {object}
 */
const toSafeResult = (row) => {
  const result = {
    sourceType: asTrimmedString(row.sourceType),
    sourceId: asTrimmedString(row.sourceId),
    title: asTrimmedString(row.title) || undefined,
    slug: asTrimmedString(row.slug) || undefined,
    content: asTrimmedString(row.content) || undefined,
    score:
      typeof row.score === 'number' && Number.isFinite(row.score)
        ? row.score
        : undefined,
  };

  if (
    row.metadata &&
    typeof row.metadata === 'object' &&
    !Array.isArray(row.metadata)
  ) {
    // Pass through only already-public metadata stored at embed time
    result.metadata = { ...row.metadata };
  }

  return result;
};

/**
 * Semantic search over `ai_knowledge` via Atlas Vector Search.
 *
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   numCandidates?: number,
 *   sourceType?: 'blog'|'areaGuide'|'faq'|'service'|'property',
 *   sourceTypes?: Array<'blog'|'areaGuide'|'faq'|'service'|'property'>,
 * }} [options]
 * @returns {Promise<{
 *   query: string,
 *   limit: number,
 *   numCandidates: number,
 *   sourceTypes: string[]|null,
 *   results: Array<object>,
 * }>}
 */
const searchKnowledge = async (query, options = {}) => {
  const trimmedQuery = asTrimmedString(query);
  if (!trimmedQuery) {
    throw new VectorSearchError('Query is required.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const limit = clampPositiveInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const numCandidates = Math.max(
    limit,
    clampPositiveInt(
      options.numCandidates,
      DEFAULT_NUM_CANDIDATES,
      MAX_NUM_CANDIDATES
    )
  );
  const sourceTypes = resolveSourceTypes(options);

  let queryVector;
  try {
    queryVector = await generateEmbedding(trimmedQuery);
  } catch (error) {
    if (error instanceof EmbeddingServiceError) {
      throw new VectorSearchError(error.message, {
        statusCode: error.statusCode || 502,
        category: error.category || 'openai_error',
      });
    }
    throw new VectorSearchError(
      error?.message || 'Failed to generate query embedding.',
      { statusCode: 502, category: 'openai_error' }
    );
  }

  /** @type {Record<string, unknown>} */
  // Prefer a larger candidate pool when sourceType filtering is applied in-app.
  // (Atlas filter on sourceType requires a filter-indexed field; post-filter is safe on M0.)
  const vectorLimit = sourceTypes?.length
    ? Math.min(Math.max(limit * 25, numCandidates), MAX_NUM_CANDIDATES)
    : limit;

  const vectorSearchStage = {
    index: VECTOR_INDEX_NAME,
    path: 'embedding',
    queryVector,
    numCandidates: Math.max(numCandidates, vectorLimit),
    limit: vectorLimit,
  };

  const pipeline = [
    { $vectorSearch: vectorSearchStage },
    {
      $project: {
        _id: 0,
        sourceType: 1,
        sourceId: 1,
        title: 1,
        slug: 1,
        content: 1,
        metadata: 1,
        score: { $meta: 'vectorSearchScore' },
        // Explicitly never project embedding / embeddingHash
      },
    },
  ];

  if (sourceTypes?.length) {
    pipeline.push({
      $match: {
        sourceType: { $in: sourceTypes },
      },
    });
  }

  pipeline.push({ $limit: limit });

  let rows;
  try {
    rows = await AiKnowledge.aggregate(pipeline);
  } catch (error) {
    throw new VectorSearchError(
      error?.message || 'Atlas vector search aggregation failed.',
      { statusCode: 502, category: 'vector_search_error' }
    );
  }

  const results = Array.isArray(rows) ? rows.map(toSafeResult) : [];

  return {
    query: trimmedQuery,
    limit,
    numCandidates,
    sourceTypes,
    results,
  };
};

module.exports = {
  VECTOR_INDEX_NAME,
  DEFAULT_LIMIT,
  DEFAULT_NUM_CANDIDATES,
  VectorSearchError,
  searchKnowledge,
};
