const mongoose = require('mongoose');

const careerSchema = new mongoose.Schema(
  {
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
    position: {
      type: String,
      required: [true, 'Position is required'],
      trim: true,
      index: true,
    },
    cvUrl: {
      type: String,
      required: [true, 'CV URL is required'],
      trim: true,
    },
    cvPublicId: {
      type: String,
      trim: true,
    },
    cvOriginalFileName: {
      type: String,
      trim: true,
    },
    cvUpdatedFileName: {
      type: String,
      trim: true,
    },
    cvFileName: {
      type: String,
      trim: true,
    },
    cvType: {
      type: String,
      trim: true,
    },
    cvSize: {
      type: Number,
      min: [0, 'CV file size must be a positive number'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Career', careerSchema);
