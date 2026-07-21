const mongoose = require('mongoose');

const CONTACT_SUB_SOURCE = 'Contact Us';

const contactSchema = new mongoose.Schema(
  {
    subSource: {
      type: String,
      required: [true, 'Sub source is required'],
      trim: true,
      default: CONTACT_SUB_SOURCE,
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
    inquiryType: {
      type: String,
      required: [true, 'Inquiry Type is required'],
      trim: true,
      index: true,
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Contact', contactSchema);
module.exports.CONTACT_SUB_SOURCE = CONTACT_SUB_SOURCE;

