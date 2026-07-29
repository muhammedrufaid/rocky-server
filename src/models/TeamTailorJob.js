const mongoose = require('mongoose');

const pictureSchema = new mongoose.Schema(
  {
    original: { type: String, trim: true },
    standard: { type: String, trim: true },
    thumb: { type: String, trim: true },
  },
  { _id: false }
);

const teamTailorJobSchema = new mongoose.Schema(
  {
    teamtailorId: {
      type: String,
      required: [true, 'TeamTailor job id is required'],
      trim: true,
    },
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
      index: true,
    },
    internalName: {
      type: String,
      trim: true,
    },
    body: {
      type: String,
    },
    pitch: {
      type: String,
    },
    status: {
      type: String,
      trim: true,
      index: true,
    },
    humanStatus: {
      type: String,
      trim: true,
      index: true,
    },
    internal: {
      type: Boolean,
      default: false,
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    picture: pictureSchema,
    tags: {
      type: [String],
      default: [],
    },
    remoteStatus: {
      type: String,
      trim: true,
    },
    languageCode: {
      type: String,
      trim: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    applyButtonText: {
      type: String,
      trim: true,
    },
    externalApplicationUrl: {
      type: String,
      trim: true,
    },
    careersiteJobUrl: {
      type: String,
      trim: true,
    },
    careersiteJobApplyUrl: {
      type: String,
      trim: true,
    },
    careersiteJobApplyIframeUrl: {
      type: String,
      trim: true,
    },
    nameRequirement: {
      type: String,
      trim: true,
    },
    resumeRequirement: {
      type: String,
      trim: true,
    },
    additionalFilesRequirement: {
      type: String,
      trim: true,
    },
    coverLetterRequirement: {
      type: String,
      trim: true,
    },
    phoneRequirement: {
      type: String,
      trim: true,
    },
    candidateLocationRequirement: {
      type: String,
      trim: true,
    },
    recruiterEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    mailbox: {
      type: String,
      trim: true,
    },
    currency: {
      type: String,
      trim: true,
    },
    templateName: {
      type: String,
      trim: true,
    },
    sharingImageLayout: {
      type: String,
      trim: true,
    },
    teamtailorCreatedAt: {
      type: Date,
    },
    teamtailorUpdatedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

teamTailorJobSchema.index({ teamtailorId: 1 }, { unique: true });

module.exports = mongoose.model('TeamTailorJob', teamTailorJobSchema);
