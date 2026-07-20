const mongoose = require('mongoose');
const PropertyManagementLead = require('../models/PropertyManagementLead');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create property management lead - POST /api/property-management-lead
const createPropertyManagementLead = async (req, res) => {
  try {
    const { fullName, email, phone, message } = req.body;

    if (!fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone and message',
      });
    }

    const lead = await PropertyManagementLead.create({
      fullName,
      email,
      phone,
      message,
    });

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendToZapier({
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
        source: ZAPIER_SOURCES.PROPERTY_MANAGEMENT_LEAD,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after property management lead save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Property management lead created successfully',
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all property management leads - GET /api/property-management-lead
const getAllPropertyManagementLeads = async (req, res) => {
  try {
    const leads = await PropertyManagementLead.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: leads.length,
      data: leads,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get property management lead by id - GET /api/property-management-lead/:id
const getPropertyManagementLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property management lead id',
      });
    }

    const lead = await PropertyManagementLead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Property management lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update property management lead - PUT /api/property-management-lead/:id
const updatePropertyManagementLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property management lead id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await PropertyManagementLead.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Property management lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Property management lead updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete property management lead - DELETE /api/property-management-lead/:id
const deletePropertyManagementLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property management lead id',
      });
    }

    const deleted = await PropertyManagementLead.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Property management lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Property management lead deleted successfully',
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
  createPropertyManagementLead,
  getAllPropertyManagementLeads,
  getPropertyManagementLeadById,
  updatePropertyManagementLead,
  deletePropertyManagementLead,
};
