const mongoose = require('mongoose');

const subServiceSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: [true, 'Subservice id is required'],
    },
    title: {
      type: String,
      required: [true, 'Subservice title is required'],
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    points: {
      type: [String],
      default: undefined,
    },
  },
  { _id: false }
);

const serviceSchema = new mongoose.Schema(
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
    image: {
      type: String,
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
    },
    overviewHeading: {
      type: String,
      trim: true,
    },
    overview: {
      type: [String],
      default: undefined,
    },
    subservices: {
      type: [subServiceSchema],
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

serviceSchema.index({ isActive: 1, createdAt: 1 });

const stripEmbeddingFields = (_doc, ret) => {
  delete ret.embedding;
  delete ret.embeddingHash;
  return ret;
};

serviceSchema.set('toJSON', { transform: stripEmbeddingFields });
serviceSchema.set('toObject', { transform: stripEmbeddingFields });

module.exports = mongoose.model('Service', serviceSchema, 'services');
