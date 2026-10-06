const mongoose = require('mongoose');

const CATEGORIES = ['Residential', 'Commercial'];

const propertyTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: CATEGORIES,
        message: 'Category must be Residential or Commercial',
      },
      trim: true,
      index: true,
    },
  },
  { timestamps: true }
);

// Land, Floor and Building exist in both categories.
propertyTypeSchema.index({ name: 1, category: 1 }, { unique: true });
propertyTypeSchema.index({ category: 1, name: 1 });

module.exports = mongoose.model('PropertyType', propertyTypeSchema, 'propertytypes');
module.exports.CATEGORIES = CATEGORIES;
