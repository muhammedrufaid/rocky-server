const mongoose = require('mongoose');
const ChatbotKnowledge = require('../models/ChatbotKnowledge');

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
  },
  { timestamps: true }
);

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
      match: [/^$|^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
      index: true,
    },
    intent: { type: String, required: true, trim: true },
    sessionId: { type: String, required: true, trim: true, index: true },
  },
  { timestamps: true }
);

const Conversation =
  mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema, 'conversations');
const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema, 'leads');

module.exports = {
  Conversation,
  Lead,
  ChatbotKnowledge,
};
