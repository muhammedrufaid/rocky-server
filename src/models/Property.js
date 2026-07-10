const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema(
  {
    propertyRefNo: { type: String, required: true, index: true },

    // Common fields we use in the app (keeps queries fast/typed)
    permitNumber: String,
    trakheesiPermitUrl: String,
    propertyStatus: String,
    propertyPurpose: String,
    propertyType: { type: String, index: true },
    propertySize: String,
    propertySizeUnit: String,
    bedrooms: String,
    bathrooms: String,
    offPlan: { type: String, index: true },
    lastUpdated: String,
    city: { type: String, index: true },
    locality: { type: String, index: true },
    subLocality: { type: String, index: true },
    towerName: { type: String, index: true },
    propertyTitle: String,
    propertyDescription: String,
    price: { type: String, index: true },
    furnished: String,
    rentFrequency: String,
    listingAgentEmail: String,
    listingAgent: String,
    listingAgentPhone: String,

    features: [String],
    portals: [String],
    images: [String],
  },
  { timestamps: false, versionKey: false }
);

propertySchema.index({ propertyRefNo: 1 }, { unique: true });

module.exports = mongoose.model('Property', propertySchema);

