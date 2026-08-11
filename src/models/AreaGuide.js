const mongoose = require('mongoose');

const keyHighlightSchema = new mongoose.Schema(
  {
    icon: {
      type: String,
      required: [true, 'Highlight icon is required'],
      trim: true,
    },
    title: {
      type: String,
      required: [true, 'Highlight title is required'],
      trim: true,
    },
  },
  { _id: false }
);

const areaGuideSchema = new mongoose.Schema(
  {
    order: {
      type: Number,
      required: [true, 'Order is required'],
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
    about: {
      type: String,
      required: [true, 'About is required'],
      trim: true,
    },
    keyHighlights: {
      type: [keyHighlightSchema],
      default: [],
    },
    /** TeamMember.order values for featured agents on this area guide */
    agentOrders: {
      type: [Number],
      default: [],
    },
    mapQuery: {
      type: String,
      required: [true, 'Map query is required'],
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
    /** Optional nearby listing search terms when the area has no dedicated inventory */
    listingsSearch: {
      type: [String],
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

areaGuideSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model('AreaGuide', areaGuideSchema, 'areaguides');
