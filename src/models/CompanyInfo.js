const mongoose = require('mongoose');

/**
 * Flexible company / personal Q&A for the chatbot.
 * Add new entries without schema changes — topic + question + answer is enough.
 */
const companyInfoSchema = new mongoose.Schema(
  {
    topic: {
      type: String,
      required: [true, 'Topic is required'],
      trim: true,
      index: true,
    },
    question: {
      type: String,
      required: [true, 'Question is required'],
      trim: true,
    },
    answer: {
      type: String,
      required: [true, 'Answer is required'],
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: 'general',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

companyInfoSchema.index({ topic: 1, category: 1, isActive: 1 });
companyInfoSchema.index({ category: 1, isActive: 1, updatedAt: -1 });

module.exports =
  mongoose.models.CompanyInfo || mongoose.model('CompanyInfo', companyInfoSchema);
