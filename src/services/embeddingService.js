const crypto = require('crypto');
const { getClient, mapOpenAIError, OpenAIServiceError } = require('./openaiService');

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
/** text-embedding-3-small default output size (confirmed at runtime too). */
const EXPECTED_EMBEDDING_DIMENSION = 1536;

/**
 * @returns {string}
 */
const getEmbeddingModel = () => {
  const model = process.env.OPENAI_EMBEDDING_MODEL;
  if (!model || typeof model !== 'string' || !model.trim()) {
    return DEFAULT_EMBEDDING_MODEL;
  }
  return model.trim();
};

/**
 * @returns {number}
 */
const getEmbeddingBatchSize = () => {
  const n = Number.parseInt(String(process.env.OPENAI_EMBEDDING_BATCH_SIZE || ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_EMBEDDING_BATCH_SIZE;
  // OpenAI allows up to 2048 inputs per embeddings request
  return Math.min(n, 2048);
};

/**
 * SHA-256 of trimmed content — used to skip unchanged re-embeds.
 * @param {string} content
 * @returns {string}
 */
const hashContent = (content) =>
  crypto.createHash('sha256').update(String(content || '').trim()).digest('hex');

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isMeaningfulText = (value) =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Validate one embedding vector from OpenAI.
 * @param {unknown} vector
 * @param {number} [expectedDimension]
 * @returns {number[]}
 */
const assertValidEmbedding = (vector, expectedDimension = EXPECTED_EMBEDDING_DIMENSION) => {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new OpenAIServiceError('Malformed embedding response: empty vector.', {
      statusCode: 502,
      category: 'malformed_embedding',
    });
  }

  if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new OpenAIServiceError('Malformed embedding response: non-numeric vector.', {
      statusCode: 502,
      category: 'malformed_embedding',
    });
  }

  if (expectedDimension && vector.length !== expectedDimension) {
    throw new OpenAIServiceError(
      `Unexpected embedding dimension: got ${vector.length}, expected ${expectedDimension}.`,
      {
        statusCode: 502,
        category: 'unexpected_dimension',
      }
    );
  }

  return vector;
};

/**
 * Generate embeddings for an array of texts using text-embedding-3-small.
 * Batches requests. Skips empty/whitespace inputs (reports them).
 *
 * @param {string[]} texts
 * @param {{ model?: string, batchSize?: number, expectedDimension?: number }} [options]
 * @returns {Promise<{
 *   model: string,
 *   dimension: number|null,
 *   embeddings: Array<number[]|null>,
 *   skippedIndexes: number[],
 *   requestCount: number,
 * }>}
 */
const generateEmbeddings = async (texts, options = {}) => {
  if (!Array.isArray(texts)) {
    throw new OpenAIServiceError('texts must be an array of strings.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const model = options.model || getEmbeddingModel();
  const batchSize = options.batchSize || getEmbeddingBatchSize();
  const expectedDimension =
    options.expectedDimension !== undefined
      ? options.expectedDimension
      : EXPECTED_EMBEDDING_DIMENSION;

  const embeddings = new Array(texts.length).fill(null);
  const skippedIndexes = [];
  const pending = [];

  texts.forEach((text, index) => {
    if (!isMeaningfulText(text)) {
      skippedIndexes.push(index);
      return;
    }
    pending.push({ index, text: text.trim() });
  });

  if (!pending.length) {
    return {
      model,
      dimension: null,
      embeddings,
      skippedIndexes,
      requestCount: 0,
    };
  }

  const openai = getClient();
  let requestCount = 0;
  let observedDimension = null;
  const startedAt = Date.now();

  console.log('[Embeddings] request started', {
    model,
    totalTexts: texts.length,
    toEmbed: pending.length,
    skipped: skippedIndexes.length,
    batchSize,
  });

  try {
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const batchNumber = Math.floor(offset / batchSize) + 1;
      const totalBatches = Math.ceil(pending.length / batchSize);

      console.log('[Embeddings] batch started', {
        batchNumber,
        totalBatches,
        textsInBatch: batch.length,
      });

      const response = await openai.embeddings.create({
        model,
        input: batch.map((item) => item.text),
      });

      requestCount += 1;

      const data = Array.isArray(response?.data) ? response.data : [];
      if (data.length !== batch.length) {
        throw new OpenAIServiceError(
          `Malformed embedding response: expected ${batch.length} vectors, got ${data.length}.`,
          {
            statusCode: 502,
            category: 'malformed_embedding',
          }
        );
      }

      // OpenAI may return data sorted by index within the batch
      const byIndex = [...data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0)
      );

      byIndex.forEach((item, i) => {
        const vector = assertValidEmbedding(item?.embedding, expectedDimension);
        if (observedDimension === null) {
          observedDimension = vector.length;
        } else if (vector.length !== observedDimension) {
          throw new OpenAIServiceError(
            `Inconsistent embedding dimension within batch: ${vector.length} vs ${observedDimension}.`,
            {
              statusCode: 502,
              category: 'unexpected_dimension',
            }
          );
        }
        embeddings[batch[i].index] = vector;
      });

      console.log('[Embeddings] batch completed', {
        batchNumber,
        totalBatches,
        textsInBatch: batch.length,
        dimension: observedDimension,
      });
    }

    console.log('[Embeddings] request completed', {
      model,
      requestCount,
      embedded: pending.length,
      skipped: skippedIndexes.length,
      dimension: observedDimension,
      durationMs: Date.now() - startedAt,
    });

    return {
      model,
      dimension: observedDimension,
      embeddings,
      skippedIndexes,
      requestCount,
    };
  } catch (error) {
    const mapped = mapOpenAIError(error);
    console.error('[Embeddings] request failed', {
      model,
      requestCount,
      category: mapped.category,
      statusCode: mapped.statusCode,
      durationMs: Date.now() - startedAt,
    });
    throw mapped;
  }
};

/**
 * Convenience: embed a single non-empty string.
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<{ model: string, dimension: number, embedding: number[] }>}
 */
const generateEmbedding = async (text, options = {}) => {
  if (!isMeaningfulText(text)) {
    throw new OpenAIServiceError('Cannot embed empty content.', {
      statusCode: 400,
      category: 'empty_content',
    });
  }

  const result = await generateEmbeddings([text], options);
  const embedding = result.embeddings[0];
  if (!embedding) {
    throw new OpenAIServiceError('Embedding generation returned no vector.', {
      statusCode: 502,
      category: 'malformed_embedding',
    });
  }

  return {
    model: result.model,
    dimension: result.dimension,
    embedding,
  };
};

module.exports = {
  generateEmbeddings,
  generateEmbedding,
  getEmbeddingModel,
  getEmbeddingBatchSize,
  hashContent,
  isMeaningfulText,
  assertValidEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  EXPECTED_EMBEDDING_DIMENSION,
};
