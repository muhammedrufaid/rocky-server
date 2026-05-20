const mongoose = require('mongoose');

const careerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
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
    cvFileName: {
      type: String,
      required: [true, 'CV file name is required'],
      trim: true,
    },
    cvType: {
      type: String,
      required: [true, 'CV file type is required'],
      trim: true,
    },
    cvSize: {
      type: Number,
      required: [true, 'CV file size is required'],
      min: [0, 'CV file size must be a positive number'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Career', careerSchema);
