const mongoose = require('mongoose');

const relocationGuideSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    location: {
      type: String,
      required: true,
      trim: true,
    },
    cv: {
      key: {
        type: String,
        required: true,
        trim: true,
      },
      fileName: {
        type: String,
        required: true,
        trim: true,
      },
    },
    cvFileName: {
      type: String,
      required: true,
      trim: true,
    },
    cvType: {
      type: String,
      required: true,
      trim: true,
    },
    cvSize: {
      type: Number,
      required: true,
      min: [0, 'CV file size must be a positive number'],
    },
    teamtailorStatus: {
      type: String,
      enum: ['pending', 'skipped', 'synced', 'failed'],
      default: 'pending',
      index: true,
    },
    teamtailorRecordId: {
      type: String,
      trim: true,
    },
    teamtailorError: {
      type: String,
    },
    emailStatus: {
      type: String,
      enum: ['pending', 'accepted', 'failed'],
      default: 'pending',
      index: true,
    },
    resendEmailId: {
      type: String,
      trim: true,
    },
    emailError: {
      type: String,
    },
    processingStartedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

relocationGuideSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('RelocationGuide', relocationGuideSchema);
