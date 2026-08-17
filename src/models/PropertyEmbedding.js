const mongoose = require('mongoose');

const propertyEmbeddingSchema = new mongoose.Schema(
  {
    propertyRefNo: { type: String, required: true, index: true },
    embedding: { type: [Number], required: true },
    embeddingHash: { type: String, required: true, index: true },
  },
  { timestamps: true, versionKey: false, collection: 'property_embeddings' }
);

propertyEmbeddingSchema.index({ propertyRefNo: 1 }, { unique: true });

module.exports = mongoose.model('PropertyEmbedding', propertyEmbeddingSchema);
