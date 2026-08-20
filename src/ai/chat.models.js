const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    messages: {
      type: [
        {
          role: { type: String, enum: ['user', 'assistant'], required: true },
          content: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    userProfile: {
      preferredAreas: { type: [String], default: [] },
      budget: {
        min: { type: Number, default: null },
        max: { type: Number, default: null },
      },
      bedrooms: { type: Number, default: null },
      purpose: { type: String, default: null, trim: true },
      lastPropertyCards: {
        type: [
          {
            id: { type: String, default: '' },
            title: { type: String, default: '' },
            price: { type: mongoose.Schema.Types.Mixed, default: '' },
            beds: { type: mongoose.Schema.Types.Mixed, default: '' },
            baths: { type: mongoose.Schema.Types.Mixed, default: '' },
            area: { type: String, default: '' },
            imageUrl: { type: String, default: '' },
            listingUrl: { type: String, default: '' },
          },
        ],
        default: [],
      },
      lastSearchFilters: {
        location: { type: String, default: null, trim: true },
        bedrooms: { type: Number, default: null },
        bedroomsMin: { type: Number, default: null },
        bedroomsAny: { type: Boolean, default: false },
        bedroomsResolved: { type: Boolean, default: false },
        budgetMin: { type: Number, default: null },
        budgetMax: { type: Number, default: null },
        type: { type: String, default: null, trim: true },
        purpose: { type: String, default: null, trim: true },
      },
      slotFlow: {
        awaiting: { type: String, default: null, trim: true },
        alternatives: { type: String, default: null },
      },
      sellListing: {
        intent: { type: String, default: null, trim: true },
        type: { type: String, default: null, trim: true },
        location: { type: String, default: null, trim: true },
        bedrooms: { type: Number, default: null },
        priceNote: { type: String, default: null, trim: true },
        name: { type: String, default: null, trim: true },
        phone: { type: String, default: null, trim: true },
        email: { type: String, default: null, trim: true },
      },
      leadCaptured: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
      index: true,
    },
    intent: { type: String, required: true, trim: true },
    sessionId: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

const chatbotKnowledgeSchema = new mongoose.Schema(
  {
    sourceType: { type: String, required: true, trim: true, index: true },
    sourceId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, default: '', trim: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    embeddingHash: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

chatbotKnowledgeSchema.index({ sourceType: 1, sourceId: 1, embeddingHash: 1 }, { unique: true });

const Conversation =
  mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema, 'conversations');
const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema, 'leads');
const ChatbotKnowledge =
  mongoose.models.ChatbotKnowledge ||
  mongoose.model('ChatbotKnowledge', chatbotKnowledgeSchema, 'chatbot_knowledge');

module.exports = {
  Conversation,
  Lead,
  ChatbotKnowledge,
};
