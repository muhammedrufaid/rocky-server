const mongoose = require('mongoose');
const LandingPageLead = require('../models/LandingPageLead');
const { sendLandingPageLeadToGoogleSheet } = require('../services/googleSheetsService');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create landing page lead - POST /api/landing-page-lead
const createLandingPageLead = async (req, res) => {
  try {
    const { landingPage, subSource, fullName, email, phone, message } = req.body;

    if (!landingPage || !subSource || !fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide landingPage, subSource, fullName, email, phone and message',
      });
    }

    const lead = await LandingPageLead.create({
      landingPage,
      subSource,
      fullName,
      email,
      phone,
      message,
    });

    try {
      await sendLandingPageLeadToGoogleSheet({
        landingPage: lead.landingPage,
        subSource: lead.subSource,
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
      });
    } catch (sheetsError) {
      console.error('[Google Sheets] Unexpected error after landing page lead save:', sheetsError.message);
    }

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendToZapier({
        landingPage: lead.landingPage,
        subSource: lead.subSource,
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
        source: ZAPIER_SOURCES.LANDING_PAGE_LEAD,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after landing page lead save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Landing page lead created successfully',
      data: lead,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all landing page leads - GET /api/landing-page-lead
const getAllLandingPageLeads = async (req, res) => {
  try {
    const filter = {};
    if (req.query.landingPage) {
      filter.landingPage = String(req.query.landingPage).trim().toLowerCase();
    }

    const leads = await LandingPageLead.find(filter).sort({ createdAt: -1 });

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

// 3. Get landing page lead by id - GET /api/landing-page-lead/:id
const getLandingPageLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid landing page lead id',
      });
    }

    const lead = await LandingPageLead.findById(id);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Landing page lead not found',
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

// 4. Update landing page lead - PUT /api/landing-page-lead/:id
const updateLandingPageLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid landing page lead id',
      });
    }

    const updates = {};
    const allowedFields = ['landingPage', 'subSource', 'fullName', 'email', 'phone', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await LandingPageLead.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Landing page lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Landing page lead updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete landing page lead - DELETE /api/landing-page-lead/:id
const deleteLandingPageLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid landing page lead id',
      });
    }

    const deleted = await LandingPageLead.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Landing page lead not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Landing page lead deleted successfully',
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
  createLandingPageLead,
  getAllLandingPageLeads,
  getLandingPageLeadById,
  updateLandingPageLead,
  deleteLandingPageLead,
};
