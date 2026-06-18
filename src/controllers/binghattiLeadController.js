const mongoose = require('mongoose');
const BinghattiLead = require('../models/BinghattiLead');
const { sendBinghattiLeadToGoogleSheet } = require('../services/googleSheetsService');

// 1. Create Binghatti lead - POST /api/binghatti-lead
const createBinghattiLead = async (req, res) => {
  try {
    const { fullName, email, phone, message } = req.body;

    if (!fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone and message',
      });
    }

    const lead = await BinghattiLead.create({
      fullName,
      email,
      phone,
      message,
    });

    try {
      await sendBinghattiLeadToGoogleSheet({
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
      });
    } catch (sheetsError) {
      console.error('[Google Sheets] Unexpected error after Binghatti lead save:', sheetsError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Binghatti lead created successfully',
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all Binghatti leads - GET /api/binghatti-lead
const getAllBinghattiLeads = async (req, res) => {
  try {
    const leads = await BinghattiLead.find().sort({ createdAt: -1 });

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

// 3. Get Binghatti lead by id - GET /api/binghatti-lead/:id
const getBinghattiLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Binghatti lead id',
      });
    }

    const lead = await BinghattiLead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Binghatti lead not found',
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

// 4. Update Binghatti lead - PUT /api/binghatti-lead/:id
const updateBinghattiLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Binghatti lead id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await BinghattiLead.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Binghatti lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Binghatti lead updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete Binghatti lead - DELETE /api/binghatti-lead/:id
const deleteBinghattiLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Binghatti lead id',
      });
    }

    const deleted = await BinghattiLead.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Binghatti lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Binghatti lead deleted successfully',
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
  createBinghattiLead,
  getAllBinghattiLeads,
  getBinghattiLeadById,
  updateBinghattiLead,
  deleteBinghattiLead,
};
