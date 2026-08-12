const BlogEmbedding = require('../models/BlogEmbedding');
const {
  generateEmbedding,
  EXPECTED_EMBEDDING_DIMENSION,
} = require('./embeddingService');
const { OpenAIServiceError } = require('./openaiService');

const VECTOR_INDEX_NAME = 'blog_vector_index';
const DEFAULT_LIMIT = 5;
const DEFAULT_NUM_CANDIDATES = 40;

/**
 * Typed error for blog vector search failures.
 */
class BlogVectorSearchError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, category?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'BlogVectorSearchError';
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
  const limit = parsePositiveInt(process.env.BLOG_VECTOR_SEARCH_LIMIT, DEFAULT_LIMIT);
  let numCandidates = parsePositiveInt(
    process.env.BLOG_VECTOR_SEARCH_CANDIDATES,
    DEFAULT_NUM_CANDIDATES
  );

  // Atlas requires numCandidates >= limit
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
const mapSearchResult = (doc) => ({
  id: doc._id ? String(doc._id) : null,
  blogId: doc.blogId ? String(doc.blogId) : null,
  slug: doc.slug || null,
  title: doc.title || null,
  category: doc.category || null,
  chunkIndex: typeof doc.chunkIndex === 'number' ? doc.chunkIndex : null,
  headingContext: doc.headingContext || null,
  content: doc.content || null,
  score: typeof doc.score === 'number' ? doc.score : null,
});

/**
 * Run Atlas Vector Search against blog_embeddings only.
 *
 * @param {number[]} queryVector
 * @param {{ limit?: number, numCandidates?: number, indexName?: string }} [options]
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
    throw new BlogVectorSearchError(
      `Invalid query embedding dimension. Expected ${EXPECTED_EMBEDDING_DIMENSION}.`,
      { statusCode: 502, category: 'invalid_query_embedding' }
    );
  }

  const pipeline = [
    {
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector,
        numCandidates,
        limit,
      },
    },
    {
      $project: {
        _id: 1,
        blogId: 1,
        slug: 1,
        title: 1,
        category: 1,
        chunkIndex: 1,
        headingContext: 1,
        content: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  try {
    // Hard-scope to BlogEmbedding model / blog_embeddings collection only.
    const docs = await BlogEmbedding.aggregate(pipeline);
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
      throw new BlogVectorSearchError(
        'Blog vector search index is unavailable. Please try again later.',
        { statusCode: 503, category: 'vector_index_unavailable' }
      );
    }

    console.error('[BlogVectorSearch] MongoDB search failed', {
      category: 'mongodb_vector_search_error',
      name: error?.name,
    });

    throw new BlogVectorSearchError('Blog vector search failed.', {
      statusCode: 502,
      category: 'mongodb_vector_search_error',
    });
  }
};

/**
 * Natural-language search over public blog embeddings.
 *
 * Flow: query → text-embedding-3-small → Atlas $vectorSearch → chunks
 * Does NOT call gpt-5-nano. Does NOT generate answers.
 *
 * @param {string} query
 * @param {{ limit?: number, numCandidates?: number }} [options]
 * @returns {Promise<{
 *   query: string,
 *   results: object[],
 *   timings: { embeddingMs: number, vectorSearchMs: number, totalMs: number },
 *   model: string,
 *   dimension: number,
 * }>}
 */
const searchBlogChunks = async (query, options = {}) => {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new BlogVectorSearchError('Query is required.', {
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
    throw new BlogVectorSearchError('Failed to generate query embedding.', {
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
  };
};

module.exports = {
  searchBlogChunks,
  runVectorSearch,
  getSearchConfig,
  BlogVectorSearchError,
  VECTOR_INDEX_NAME,
  DEFAULT_LIMIT,
  DEFAULT_NUM_CANDIDATES,
};
