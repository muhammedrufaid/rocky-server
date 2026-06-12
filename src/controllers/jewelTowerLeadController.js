const mongoose = require('mongoose');
const JewelTowerLead = require('../models/JewelTowerLead');
const { sendJewelTowerLeadToGoogleSheet } = require('../services/googleSheetsService');

// 1. Create Jewel Tower lead - POST /api/jewel-tower-lead
const createJewelTowerLead = async (req, res) => {
  try {
    const { fullName, email, phone, message } = req.body;

    if (!fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone and message',
      });
    }

    const lead = await JewelTowerLead.create({
      fullName,
      email,
      phone,
      message,
    });

    try {
      await sendJewelTowerLeadToGoogleSheet({
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
      });
    } catch (sheetsError) {
      console.error('[Google Sheets] Unexpected error after Jewel Tower lead save:', sheetsError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Jewel Tower lead created successfully',
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all Jewel Tower leads - GET /api/jewel-tower-lead
const getAllJewelTowerLeads = async (req, res) => {
  try {
    const leads = await JewelTowerLead.find().sort({ createdAt: -1 });

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

// 3. Get Jewel Tower lead by id - GET /api/jewel-tower-lead/:id
const getJewelTowerLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Jewel Tower lead id',
      });
    }

    const lead = await JewelTowerLead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Jewel Tower lead not found',
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

// 4. Update Jewel Tower lead - PUT /api/jewel-tower-lead/:id
const updateJewelTowerLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Jewel Tower lead id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await JewelTowerLead.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Jewel Tower lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Jewel Tower lead updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete Jewel Tower lead - DELETE /api/jewel-tower-lead/:id
const deleteJewelTowerLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Jewel Tower lead id',
      });
    }

    const deleted = await JewelTowerLead.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Jewel Tower lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Jewel Tower lead deleted successfully',
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
  createJewelTowerLead,
  getAllJewelTowerLeads,
  getJewelTowerLeadById,
  updateJewelTowerLead,
  deleteJewelTowerLead,
};
