const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const chatSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: [true, 'Session id is required'],
      trim: true,
      unique: true,
      index: true,
    },
    messages: {
      type: [chatMessageSchema],
      default: [],
    },
    qualification: {
      purpose: { type: String, trim: true },
      location: { type: String, trim: true },
      propertyType: { type: String, trim: true },
      budget: { type: String, trim: true },
      bedrooms: { type: String, trim: true },
      furnishing: { type: String, trim: true },
      timeline: { type: String, trim: true },
    },
    contact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },
    viewingInterest: {
      selectedPropertyRefNo: { type: String, trim: true },
      selectedPropertyTitle: { type: String, trim: true },
      selectedLocation: { type: String, trim: true },
    },
    // Set when no listing fit the budget and the lowest real price was offered; cleared on the next reply.
    budgetFallback: {
      pending: { type: Boolean, default: false },
      originalMaxPrice: { type: Number },
      suggestedMinPrice: { type: Number },
    },
    // Close location match waiting for the user's "yes" ("Did you mean Jebel Ali?"); cleared on the next reply.
    locationSuggestion: { type: String, trim: true, default: '' },
    leadOfferShown: {
      type: Boolean,
      default: false,
    },
    leadOfferDeclined: {
      type: Boolean,
      default: false,
    },
    leadSaved: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatSession', chatSessionSchema);
