const mongoose = require('mongoose');
const CompanyInfo = require('../models/CompanyInfo');

// POST /api/company-info
const createCompanyInfo = async (req, res) => {
  try {
    const { topic, question, answer, category, isActive } = req.body;

    if (!topic || !question || !answer) {
      return res.status(400).json({
        success: false,
        message: 'Please provide topic, question and answer',
      });
    }

    const entry = await CompanyInfo.create({
      topic: String(topic).trim(),
      question: String(question).trim(),
      answer: String(answer).trim(),
      category: category ? String(category).trim() : 'general',
      isActive: isActive !== undefined ? isActive : true,
    });

    return res.status(201).json({
      success: true,
      message: 'Company info created successfully',
      data: entry,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// GET /api/company-info?topic=&category=&isActive=
const listCompanyInfo = async (req, res) => {
  try {
    const filter = {};

    if (req.query.topic) {
      filter.topic = new RegExp(`^${escapeRegex(String(req.query.topic).trim())}$`, 'i');
    }

    if (req.query.category) {
      filter.category = new RegExp(`^${escapeRegex(String(req.query.category).trim())}$`, 'i');
    }

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const entries = await CompanyInfo.find(filter).sort({ category: 1, topic: 1, updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// GET /api/company-info/topic/:topic
const getCompanyInfoByTopic = async (req, res) => {
  try {
    const topic = String(req.params.topic || '').trim();
    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required',
      });
    }

    const filter = {
      topic: new RegExp(`^${escapeRegex(topic)}$`, 'i'),
    };
    if (req.query.category) {
      filter.category = new RegExp(`^${escapeRegex(String(req.query.category).trim())}$`, 'i');
    }
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    } else {
      filter.isActive = true;
    }

    const entries = await CompanyInfo.find(filter).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: entries.length,
      data: entries,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// GET /api/company-info/:id
const getCompanyInfoById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company info id',
      });
    }

    const entry = await CompanyInfo.findById(id);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: 'Company info not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: entry,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// PUT /api/company-info/:id
const updateCompanyInfo = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company info id',
      });
    }

    const updates = {};
    const allowedFields = ['topic', 'question', 'answer', 'category', 'isActive'];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update',
      });
    }

    const updated = await CompanyInfo.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Company info not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Company info updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// DELETE /api/company-info/:id
const deleteCompanyInfo = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company info id',
      });
    }

    const deleted = await CompanyInfo.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Company info not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Company info deleted successfully',
      data: deleted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  createCompanyInfo,
  listCompanyInfo,
  getCompanyInfoByTopic,
  getCompanyInfoById,
  updateCompanyInfo,
  deleteCompanyInfo,
};
