const mongoose = require('mongoose');

/**
 * Dedicated collection for public knowledge chunk embeddings
 * (Area Guides, FAQs — Phase 4). Separate from blog_embeddings.
 *
 * Atlas Vector Search index: knowledge_vector_index
 * (path: embedding, 1536, cosine; filter: sourceType).
 */
const knowledgeEmbeddingSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      required: [true, 'sourceType is required'],
      enum: ['area_guide', 'faq'],
      index: true,
    },
    sourceId: {
      type: String,
      required: [true, 'sourceId is required'],
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
    },
    title: {
      type: String,
      trim: true,
      default: undefined,
    },
    category: {
      type: String,
      trim: true,
      index: true,
      default: undefined,
    },
    question: {
      type: String,
      trim: true,
      default: undefined,
    },
    path: {
      type: String,
      trim: true,
      default: undefined,
    },
    mapQuery: {
      type: String,
      trim: true,
      default: undefined,
    },
    order: {
      type: Number,
      default: undefined,
    },
    chunkIndex: {
      type: Number,
      required: [true, 'chunkIndex is required'],
      min: 0,
    },
    content: {
      type: String,
      required: [true, 'content is required'],
      trim: true,
    },
    contentHash: {
      type: String,
      required: [true, 'contentHash is required'],
      trim: true,
    },
    embedding: {
      type: [Number],
      required: [true, 'embedding is required'],
    },
    embeddingModel: {
      type: String,
      required: [true, 'embeddingModel is required'],
      trim: true,
      index: true,
    },
    embeddingDimension: {
      type: Number,
      required: [true, 'embeddingDimension is required'],
      min: 1,
    },
  },
  { timestamps: true }
);

// Idempotent identity for a chunk under a given embedding model
knowledgeEmbeddingSchema.index(
  { sourceType: 1, sourceId: 1, chunkIndex: 1, embeddingModel: 1 },
  { unique: true }
);

knowledgeEmbeddingSchema.index({ sourceType: 1, slug: 1 });

module.exports = mongoose.model(
  'KnowledgeEmbedding',
  knowledgeEmbeddingSchema,
  'knowledge_embeddings'
);
