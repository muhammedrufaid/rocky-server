const mongoose = require('mongoose');
const DubaiSouthLead = require('../models/DubaiSouthLead');

// 1. Create Dubai South lead - POST /api/dubai-south-lead
const createDubaiSouthLead = async (req, res) => {
  try {
    const { fullName, email, phone, message } = req.body;

    if (!fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone and message',
      });
    }

    const lead = await DubaiSouthLead.create({
      fullName,
      email,
      phone,
      message,
    });

    return res.status(201).json({
      success: true,
      message: 'Dubai South lead created successfully',
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all Dubai South leads - GET /api/dubai-south-lead
const getAllDubaiSouthLeads = async (req, res) => {
  try {
    const leads = await DubaiSouthLead.find().sort({ createdAt: -1 });

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

// 3. Get Dubai South lead by id - GET /api/dubai-south-lead/:id
const getDubaiSouthLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Dubai South lead id',
      });
    }

    const lead = await DubaiSouthLead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Dubai South lead not found',
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

// 4. Update Dubai South lead - PUT /api/dubai-south-lead/:id
const updateDubaiSouthLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Dubai South lead id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await DubaiSouthLead.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Dubai South lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Dubai South lead updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete Dubai South lead - DELETE /api/dubai-south-lead/:id
const deleteDubaiSouthLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Dubai South lead id',
      });
    }

    const deleted = await DubaiSouthLead.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Dubai South lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Dubai South lead deleted successfully',
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
  createDubaiSouthLead,
  getAllDubaiSouthLeads,
  getDubaiSouthLeadById,
  updateDubaiSouthLead,
  deleteDubaiSouthLead,
};
