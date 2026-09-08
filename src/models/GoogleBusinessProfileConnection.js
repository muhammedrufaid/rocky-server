const mongoose = require('mongoose');

/**
 * Singleton company connection for Google Business Profile APIs.
 * This is NOT a website user login record.
 *
 * accessToken / refreshToken are stored encrypted and excluded from
 * default queries and JSON serialization.
 */
const googleBusinessProfileConnectionSchema = new mongoose.Schema(
  {
    connectionKey: {
      type: String,
      required: true,
      unique: true,
      default: 'company',
      trim: true,
    },
    accessToken: {
      type: String,
      select: false,
    },
    refreshToken: {
      type: String,
      required: true,
      select: false,
    },
    tokenExpiry: {
      type: Date,
    },
    scope: {
      type: String,
      trim: true,
    },
    googleAccountId: {
      type: String,
      trim: true,
    },
    googleAccountEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    googleAccountName: {
      type: String,
      trim: true,
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

googleBusinessProfileConnectionSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.accessToken;
    delete ret.refreshToken;
    return ret;
  },
});

module.exports =
  mongoose.models.GoogleBusinessProfileConnection ||
  mongoose.model('GoogleBusinessProfileConnection', googleBusinessProfileConnectionSchema);
