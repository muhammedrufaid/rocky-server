const mongoose = require('mongoose');

const googleBusinessProfileReviewSchema = new mongoose.Schema(
  {
    googleReviewId: {
      type: String,
      required: true,
      trim: true,
    },
    reviewerName: {
      type: String,
      trim: true,
      default: null,
    },
    reviewerPhotoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    starRating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    comment: {
      type: String,
      default: null,
    },
    createTime: {
      type: Date,
      default: null,
    },
    updateTime: {
      type: Date,
      default: null,
      index: true,
    },
    reviewReply: {
      type: String,
      default: null,
    },
    reviewReplyUpdateTime: {
      type: Date,
      default: null,
    },
    locationName: {
      type: String,
      trim: true,
      default: null,
    },
    accountName: {
      type: String,
      trim: true,
      default: null,
    },
    fetchedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

googleBusinessProfileReviewSchema.index({ googleReviewId: 1 }, { unique: true });

module.exports =
  mongoose.models.GoogleBusinessProfileReview ||
  mongoose.model('GoogleBusinessProfileReview', googleBusinessProfileReviewSchema);
