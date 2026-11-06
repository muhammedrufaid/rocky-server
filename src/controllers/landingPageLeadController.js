const mongoose = require('mongoose');
const LandingPageLead = require('../models/LandingPageLead');
const { sendLandingPageLeadToGoogleSheet } = require('../services/googleSheetsService');
const { sendGoogleAdsLeadToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

function flattenQuiz(quiz) {
  if (!quiz || typeof quiz !== 'object') return {};
  return {
    quizGoal: quiz.goal || '',
    quizPropertyType: quiz.propertyType || '',
    quizBedrooms: quiz.bedrooms || '',
    quizBudget: quiz.budget || '',
    quizTimeline: quiz.timeline || '',
    quizPurchasedBefore: quiz.purchasedBefore || '',
    quizContactMethod: quiz.contactMethod || '',
    quizContactTime: quiz.contactTime || '',
  };
}

// 1. Create landing page lead - POST /api/landing-page-lead
const createLandingPageLead = async (req, res) => {
  try {
    const { landingPage, subSource, fullName, email, phone, message, language, quiz } = req.body;

    if (!landingPage || !subSource || !fullName || !email || !phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide landingPage, subSource, fullName, email, phone and message',
      });
    }

    if (quiz != null && (typeof quiz !== 'object' || Array.isArray(quiz))) {
      return res.status(400).json({
        success: false,
        message: 'quiz must be an object',
      });
    }

    const lead = await LandingPageLead.create({
      landingPage,
      subSource,
      fullName,
      email,
      phone,
      message,
      language,
      ...(quiz ? { quiz } : {}),
    });

    const quizAnswers = flattenQuiz(lead.quiz);

    try {
      await sendLandingPageLeadToGoogleSheet({
        landingPage: lead.landingPage,
        subSource: lead.subSource,
        fullName: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        message: lead.message,
        language: lead.language,
        ...quizAnswers,
      });
    } catch (sheetsError) {
      console.error('[Google Sheets] Unexpected error after landing page lead save:', sheetsError.message);
    }

    const zapierPayload = {
      landingPage: lead.landingPage,
      subSource: lead.subSource,
      fullName: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      language: lead.language,
      ...(lead.quiz ? { quiz: lead.quiz } : {}),
      ...quizAnswers,
      source: ZAPIER_SOURCES.LANDING_PAGE_LEAD,
    };

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendGoogleAdsLeadToZapier(zapierPayload);
    } catch (zapierError) {
      console.error('[Zapier Google Ads] Unexpected error after landing page lead save:', zapierError.message);
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

    if (req.body.quiz != null && (typeof req.body.quiz !== 'object' || Array.isArray(req.body.quiz))) {
      return res.status(400).json({
        success: false,
        message: 'quiz must be an object',
      });
    }

    const updates = {};
    const allowedFields = ['landingPage', 'subSource', 'fullName', 'email', 'phone', 'message', 'language', 'quiz'];
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
