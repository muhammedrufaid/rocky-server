const mongoose = require('mongoose');

/**
 * Dedicated collection for public blog chunk embeddings.
 * Does NOT modify the blogs collection.
 * Atlas Vector Search index: blog_vector_index (path: embedding, 1536, cosine).
 */
const blogEmbeddingSchema = new mongoose.Schema(
  {
    blogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Blog',
      required: [true, 'blogId is required'],
      index: true,
    },
    slug: {
      type: String,
      required: [true, 'slug is required'],
      trim: true,
      lowercase: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'title is required'],
      trim: true,
    },
    category: {
      type: String,
      required: [true, 'category is required'],
      trim: true,
      index: true,
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
    headingContext: {
      type: String,
      default: null,
      trim: true,
    },
    sourceBlockStart: {
      type: Number,
      required: [true, 'sourceBlockStart is required'],
    },
    sourceBlockEnd: {
      type: Number,
      required: [true, 'sourceBlockEnd is required'],
    },
    charCount: {
      type: Number,
      required: [true, 'charCount is required'],
      min: 0,
    },
    wordCount: {
      type: Number,
      required: [true, 'wordCount is required'],
      min: 0,
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
blogEmbeddingSchema.index(
  { blogId: 1, chunkIndex: 1, embeddingModel: 1 },
  { unique: true }
);

module.exports = mongoose.model('BlogEmbedding', blogEmbeddingSchema, 'blog_embeddings');
