const mongoose = require('mongoose');

const CATEGORIES = ['Residential', 'Commercial'];

const propertyTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    categories: {
      type: [
        {
          type: String,
          enum: {
            values: CATEGORIES,
            message: 'Category must be Residential or Commercial',
          },
        },
      ],
      required: [true, 'Categories are required'],
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'At least one category is required',
      },
    },
  },
  { timestamps: true }
);

propertyTypeSchema.index({ name: 1 }, { unique: true });
propertyTypeSchema.index({ categories: 1, name: 1 });

module.exports = mongoose.model('PropertyType', propertyTypeSchema, 'propertytypes');
module.exports.CATEGORIES = CATEGORIES;
