/**
 * Shared AI embedding service.
 *
 * Primary path: upsert public knowledge into `ai_knowledge` (AiKnowledge).
 * Legacy path: still writes embedding fields onto source documents so existing
 * CMS / migrate callers keep working until a later migration step.
 *
 * Allowed sources only: blog, areaGuide, faq, service, property.
 */

const crypto = require('crypto');
const OpenAI = require('openai');

const AiKnowledge = require('../models/AiKnowledge');
const Blog = require('../models/Blog');
const AreaGuide = require('../models/AreaGuide');
const Faq = require('../models/Faq');
const { FAQ_PAGES } = Faq;
const Service = require('../models/Service');
const Property = require('../models/Property');

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.OPENAI_EMBEDDING_BATCH_SIZE, 10) || 32
);

/** Collections AI embedding code may read. */
const ALLOWED_COLLECTIONS = Object.freeze([
  'blogs',
  'areaguides',
  'faqs',
  'services',
  'properties',
  'ai_knowledge',
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

const REJECTED_SOURCE_TYPES = Object.freeze([
  'teamMember',
  'users',
  'contacts',
  'careers',
  'leads',
  'agents',
]);

let openaiClient = null;

class EmbeddingServiceError extends Error {
  constructor(message, { statusCode = 502, category = 'embedding_error' } = {}) {
    super(message);
    this.name = 'EmbeddingServiceError';
    this.statusCode = statusCode;
    this.category = category;
  }
}

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
 * Remove currency placeholders without inventing a replacement value.
 * @param {string} text
 * @returns {string}
 */
const normalizePlaceholders = (text) =>
  String(text || '')
    .replace(/\{\{\s*DIRHAM\s*\}\}/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Strip contact / PII noise that often appears inside public marketing copy
 * (e.g. propertyDescription footers with company email / phone / call CTAs).
 * Does not invent replacement values.
 * @param {string} text
 * @returns {string}
 */
const sanitizeContactNoise = (text) =>
  String(text || '')
    // Emails
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    // UAE / local phone styles (+971..., 05x..., 04 ...)
    .replace(/(?:\+971[\s-]?)?(?:0?5[0-9]|0?4)[\s-]?\d{3}[\s-]?\d{4}/g, '')
    // Generic xxx-xxx-xxxx / xxx xxx xxxx
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '')
    // Agent BRN call lines commonly pasted into listing descriptions
    .replace(/^.*\bBRN\s*#?\s*\d+.*$/gim, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Extract public text from blog content blocks (skips image URLs).
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

    pushText(parts, block.text);
    if (Array.isArray(block.items)) {
      block.items.forEach((item) => pushText(parts, item));
    }
  });

  return parts.join('\n');
};

const buildBlogText = (doc) => {
  const parts = [];
  pushText(parts, doc.title);
  pushText(parts, doc.subtitle);
  pushText(parts, doc.description);
  pushText(parts, extractBlogContentText(doc.content));
  return parts.join('\n');
};

const buildAreaGuideText = (doc) => {
  const parts = [];
  pushText(parts, doc.title);
  pushText(parts, doc.about);
  if (Array.isArray(doc.keyHighlights)) {
    doc.keyHighlights.forEach((item) => {
      if (item && typeof item === 'object') pushText(parts, item.title);
    });
  }
  return parts.join('\n');
};

const buildFaqText = (doc) => {
  const parts = [];
  pushText(parts, doc.question);
  pushText(parts, normalizePlaceholders(doc.answer));
  pushText(parts, doc.page);
  pushText(parts, doc.slug);
  return parts.join('\n');
};

const buildServiceText = (doc) => {
  const parts = [];
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
  return parts.join('\n');
};

const buildPropertyText = (doc) => {
  const parts = [];
  pushText(parts, doc.propertyRefNo);
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
  pushText(parts, doc.propertyStatus);
  return parts.join('\n');
};

/**
 * Single source configuration for all approved knowledge types.
 */
const SOURCE_CONFIG = Object.freeze({
  blog: Object.freeze({
    sourceType: 'blog',
    model: Blog,
    collection: 'blogs',
    activeFilter: { isActive: true },
    buildText: buildBlogText,
    resolveTitle: (doc) => asTrimmedString(doc.title) || undefined,
    resolveSlug: (doc) => asTrimmedString(doc.slug).toLowerCase() || undefined,
    resolveMetadata: () => undefined,
  }),
  areaGuide: Object.freeze({
    sourceType: 'areaGuide',
    model: AreaGuide,
    collection: 'areaguides',
    activeFilter: { isActive: true },
    buildText: buildAreaGuideText,
    resolveTitle: (doc) => asTrimmedString(doc.title) || undefined,
    resolveSlug: (doc) => asTrimmedString(doc.slug).toLowerCase() || undefined,
    resolveMetadata: () => undefined,
  }),
  faq: Object.freeze({
    sourceType: 'faq',
    model: Faq,
    collection: 'faqs',
    activeFilter: {
      isActive: true,
      page: { $ne: FAQ_PAGES.CAREERS },
    },
    buildText: buildFaqText,
    resolveTitle: (doc) => asTrimmedString(doc.question) || undefined,
    resolveSlug: (doc) => asTrimmedString(doc.slug).toLowerCase() || undefined,
    resolveMetadata: (doc) => {
      const page = asTrimmedString(doc.page);
      return page ? { page } : undefined;
    },
  }),
  service: Object.freeze({
    sourceType: 'service',
    model: Service,
    collection: 'services',
    activeFilter: { isActive: true },
    buildText: buildServiceText,
    resolveTitle: (doc) => asTrimmedString(doc.title) || undefined,
    resolveSlug: (doc) => asTrimmedString(doc.slug).toLowerCase() || undefined,
    resolveMetadata: () => undefined,
  }),
  property: Object.freeze({
    sourceType: 'property',
    model: Property,
    collection: 'properties',
    activeFilter: {},
    buildText: buildPropertyText,
    resolveTitle: (doc) => asTrimmedString(doc.propertyTitle) || undefined,
    resolveSlug: (doc) =>
      asTrimmedString(doc.propertyRefNo).toLowerCase() || undefined,
    resolveMetadata: (doc) => {
      const metadata = {};
      const propertyType = asTrimmedString(doc.propertyType);
      const propertyPurpose = asTrimmedString(doc.propertyPurpose);
      const city = asTrimmedString(doc.city);
      const locality = asTrimmedString(doc.locality);
      if (propertyType) metadata.propertyType = propertyType;
      if (propertyPurpose) metadata.propertyPurpose = propertyPurpose;
      if (city) metadata.city = city;
      if (locality) metadata.locality = locality;
      return Object.keys(metadata).length ? metadata : undefined;
    },
  }),
});

const assertAllowedSource = (sourceType) => {
  if (REJECTED_SOURCE_TYPES.includes(sourceType)) {
    throw new EmbeddingServiceError(
      `Rejected embedding source type: ${sourceType}`,
      { statusCode: 400, category: 'security' }
    );
  }

  const config = SOURCE_CONFIG[sourceType];
  if (!config) {
    throw new EmbeddingServiceError(`Unsupported embedding source: ${sourceType}`, {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (FORBIDDEN_COLLECTIONS.includes(config.collection)) {
    throw new EmbeddingServiceError(
      `Refusing to embed forbidden collection: ${config.collection}`,
      { statusCode: 500, category: 'security' }
    );
  }

  if (!ALLOWED_COLLECTIONS.includes(config.collection)) {
    throw new EmbeddingServiceError(
      `Collection ${config.collection} is not allowed for embeddings.`,
      { statusCode: 500, category: 'security' }
    );
  }

  return config;
};

/**
 * Shared OpenAI client (singleton).
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

/**
 * Build searchable plain text from an approved source document.
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

  const config = assertAllowedSource(sourceType);
  const raw = config.buildText(doc);
  return sanitizeContactNoise(
    normalizePlaceholders(String(raw || ''))
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 * Generate one embedding vector. Does not write to MongoDB.
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
    throw new EmbeddingServiceError(
      error?.message || 'Failed to generate embedding from OpenAI.',
      {
        statusCode: status >= 400 && status < 600 ? status : 502,
        category: 'openai_error',
      }
    );
  }
};

/**
 * Batch embedding generation.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
const embedTexts = async (texts) => {
  if (!Array.isArray(texts) || !texts.length) {
    throw new EmbeddingServiceError('texts must be a non-empty array.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  const inputs = texts.map((text, index) => {
    const value = asTrimmedString(text);
    if (!value) {
      throw new EmbeddingServiceError(`texts[${index}] is empty.`, {
        statusCode: 400,
        category: 'invalid_request',
      });
    }
    return value;
  });

  try {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs,
    });

    const rows = Array.isArray(response?.data) ? response.data : [];
    if (rows.length !== inputs.length) {
      throw new EmbeddingServiceError(
        `OpenAI returned ${rows.length} embeddings for ${inputs.length} inputs.`,
        { statusCode: 502, category: 'invalid_embedding' }
      );
    }

    return rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((row) => {
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

/** @deprecated Prefer embedTexts — kept for legacy script callers. */
const generateEmbeddings = embedTexts;

const isCareersFaq = (doc) =>
  asTrimmedString(doc?.page).toLowerCase() === FAQ_PAGES.CAREERS;

const hasValidEmbedding = (doc) =>
  Array.isArray(doc?.embedding) && doc.embedding.length === EMBEDDING_DIMENSIONS;

const needsEmbeddingUpdate = (doc, nextHash) => {
  if (!doc) return true;
  if (!hasValidEmbedding(doc)) return true;
  const currentHash = asTrimmedString(doc.embeddingHash);
  if (!currentHash) return true;
  return currentHash !== nextHash;
};

/**
 * Upsert one AiKnowledge embedding for a source document.
 * Skips OpenAI + Mongo write when embeddingHash is unchanged.
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {object} document
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<{ status: string, sourceType: string, sourceId?: string, hash?: string }>}
 */
const upsertKnowledgeEmbedding = async (sourceType, document, options = {}) => {
  const dryRun = options.dryRun === true;
  const config = assertAllowedSource(sourceType);

  if (!document || typeof document !== 'object') {
    throw new EmbeddingServiceError('Document is required for knowledge upsert.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (!document._id) {
    throw new EmbeddingServiceError('Document _id is required for knowledge upsert.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  if (sourceType === 'faq' && isCareersFaq(document)) {
    return {
      status: 'skipped_careers',
      sourceType,
      sourceId: String(document._id),
    };
  }

  const content = buildSearchableText(sourceType, document);
  if (!content) {
    return {
      status: 'empty_text',
      sourceType,
      sourceId: String(document._id),
    };
  }

  const sourceId = String(document._id);
  const hash = hashSearchableText(content);
  const title = config.resolveTitle(document);
  const slug = config.resolveSlug(document);
  const metadata = config.resolveMetadata(document);

  const existing = await AiKnowledge.findOne({ sourceType, sourceId })
    .select('+embedding +embeddingHash')
    .lean();

  if (existing && !needsEmbeddingUpdate(existing, hash)) {
    return { status: 'skipped_unchanged', sourceType, sourceId, hash };
  }

  if (dryRun) {
    return {
      status: existing ? 'would_update' : 'would_create',
      sourceType,
      sourceId,
      hash,
    };
  }

  const embedding = await generateEmbedding(content);

  const payload = {
    sourceType,
    sourceId,
    title,
    content,
    slug,
    metadata,
    embedding,
    embeddingHash: hash,
  };

  await AiKnowledge.findOneAndUpdate(
    { sourceType, sourceId },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    status: existing ? 'updated' : 'created',
    sourceType,
    sourceId,
    hash,
  };
};

/**
 * Sync AiKnowledge embeddings for one source type (batch + hash skip).
 *
 * @param {'blog'|'areaGuide'|'faq'|'service'|'property'} sourceType
 * @param {{ dryRun?: boolean, batchSize?: number, limit?: number, onProgress?: Function }} [options]
 */
const syncKnowledgeEmbeddings = async (sourceType, options = {}) => {
  const dryRun = options.dryRun === true;
  const batchSize = Math.max(
    1,
    parseInt(options.batchSize, 10) || DEFAULT_BATCH_SIZE
  );
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10)) : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const config = assertAllowedSource(sourceType);

  const query = config.model.find(config.activeFilter).lean();
  if (limit) query.limit(limit);

  const docs = await query;
  const summary = {
    sourceType,
    collection: config.collection,
    scanned: docs.length,
    skippedUnchanged: 0,
    skippedCareers: 0,
    emptyText: 0,
    embedded: 0,
    wouldEmbed: 0,
    failed: 0,
  };

  const pending = [];

  for (const doc of docs) {
    if (sourceType === 'faq' && isCareersFaq(doc)) {
      summary.skippedCareers += 1;
      continue;
    }

    const content = buildSearchableText(sourceType, doc);
    if (!content) {
      summary.emptyText += 1;
      continue;
    }

    const sourceId = String(doc._id);
    const hash = hashSearchableText(content);

    const existing = await AiKnowledge.findOne({ sourceType, sourceId })
      .select('+embedding +embeddingHash')
      .lean();

    if (existing && !needsEmbeddingUpdate(existing, hash)) {
      summary.skippedUnchanged += 1;
      continue;
    }

    pending.push({
      doc,
      sourceId,
      hash,
      content,
      title: config.resolveTitle(doc),
      slug: config.resolveSlug(doc),
      metadata: config.resolveMetadata(doc),
      existing,
    });
  }

  if (dryRun) {
    summary.wouldEmbed = pending.length;
    if (onProgress) onProgress({ ...summary, phase: 'dry-run' });
    return summary;
  }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const texts = batch.map((item) => item.content);

    try {
      const embeddings = await embedTexts(texts);

      await Promise.all(
        batch.map((item, index) =>
          AiKnowledge.findOneAndUpdate(
            { sourceType, sourceId: item.sourceId },
            {
              $set: {
                sourceType,
                sourceId: item.sourceId,
                title: item.title,
                content: item.content,
                slug: item.slug,
                metadata: item.metadata,
                embedding: embeddings[index],
                embeddingHash: item.hash,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          )
        )
      );

      summary.embedded += batch.length;
    } catch (error) {
      for (const item of batch) {
        try {
          const result = await upsertKnowledgeEmbedding(sourceType, item.doc, {
            dryRun: false,
          });
          if (result.status === 'created' || result.status === 'updated') {
            summary.embedded += 1;
          } else if (result.status === 'skipped_unchanged') {
            summary.skippedUnchanged += 1;
          } else if (result.status === 'empty_text') {
            summary.emptyText += 1;
          }
        } catch (itemError) {
          summary.failed += 1;
          console.error('[ai-embedding] knowledge upsert failed', {
            sourceType,
            sourceId: item.sourceId,
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

/* -------------------------------------------------------------------------- */
/* Legacy source-document embedding path (kept until CMS migrate cutover)     */
/* -------------------------------------------------------------------------- */

/**
 * Sync embedding for one document onto its source collection.
 * @deprecated Prefer upsertKnowledgeEmbedding — kept for existing callers.
 */
const syncDocumentEmbedding = async (sourceType, documentId, options = {}) => {
  const dryRun = options.dryRun === true;
  const config = assertAllowedSource(sourceType);

  const doc = await config.model
    .findById(documentId)
    .select('+embedding +embeddingHash')
    .lean();

  if (!doc) {
    return { status: 'missing', collection: config.collection };
  }

  if (sourceType === 'faq' && isCareersFaq(doc)) {
    return { status: 'skipped_careers', collection: config.collection };
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
 * Fire-and-forget legacy source-document embedding sync after CMS create/update.
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
 * Legacy batch sync writing embeddings onto source documents.
 * @deprecated Prefer syncKnowledgeEmbeddings.
 */
const syncSourceEmbeddings = async (sourceType, options = {}) => {
  const dryRun = options.dryRun === true;
  const batchSize = Math.max(
    1,
    parseInt(options.batchSize, 10) || DEFAULT_BATCH_SIZE
  );
  const limit = options.limit ? Math.max(1, parseInt(options.limit, 10)) : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const config = assertAllowedSource(sourceType);

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
    if (sourceType === 'faq' && isCareersFaq(doc)) {
      continue;
    }

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
      const embeddings = await embedTexts(texts);

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
 * Background property re-embed after Salesforce migrate (legacy source path).
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
  DEFAULT_BATCH_SIZE,
  ALLOWED_COLLECTIONS,
  FORBIDDEN_COLLECTIONS,
  SOURCE_CONFIG,
  EmbeddingServiceError,
  getOpenAIClient,
  buildSearchableText,
  hashSearchableText,
  needsEmbeddingUpdate,
  generateEmbedding,
  embedTexts,
  generateEmbeddings,
  upsertKnowledgeEmbedding,
  syncKnowledgeEmbeddings,
  // Legacy source-document path (unchanged callers)
  syncDocumentEmbedding,
  scheduleDocumentEmbedding,
  syncSourceEmbeddings,
  schedulePropertyEmbeddingsAfterMigrate,
  extractBlogContentText,
};
