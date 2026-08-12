const KnowledgeEmbedding = require('../models/KnowledgeEmbedding');
const {
  generateEmbedding,
  EXPECTED_EMBEDDING_DIMENSION,
} = require('./embeddingService');
const { OpenAIServiceError } = require('./openaiService');

const VECTOR_INDEX_NAME = 'knowledge_vector_index';
const DEFAULT_LIMIT = 5;
const DEFAULT_NUM_CANDIDATES = 40;
const ALLOWED_SOURCE_TYPES = new Set(['area_guide', 'faq']);

/**
 * Typed error for knowledge vector search failures.
 */
class KnowledgeVectorSearchError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, category?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'KnowledgeVectorSearchError';
    this.statusCode = options.statusCode || 502;
    this.category = options.category || 'vector_search_error';
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @returns {{ limit: number, numCandidates: number, indexName: string }}
 */
const getSearchConfig = () => {
  const limit = parsePositiveInt(process.env.KNOWLEDGE_VECTOR_SEARCH_LIMIT, DEFAULT_LIMIT);
  let numCandidates = parsePositiveInt(
    process.env.KNOWLEDGE_VECTOR_SEARCH_CANDIDATES,
    DEFAULT_NUM_CANDIDATES
  );

  if (numCandidates < limit) {
    numCandidates = Math.max(limit * 4, limit);
  }

  return {
    limit,
    numCandidates,
    indexName: VECTOR_INDEX_NAME,
  };
};

/**
 * Map a MongoDB $vectorSearch hit into a safe public result object.
 * Never includes the embedding vector.
 * @param {object} doc
 * @returns {object}
 */
const mapSearchResult = (doc) => {
  const out = {
    sourceType: doc.sourceType || null,
    sourceId: doc.sourceId ? String(doc.sourceId) : null,
    chunkIndex: typeof doc.chunkIndex === 'number' ? doc.chunkIndex : null,
    content: doc.content || null,
    score: typeof doc.score === 'number' ? doc.score : null,
  };

  if (doc.slug) out.slug = doc.slug;
  if (doc.title) out.title = doc.title;
  if (doc.category) out.category = doc.category;
  if (doc.question) out.question = doc.question;
  if (doc.path) out.path = doc.path;

  return out;
};

/**
 * Run Atlas Vector Search against knowledge_embeddings only.
 *
 * @param {number[]} queryVector
 * @param {{
 *   limit?: number,
 *   numCandidates?: number,
 *   indexName?: string,
 *   sourceType?: 'area_guide'|'faq',
 * }} [options]
 * @returns {Promise<object[]>}
 */
const runVectorSearch = async (queryVector, options = {}) => {
  const config = getSearchConfig();
  const limit = options.limit || config.limit;
  const numCandidates = Math.max(
    options.numCandidates || config.numCandidates,
    limit
  );
  const indexName = options.indexName || config.indexName;

  if (!Array.isArray(queryVector) || queryVector.length !== EXPECTED_EMBEDDING_DIMENSION) {
    throw new KnowledgeVectorSearchError(
      `Invalid query embedding dimension. Expected ${EXPECTED_EMBEDDING_DIMENSION}.`,
      { statusCode: 502, category: 'invalid_query_embedding' }
    );
  }

  let sourceType = options.sourceType;
  if (sourceType !== undefined && sourceType !== null && sourceType !== '') {
    sourceType = String(sourceType).trim();
    if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
      throw new KnowledgeVectorSearchError(
        'Unsupported sourceType. Allowed: area_guide, faq.',
        { statusCode: 400, category: 'invalid_source_type' }
      );
    }
  } else {
    sourceType = undefined;
  }

  const vectorSearchStage = {
    index: indexName,
    path: 'embedding',
    queryVector,
    numCandidates,
    limit,
  };

  if (sourceType) {
    vectorSearchStage.filter = { sourceType };
  }

  const pipeline = [
    { $vectorSearch: vectorSearchStage },
    {
      $project: {
        _id: 0,
        sourceType: 1,
        sourceId: 1,
        slug: 1,
        title: 1,
        category: 1,
        question: 1,
        path: 1,
        chunkIndex: 1,
        content: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  try {
    const docs = await KnowledgeEmbedding.aggregate(pipeline);
    return docs.map(mapSearchResult);
  } catch (error) {
    const message = String(error?.message || '');
    const lower = message.toLowerCase();

    if (
      lower.includes('index not found') ||
      lower.includes('does not have a search index') ||
      lower.includes(`search index '${indexName.toLowerCase()}' not found`) ||
      lower.includes('no search index')
    ) {
      throw new KnowledgeVectorSearchError(
        'Knowledge vector search index is unavailable. Please try again later.',
        { statusCode: 503, category: 'vector_index_unavailable' }
      );
    }

    console.error('[KnowledgeVectorSearch] MongoDB search failed', {
      category: 'mongodb_vector_search_error',
      name: error?.name,
      message: error?.message,
    });

    throw new KnowledgeVectorSearchError('Knowledge vector search failed.', {
      statusCode: 502,
      category: 'mongodb_vector_search_error',
    });
  }
};

/**
 * Natural-language search over public Area Guide / FAQ embeddings.
 * Does NOT call gpt-5-nano. Does NOT generate answers.
 *
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   numCandidates?: number,
 *   sourceType?: 'area_guide'|'faq',
 * }} [options]
 */
const searchKnowledge = async (query, options = {}) => {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new KnowledgeVectorSearchError('Query is required.', {
      statusCode: 400,
      category: 'invalid_query',
    });
  }

  const totalStarted = Date.now();

  let embeddingResult;
  const embedStarted = Date.now();
  try {
    embeddingResult = await generateEmbedding(trimmed);
  } catch (error) {
    if (error instanceof OpenAIServiceError) {
      throw error;
    }
    throw new KnowledgeVectorSearchError('Failed to generate query embedding.', {
      statusCode: 502,
      category: 'embedding_error',
    });
  }
  const embeddingMs = Date.now() - embedStarted;

  const searchStarted = Date.now();
  const results = await runVectorSearch(embeddingResult.embedding, options);
  const vectorSearchMs = Date.now() - searchStarted;

  return {
    query: trimmed,
    results,
    timings: {
      embeddingMs,
      vectorSearchMs,
      totalMs: Date.now() - totalStarted,
    },
    model: embeddingResult.model,
    dimension: embeddingResult.dimension,
    sourceTypeFilter: options.sourceType || null,
  };
};

module.exports = {
  searchKnowledge,
  runVectorSearch,
  getSearchConfig,
  KnowledgeVectorSearchError,
  VECTOR_INDEX_NAME,
  DEFAULT_LIMIT,
  DEFAULT_NUM_CANDIDATES,
  ALLOWED_SOURCE_TYPES,
};
