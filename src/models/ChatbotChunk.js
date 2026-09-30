const mongoose = require('mongoose');

const CHUNK_SOURCES = ['faq', 'knowledge', 'area', 'service', 'blog', 'team'];

const chatbotChunkSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: [true, 'Source is required'],
      enum: { values: CHUNK_SOURCES, message: 'Invalid source value' },
      index: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    title: {
      type: String,
      trim: true,
      default: '',
    },
    text: {
      type: String,
      required: [true, 'Text is required'],
    },
    embedding: {
      type: [Number],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatbotChunk', chatbotChunkSchema);
module.exports.CHUNK_SOURCES = CHUNK_SOURCES;
