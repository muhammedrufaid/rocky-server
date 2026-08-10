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
    id: {
      type: Number,
      required: [true, 'Blog id is required'],
      unique: true,
      index: true,
    },
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
  },
  { timestamps: true }
);

blogSchema.index({ isActive: 1, id: -1 });
blogSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model('Blog', blogSchema, 'blogs');
