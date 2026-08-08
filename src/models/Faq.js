const mongoose = require('mongoose');

const FAQ_PAGES = {
  HOME: 'home',
  OFF_PLAN: 'off-plan',
  SELL_PROPERTY: 'sell-your-property',
  CONTACT: 'contact',
  SERVICE: 'service',
  AREA_GUIDE: 'area-guide',
  COMMUNITY: 'community',
  DEVELOPER: 'developer',
  BUYING_GUIDE: 'buying-guide',
  RENTAL_GUIDE: 'rental-guide',
  MORTGAGE: 'mortgage',
  BLOG: 'blog',
  CAREERS: 'careers',
  OTHER: 'other',
};

const FAQ_PAGE_VALUES = Object.values(FAQ_PAGES);

const faqSchema = new mongoose.Schema(
  {
    page: {
      type: String,
      required: [true, 'Page is required'],
      enum: {
        values: FAQ_PAGE_VALUES,
        message: 'Invalid page value',
      },
      trim: true,
      index: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
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
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

// Static pages: find by page + isActive, sorted by order
faqSchema.index({ page: 1, isActive: 1, order: 1 });

// Dynamic pages: find by page + slug + isActive, sorted by order
faqSchema.index({ page: 1, slug: 1, isActive: 1, order: 1 });

module.exports = mongoose.model('Faq', faqSchema);
module.exports.FAQ_PAGES = FAQ_PAGES;
