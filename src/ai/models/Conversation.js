/**
 * Conversation Model
 * Responsibility: Schema for AI Concierge conversation threads.
 */

const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  sessionId: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// One active conversation lookup per session
conversationSchema.index({ sessionId: 1, status: 1 });

module.exports = mongoose.model('AiConversation', conversationSchema);
