const mongoose = require('mongoose');

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
      required: [true, 'Message is required'],
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LandingPageLead', landingPageLeadSchema);
