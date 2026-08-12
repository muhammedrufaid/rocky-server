/**
 * Shared AI embedding foundation.
 *
 * Embeddings are stored on source documents (not separate collections).
 * Allowed sources only: blogs, areaguides, faqs, services, properties.
 */

const crypto = require('crypto');
const OpenAI = require('openai');

const Blog = require('../models/Blog');
const AreaGuide = require('../models/AreaGuide');
const Faq = require('../models/Faq');
const Service = require('../models/Service');
const Property = require('../models/Property');

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_BATCH_SIZE = 32;

/** Collections AI embedding code may read/write. */
const ALLOWED_COLLECTIONS = Object.freeze([
  'blogs',
  'areaguides',
  'faqs',
  'services',
  'properties',
]);

/** Must never be queried by AI embedding / RAG code. */
const FORBIDDEN_COLLECTIONS = Object.freeze([
  'areaguideleads',
  'binghattileads',
  'careers',
  'contacts',
  'dubaisouthleads',
  'jeweltowerleads',
  'landingpageleads',
  'newsletters',
  'propertymanagementleads',
  'sells',
  'teamtailorjobs',
  'users',
  'teammembers',
]);

const SOURCE_CONFIG = Object.freeze({
  blog: {
    model: Blog,
    collection: 'blogs',
    activeFilter: { isActive: true },
  },
  areaGuide: {
    model: AreaGuide,
    collection: 'areaguides',
    activeFilter: { isActive: true },
  },
  faq: {
    model: Faq,
    collection: 'faqs',
    activeFilter: { isActive: true },
  },
  service: {
    model: Service,
    collection: 'services',
    activeFilter: { isActive: true },
  },
  property: {
    model: Property,
    collection: 'properties',
    // Properties have no isActive; MongoDB inventory = current listings
    activeFilter: {},
  },
});

let openaiClient = null;

class EmbeddingServiceError extends Error {
  constructor(message, { statusCode = 502, category = 'embedding_error' } = {}) {
    super(message);
    this.name = 'EmbeddingServiceError';
    this.statusCode = statusCode;
    this.category = category;
  }
}

/**
 * Shared OpenAI client (singleton). Reuse this — do not create another client.
 * @returns {OpenAI}
 */
const getOpenAIClient = () => {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new EmbeddingServiceError('OPENAI_API_KEY is not configured.', {
      statusCode: 500,
      category: 'config_error',
    });
  }

  openaiClient = new OpenAI({ apiKey: String(apiKey).trim() });
  return openaiClient;
};

const asTrimmedString = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
};

const pushText = (parts, value) => {
  const text = asTrimmedString(value);
  if (text) parts.push(text);
};

/**
 * Extract public text from blog content blocks.
 * Skips image URLs / decorative fields.
 * @param {unknown} content
 * @returns {string}
 */
const extractBlogContentText = (content) => {
  if (!Array.isArray(content)) return '';

  const parts = [];

  content.forEach((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;

    const type = asTrimmedString(block.type).toLowerCase();

    if (type === 'paragraph' || type === 'heading2' || type === 'heading3') {
      pushText(parts, block.text);
      return;
    }

    if (type === 'list' && Array.isArray(block.items)) {
      block.items.forEach((item) => pushText(parts, item));
      return;
    }

    if (type === 'image') {
      pushText(parts, block.alt);
      pushText(parts, block.caption);
      return;
    }

    // Best-effort for unknown future text-like blocks (never include src/url fields)
    pushText(parts, block.text);
    if (Array.isArray(block.items)) {
      block.items.forEach((item) => pushText(parts, item));
    }
  });

  return parts.join('\n');
};

/**
 * Build searchable plain text from an approved source document.
 * Private / operational fields are never included.
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {object} doc
 * @returns {string}
 */
const buildSearchableText = (sourceType, doc) => {
  if (!doc || typeof doc !== 'object') {
    throw new EmbeddingServiceError('Document is required to build searchable text.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (!SOURCE_CONFIG[sourceType]) {
    throw new EmbeddingServiceError(`Unsupported embedding source: ${sourceType}`, {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const parts = [];

  if (sourceType === 'blog') {
    pushText(parts, doc.title);
    pushText(parts, doc.subtitle);
    pushText(parts, doc.description);
    pushText(parts, extractBlogContentText(doc.content));
  } else if (sourceType === 'areaGuide') {
    pushText(parts, doc.title);
    pushText(parts, doc.about);
    if (Array.isArray(doc.keyHighlights)) {
      doc.keyHighlights.forEach((item) => {
        if (item && typeof item === 'object') pushText(parts, item.title);
      });
    }
  } else if (sourceType === 'faq') {
    pushText(parts, doc.question);
    pushText(parts, doc.answer);
    pushText(parts, doc.page);
    pushText(parts, doc.slug);
  } else if (sourceType === 'service') {
    pushText(parts, doc.title);
    pushText(parts, doc.description);
    pushText(parts, doc.overviewHeading);
    if (Array.isArray(doc.overview)) {
      doc.overview.forEach((line) => pushText(parts, line));
    }
    if (Array.isArray(doc.subservices)) {
      doc.subservices.forEach((sub) => {
        if (!sub || typeof sub !== 'object') return;
        pushText(parts, sub.title);
        pushText(parts, sub.description);
        if (Array.isArray(sub.points)) {
          sub.points.forEach((point) => pushText(parts, point));
        }
      });
    }
  } else if (sourceType === 'property') {
    pushText(parts, doc.propertyTitle);
    pushText(parts, doc.propertyType);
    pushText(parts, doc.propertyPurpose);
    pushText(parts, doc.propertyDescription);
    pushText(parts, doc.city);
    pushText(parts, doc.locality);
    pushText(parts, doc.subLocality);
    pushText(parts, doc.towerName);
    pushText(parts, doc.bedrooms);
    pushText(parts, doc.bathrooms);
    pushText(parts, doc.propertySize);
    pushText(parts, doc.propertySizeUnit);
    pushText(parts, doc.furnished);
    pushText(parts, doc.offPlan);
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * SHA-256 hash of searchable text (hex).
 * @param {string} text
 * @returns {string}
 */
const hashSearchableText = (text) => {
  const normalized = typeof text === 'string' ? text : '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
};

/**
 * @param {number[]} embedding
 */
const assertEmbeddingDimensions = (embedding) => {
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingServiceError(
      `Expected embedding dimensions ${EMBEDDING_DIMENSIONS}, got ${
        Array.isArray(embedding) ? embedding.length : typeof embedding
      }.`,
      { statusCode: 502, category: 'invalid_embedding' }
    );
  }
  if (embedding.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new EmbeddingServiceError('Embedding contains non-numeric values.', {
      statusCode: 502,
      category: 'invalid_embedding',
    });
  }
};

/**
 * @param {string} text
 * @returns {Promise<number[]>}
 */
const generateEmbedding = async (text) => {
  const input = asTrimmedString(text);
  if (!input) {
    throw new EmbeddingServiceError('Text is required to generate an embedding.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  try {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });

    const embedding = response?.data?.[0]?.embedding;
    assertEmbeddingDimensions(embedding);
    return embedding;
  } catch (error) {
    if (error instanceof EmbeddingServiceError) throw error;

    const status = error?.status || error?.statusCode || 502;
    const message =
      error?.message ||
      'Failed to generate embedding from OpenAI.';

    throw new EmbeddingServiceError(message, {
      statusCode: status >= 400 && status < 600 ? status : 502,
      category: 'openai_error',
    });
  }
};

/**
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
const generateEmbeddings = async (texts) => {
  if (!Array.isArray(texts) || !texts.length) {
    throw new EmbeddingServiceError('texts must be a non-empty array.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const inputs = texts.map((t) => asTrimmedString(t));
  if (inputs.some((t) => !t)) {
    throw new EmbeddingServiceError('All texts must be non-empty strings.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  try {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs,
    });

    const rows = Array.isArray(response?.data) ? [...response.data] : [];
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    if (rows.length !== inputs.length) {
      throw new EmbeddingServiceError(
        `OpenAI returned ${rows.length} embeddings for ${inputs.length} inputs.`,
        { statusCode: 502, category: 'openai_error' }
      );
    }

    return rows.map((row) => {
      assertEmbeddingDimensions(row.embedding);
      return row.embedding;
    });
  } catch (error) {
    if (error instanceof EmbeddingServiceError) throw error;

    const status = error?.status || error?.statusCode || 502;
    throw new EmbeddingServiceError(
      error?.message || 'Failed to generate embeddings from OpenAI.',
      {
        statusCode: status >= 400 && status < 600 ? status : 502,
        category: 'openai_error',
      }
    );
  }
};

/**
 * @param {object} doc - may include embedding / embeddingHash when selected
 * @param {string} nextHash
 * @returns {boolean}
 */
const needsEmbeddingUpdate = (doc, nextHash) => {
  if (!doc) return true;
  const hasEmbedding =
    Array.isArray(doc.embedding) && doc.embedding.length === EMBEDDING_DIMENSIONS;
  const currentHash = asTrimmedString(doc.embeddingHash);
  if (!hasEmbedding) return true;
  if (!currentHash) return true;
  return currentHash !== nextHash;
};

/**
 * Sync embedding for one document onto its source collection.
 * Skips OpenAI when searchable hash is unchanged and a valid embedding exists.
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {import('mongoose').Types.ObjectId|string} documentId
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ status: string, hash?: string, collection?: string }>}
 */
const syncDocumentEmbedding = async (sourceType, documentId, options = {}) => {
  const dryRun = options.dryRun === true;
  const config = SOURCE_CONFIG[sourceType];

  if (!config) {
    throw new EmbeddingServiceError(`Unsupported embedding source: ${sourceType}`, {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (!ALLOWED_COLLECTIONS.includes(config.collection)) {
    throw new EmbeddingServiceError(
      `Collection ${config.collection} is not allowed for embeddings.`,
      { statusCode: 500, category: 'security' }
    );
  }

  if (FORBIDDEN_COLLECTIONS.includes(config.collection)) {
    throw new EmbeddingServiceError(
      `Refusing to embed forbidden collection: ${config.collection}`,
      { statusCode: 500, category: 'security' }
    );
  }

  const doc = await config.model
    .findById(documentId)
    .select('+embedding +embeddingHash')
    .lean();

  if (!doc) {
    return { status: 'missing', collection: config.collection };
  }

  const searchableText = buildSearchableText(sourceType, doc);
  if (!searchableText) {
    return { status: 'empty_text', collection: config.collection };
  }

  const hash = hashSearchableText(searchableText);

  if (!needsEmbeddingUpdate(doc, hash)) {
    return { status: 'skipped_unchanged', hash, collection: config.collection };
  }

  if (dryRun) {
    return { status: 'would_embed', hash, collection: config.collection };
  }

  const embedding = await generateEmbedding(searchableText);

  await config.model.updateOne(
    { _id: doc._id },
    { $set: { embedding, embeddingHash: hash } }
  );

  return { status: 'embedded', hash, collection: config.collection };
};

/**
 * Fire-and-forget embedding sync after CMS create/update.
 * Never throws to the caller — document save must succeed independently.
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {import('mongoose').Types.ObjectId|string} documentId
 */
const scheduleDocumentEmbedding = (sourceType, documentId) => {
  if (!documentId) return;

  setImmediate(() => {
    syncDocumentEmbedding(sourceType, documentId).catch((error) => {
      console.error('[ai-embedding] sync failed', {
        sourceType,
        documentId: String(documentId),
        category: error?.category || 'unexpected_error',
        message: error?.message || String(error),
      });
    });
  });
};

/**
 * Process many documents for a source type (used by scripts / migrate).
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {{ dryRun?: boolean, batchSize?: number, limit?: number, onProgress?: Function }} [options]
 */
const syncSourceEmbeddings = async (sourceType, options = {}) => {
  const dryRun = options.dryRun === true;
  const batchSize = Math.max(1, parseInt(options.batchSize, 10) || DEFAULT_BATCH_SIZE);
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10)) : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const config = SOURCE_CONFIG[sourceType];
  if (!config) {
    throw new EmbeddingServiceError(`Unsupported embedding source: ${sourceType}`, {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const query = config.model
    .find(config.activeFilter)
    .select('+embedding +embeddingHash')
    .lean();

  if (limit) query.limit(limit);

  const docs = await query;
  const summary = {
    sourceType,
    collection: config.collection,
    scanned: docs.length,
    skippedUnchanged: 0,
    emptyText: 0,
    embedded: 0,
    wouldEmbed: 0,
    failed: 0,
  };

  const pending = [];

  for (const doc of docs) {
    const searchableText = buildSearchableText(sourceType, doc);
    if (!searchableText) {
      summary.emptyText += 1;
      continue;
    }

    const hash = hashSearchableText(searchableText);
    if (!needsEmbeddingUpdate(doc, hash)) {
      summary.skippedUnchanged += 1;
      continue;
    }

    pending.push({ doc, hash, searchableText });
  }

  if (dryRun) {
    summary.wouldEmbed = pending.length;
    if (onProgress) onProgress({ ...summary, phase: 'dry-run' });
    return summary;
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const texts = batch.map((item) => item.searchableText);

    try {
      const embeddings = await generateEmbeddings(texts);

      await Promise.all(
        batch.map((item, index) =>
          config.model.updateOne(
            { _id: item.doc._id },
            { $set: { embedding: embeddings[index], embeddingHash: item.hash } }
          )
        )
      );

      summary.embedded += batch.length;
    } catch (error) {
      // Fall back to per-document so one bad row does not abort the whole batch
      for (const item of batch) {
        try {
          const embedding = await generateEmbedding(item.searchableText);
          await config.model.updateOne(
            { _id: item.doc._id },
            { $set: { embedding, embeddingHash: item.hash } }
          );
          summary.embedded += 1;
        } catch (itemError) {
          summary.failed += 1;
          console.error('[ai-embedding] document embed failed', {
            sourceType,
            id: String(item.doc._id),
            message: itemError?.message || String(itemError),
          });
        }
      }
    }

    if (onProgress) {
      onProgress({
        ...summary,
        phase: 'embedding',
        processedPending: Math.min(i + batch.length, pending.length),
        pendingTotal: pending.length,
      });
    }
  }

  return summary;
};

/**
 * Background property re-embed after Salesforce migrate (non-blocking).
 */
const schedulePropertyEmbeddingsAfterMigrate = () => {
  setImmediate(() => {
    syncSourceEmbeddings('property', { batchSize: DEFAULT_BATCH_SIZE })
      .then((summary) => {
        console.log('[ai-embedding] property sync after migrate', summary);
      })
      .catch((error) => {
        console.error('[ai-embedding] property sync after migrate failed', {
          message: error?.message || String(error),
        });
      });
  });
};

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  ALLOWED_COLLECTIONS,
  FORBIDDEN_COLLECTIONS,
  SOURCE_CONFIG,
  EmbeddingServiceError,
  getOpenAIClient,
  buildSearchableText,
  hashSearchableText,
  needsEmbeddingUpdate,
  generateEmbedding,
  generateEmbeddings,
  syncDocumentEmbedding,
  scheduleDocumentEmbedding,
  syncSourceEmbeddings,
  schedulePropertyEmbeddingsAfterMigrate,
  extractBlogContentText,
};
