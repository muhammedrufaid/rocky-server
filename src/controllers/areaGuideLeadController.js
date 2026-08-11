const mongoose = require('mongoose');
const AreaGuideLead = require('../models/AreaGuideLead');
const { AREA_GUIDE_SUB_SOURCE } = AreaGuideLead;
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create area guide inquiry - POST /api/area-guide-leads
const createAreaGuideLead = async (req, res) => {
  try {
    const { subSource, fullName, email, phone, inquiryType, propertyType, message } = req.body;

    if (!fullName || !email || !phone || !inquiryType || !propertyType || !message) {
      return res.status(400).json({
        success: false,
        message:
          'Please provide fullName, email, phone, inquiryType, propertyType and message',
      });
    }

    const areaGuideLead = await AreaGuideLead.create({
      subSource: subSource || AREA_GUIDE_SUB_SOURCE,
      fullName,
      email,
      phone,
      inquiryType,
      propertyType,
      message,
    });

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendToZapier({
        subSource: areaGuideLead.subSource,
        fullName: areaGuideLead.fullName,
        email: areaGuideLead.email,
        phone: areaGuideLead.phone,
        inquiryType: areaGuideLead.inquiryType,
        propertyType: areaGuideLead.propertyType,
        message: areaGuideLead.message,
        source: ZAPIER_SOURCES.AREA_GUIDES,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after area guide lead save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Area guide inquiry created successfully',
      data: {
        ...areaGuideLead.toObject(),
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

// 2. Get all area guide inquiries - GET /api/area-guide-leads
const getAllAreaGuideLeads = async (req, res) => {
  try {
    const areaGuideLeads = await AreaGuideLead.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: areaGuideLeads.length,
      data: areaGuideLeads,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get area guide inquiry by id - GET /api/area-guide-leads/:id
const getAreaGuideLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide lead id',
      });
    }

    const areaGuideLead = await AreaGuideLead.findById(id);
    if (!areaGuideLead) {
      return res.status(404).json({
        success: false,
        message: 'Area guide inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: areaGuideLead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update area guide inquiry - PUT /api/area-guide-leads/:id
const updateAreaGuideLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide lead id',
      });
    }

    const updates = {};
    const allowedFields = [
      'subSource',
      'fullName',
      'email',
      'phone',
      'inquiryType',
      'propertyType',
      'message',
    ];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await AreaGuideLead.findByIdAndUpdate(id, updates, {
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

// 5. Delete area guide inquiry - DELETE /api/area-guide-leads/:id
const deleteAreaGuideLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide lead id',
      });
    }

    const deleted = await AreaGuideLead.findByIdAndDelete(id);
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
  createAreaGuideLead,
  getAllAreaGuideLeads,
  getAreaGuideLeadById,
  updateAreaGuideLead,
  deleteAreaGuideLead,
};
