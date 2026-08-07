/**
 * Message Model
 * Responsibility: Schema for individual AI Concierge chat messages.
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    required: true,
    index: true,
  },
  role: {
    type: String,
    required: true,
    enum: ['user', 'assistant', 'system', 'tool'],
  },
  content: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Efficient chronological history loads per conversation
messageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('AiMessage', messageSchema);
