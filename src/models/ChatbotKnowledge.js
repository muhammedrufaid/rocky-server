const mongoose = require('mongoose');

/**
 * Single embedding store for CMS content used by the chatbot:
 * blogs, area guides, FAQs, services, and company_info (sourceType).
 * Collection: chatbot_knowledge (like property_embeddings for listings).
 */
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
  { timestamps: true, versionKey: false, collection: 'chatbot_knowledge' }
);

chatbotKnowledgeSchema.index({ sourceType: 1, sourceId: 1, embeddingHash: 1 }, { unique: true });

module.exports =
  mongoose.models.ChatbotKnowledge || mongoose.model('ChatbotKnowledge', chatbotKnowledgeSchema);
