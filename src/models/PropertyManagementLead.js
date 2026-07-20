const mongoose = require('mongoose');

const PROPERTY_MANAGEMENT_SUB_SOURCE = 'Property Management';

const propertyManagementLeadSchema = new mongoose.Schema(
  {
    subSource: {
      type: String,
      required: [true, 'Sub source is required'],
      trim: true,
      default: PROPERTY_MANAGEMENT_SUB_SOURCE,
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

module.exports = mongoose.model('PropertyManagementLead', propertyManagementLeadSchema);
module.exports.PROPERTY_MANAGEMENT_SUB_SOURCE = PROPERTY_MANAGEMENT_SUB_SOURCE;
