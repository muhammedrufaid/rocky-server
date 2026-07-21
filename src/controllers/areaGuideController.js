const mongoose = require('mongoose');
const AreaGuide = require('../models/AreaGuide');
const { AREA_GUIDE_SUB_SOURCE } = AreaGuide;
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create area guide inquiry - POST /api/area-guides
const createAreaGuide = async (req, res) => {
  try {
    const { subSource, fullName, email, phone, inquiryType, message } = req.body;

    if (!fullName || !email || !phone || !inquiryType || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone, inquiryType and message',
      });
    }

    const areaGuide = await AreaGuide.create({
      subSource: subSource || AREA_GUIDE_SUB_SOURCE,
      fullName,
      email,
      phone,
      inquiryType,
      message,
    });

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendToZapier({
        subSource: areaGuide.subSource,
        fullName: areaGuide.fullName,
        email: areaGuide.email,
        phone: areaGuide.phone,
        inquiryType: areaGuide.inquiryType,
        message: areaGuide.message,
        source: ZAPIER_SOURCES.AREA_GUIDES,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after area guide save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Area guide inquiry created successfully',
      data: {
        ...areaGuide.toObject(),
        source: ZAPIER_SOURCES.AREA_GUIDES,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all area guide inquiries - GET /api/area-guides
const getAllAreaGuides = async (req, res) => {
  try {
    const areaGuides = await AreaGuide.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: areaGuides.length,
      data: areaGuides,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get area guide inquiry by id - GET /api/area-guides/:id
const getAreaGuideById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const areaGuide = await AreaGuide.findById(id);
    if (!areaGuide) {
      return res.status(404).json({
        success: false,
        message: 'Area guide inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: areaGuide,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update area guide inquiry - PUT /api/area-guides/:id
const updateAreaGuide = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const updates = {};
    const allowedFields = ['subSource', 'fullName', 'email', 'phone', 'inquiryType', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await AreaGuide.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Area guide inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Area guide inquiry updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete area guide inquiry - DELETE /api/area-guides/:id
const deleteAreaGuide = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const deleted = await AreaGuide.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Area guide inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Area guide inquiry deleted successfully',
      data: deleted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  createAreaGuide,
  getAllAreaGuides,
  getAreaGuideById,
  updateAreaGuide,
  deleteAreaGuide,
};
