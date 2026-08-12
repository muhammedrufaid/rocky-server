const mongoose = require('mongoose');

/**
 * Flexible content block schema.
 * `type` is required; additional fields (text, items, src, alt, caption, etc.)
 * are preserved via strict: false so future block types can be added without
 * schema migrations.
 */
const contentBlockSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'Content block type is required'],
      trim: true,
    },
  },
  { _id: false, strict: false }
);

const blogSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
    },
    image: {
      type: String,
      trim: true,
    },
    path: {
      type: String,
      trim: true,
    },
    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
    content: {
      type: [contentBlockSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    // AI embedding — excluded from normal API responses (select: false)
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

blogSchema.index({ isActive: 1, createdAt: -1 });

const stripEmbeddingFields = (_doc, ret) => {
  delete ret.embedding;
  delete ret.embeddingHash;
  return ret;
};

blogSchema.set('toJSON', { transform: stripEmbeddingFields });
blogSchema.set('toObject', { transform: stripEmbeddingFields });

module.exports = mongoose.model('Blog', blogSchema, 'blogs');
