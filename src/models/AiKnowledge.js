const mongoose = require('mongoose');

const SOURCE_TYPES = Object.freeze([
  'blog',
  'areaGuide',
  'faq',
  'service',
  'property',
]);

/**
 * Unified AI/search representation for public knowledge sources.
 * Source collections remain the source of truth.
 * Atlas Vector Search index is configured separately (not here).
 */
const aiKnowledgeSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      required: [true, 'sourceType is required'],
      enum: {
        values: SOURCE_TYPES,
        message: 'Invalid sourceType value',
      },
      trim: true,
    },
    sourceId: {
      type: String,
      required: [true, 'sourceId is required'],
      trim: true,
    },
    title: {
      type: String,
      trim: true,
      default: undefined,
    },
    content: {
      type: String,
      required: [true, 'content is required'],
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    // Excluded from normal queries / API responses
    embedding: {
      type: [Number],
      select: false,
    },
    embeddingHash: {
      type: String,
      select: false,
    },
  },
  { timestamps: true }
);

// Logical identity: one knowledge document per source document
aiKnowledgeSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });

const stripEmbeddingFields = (_doc, ret) => {
  delete ret.embedding;
  delete ret.embeddingHash;
  return ret;
};

aiKnowledgeSchema.set('toJSON', { transform: stripEmbeddingFields });
aiKnowledgeSchema.set('toObject', { transform: stripEmbeddingFields });

module.exports = mongoose.model('AiKnowledge', aiKnowledgeSchema, 'ai_knowledge');
module.exports.SOURCE_TYPES = SOURCE_TYPES;
