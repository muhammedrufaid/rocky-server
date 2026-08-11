const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema(
  {
    order: {
      type: Number,
      required: [true, 'Team member order is required'],
      unique: true,
      index: true,
    },
    isAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },
    isAgent: {
      type: Boolean,
      default: false,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    department: {
      type: String,
      required: [true, 'Department is required'],
      trim: true,
      index: true,
    },
    designation: {
      type: String,
      required: [true, 'Designation is required'],
      trim: true,
    },
    image: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
    },
    whatsapp: {
      type: String,
      trim: true,
    },
    languages: {
      type: [String],
      default: undefined,
    },
    experience: {
      type: [String],
      default: undefined,
    },
    businessCardPdf: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

teamMemberSchema.index({ isActive: 1, order: 1 });
teamMemberSchema.index({ isActive: 1, isAgent: 1 });
teamMemberSchema.index({ isActive: 1, isAdmin: 1 });
teamMemberSchema.index({ isActive: 1, department: 1 });

module.exports = mongoose.model('TeamMember', teamMemberSchema, 'teammembers');
