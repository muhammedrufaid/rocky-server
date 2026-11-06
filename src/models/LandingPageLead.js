const mongoose = require('mongoose');

const landingPageLeadQuizSchema = new mongoose.Schema(
  {
    goal: { type: String, trim: true },
    propertyType: { type: String, trim: true },
    bedrooms: { type: String, trim: true },
    budget: { type: String, trim: true },
    timeline: { type: String, trim: true },
    purchasedBefore: { type: String, trim: true },
    contactMethod: { type: String, trim: true },
    contactTime: { type: String, trim: true },
  },
  { _id: false }
);

const landingPageLeadSchema = new mongoose.Schema(
  {
    landingPage: {
      type: String,
      required: [true, 'Landing page is required'],
      trim: true,
      lowercase: true,
      index: true,
    },
    subSource: {
      type: String,
      required: [true, 'Sub source is required'],
      trim: true,
    },
    fullName: {
      type: String,
      required: [true, 'Full Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
      index: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
    },
    message: {
      type: String,
      required: [false, 'Message is required'],
      trim: true,
    },
    language: {
      type: String,
      required: false,
      trim: true,
    },
    quiz: {
      type: landingPageLeadQuizSchema,
      required: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LandingPageLead', landingPageLeadSchema);
