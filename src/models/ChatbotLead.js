const mongoose = require('mongoose');

const CHATBOT_SUB_SOURCE = 'Chatbot';

const chatbotLeadSchema = new mongoose.Schema(
  {
    subSource: {
      type: String,
      trim: true,
      default: CHATBOT_SUB_SOURCE,
    },
    fullName: {
      type: String,
      required: [true, 'Full Name is required'],
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: '',
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
    },
    inquiryType: {
      type: String,
      trim: true,
      default: 'General',
      index: true,
    },
    message: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatbotLead', chatbotLeadSchema, 'chatbotleads');
module.exports.CHATBOT_SUB_SOURCE = CHATBOT_SUB_SOURCE;
