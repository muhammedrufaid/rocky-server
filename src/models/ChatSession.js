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
      locationFlexible: { type: Boolean },
      propertyType: { type: String, trim: true },
      budget: { type: String, trim: true },
      // Lower end of a budget range ("1M to 2M"); `budget` is the upper end.
      budgetMin: { type: String, trim: true },
      budgetFlexible: { type: Boolean },
      // One count ("2") or a set ("1,2,3"); '0' is a studio.
      bedrooms: { type: String, trim: true },
      bedroomsFlexible: { type: Boolean },
      furnishing: { type: String, trim: true },
      // Amenity words from the listings' feature names ("pool", "balcony"); a listing must list every one to match.
      amenities: { type: [String], default: undefined },
      // "near a metro station": a listing must name a nearby metro station in its own title or description to match.
      nearMetro: { type: Boolean },
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
    // Question the assistant just asked (a CHOICE_QUESTIONS key in lib/chatbot.js, or KNOWLEDGE_FOLLOW_UP for the offer
    // that ends a knowledge answer); cleared on the next reply.
    pendingQuestion: { type: String, trim: true, default: '' },
    // With pendingQuestion KNOWLEDGE_FOLLOW_UP: the offer itself and the user question it followed ("What is RERA?").
    // Cleared on the next reply.
    pendingFollowUp: {
      offer: { type: String, trim: true },
      question: { type: String, trim: true },
    },
    // Knowledge offers already explained or declined in this chat; never offered again in any wording (see followUpKey
    // in lib/chatbot.js).
    closedFollowUps: { type: [String], default: [] },
    // Reference numbers of the property cards last shown, in card order, so "the second one" can be resolved.
    shownPropertyRefs: { type: [String], default: [] },
    // Non-property topic the conversation is on (e.g. 'leadership'); cleared when the user returns to a property search.
    currentTopic: { type: String, trim: true, default: '' },
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
