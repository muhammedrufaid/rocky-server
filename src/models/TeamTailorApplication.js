const mongoose = require('mongoose');

const teamTailorApplicationSchema = new mongoose.Schema(
  {
    teamtailorJobId: {
      type: String,
      required: true,
      trim: true,
    },
    teamtailorCandidateId: {
      type: String,
      trim: true,
    },
    teamtailorApplicationId: {
      type: String,
      trim: true,
    },
    teamtailorUploadId: {
      type: String,
      trim: true,
    },
    jobTitle: {
      type: String,
      trim: true,
    },
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
    resumeStorageKey: {
      type: String,
      required: true,
      trim: true,
    },
    resumeOriginalName: {
      type: String,
      required: true,
      trim: true,
    },
    resumeMimeType: {
      type: String,
      required: true,
      trim: true,
    },
    source: {
      type: String,
      default: 'Rocky Website',
      trim: true,
    },
    syncStatus: {
      type: String,
      enum: ['pending', 'processing', 'synced', 'failed'],
      default: 'pending',
      index: true,
    },
    syncError: {
      type: String,
    },
    processingStartedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

teamTailorApplicationSchema.index({ email: 1, teamtailorJobId: 1 }, { unique: true });

module.exports = mongoose.model('TeamTailorApplication', teamTailorApplicationSchema);
