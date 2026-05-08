const mongoose = require('mongoose');

const SELL_PROPERTY_TYPES = [
  'Apartment',
  'Villa',
  'Townhouse',
  'Penthouse',
  'Office',
  'Shop',
  'Warehouse',
  'Land',
  'Other',
];

const sellSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full Name is required'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone Number is required'],
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: [true, 'Email Address is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
      index: true,
    },
    propertyType: {
      type: String,
      required: [true, 'Property Type is required'],
      trim: true,
      enum: SELL_PROPERTY_TYPES,
    },
    locationArea: {
      type: String,
      required: [true, 'Location / Area is required'],
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

module.exports = mongoose.model('Sell', sellSchema);

