const mongoose = require('mongoose');
const Faq = require('../models/Faq');
const { FAQ_PAGES } = Faq;
const { scheduleDocumentEmbedding } = require('../ai/embeddingService');

const FAQ_PAGE_VALUES = Object.values(FAQ_PAGES);

// 1. Create FAQ - POST /api/faqs
const createFaq = async (req, res) => {
  try {
    const { page, slug, question, answer, order, isActive } = req.body;

    if (!page || !question || !answer) {
      return res.status(400).json({
        success: false,
        message: 'Please provide page, question and answer',
      });
    }

    if (!FAQ_PAGE_VALUES.includes(page)) {
      return res.status(400).json({
        success: false,
        message: `Invalid page. Allowed values: ${FAQ_PAGE_VALUES.join(', ')}`,
      });
    }

    const faq = await Faq.create({
      page,
      slug: slug || null,
      question,
      answer,
      order: order ?? 0,
      isActive: isActive !== undefined ? isActive : true,
    });

    scheduleDocumentEmbedding('faq', faq._id);

    return res.status(201).json({
      success: true,
      message: 'FAQ created successfully',
      data: faq,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all FAQs - GET /api/faqs?page=home&slug=downtown-dubai&isActive=true
const getAllFaqs = async (req, res) => {
  try {
    const filter = {};

    if (req.query.page) {
      if (!FAQ_PAGE_VALUES.includes(req.query.page)) {
        return res.status(400).json({
          success: false,
          message: `Invalid page. Allowed values: ${FAQ_PAGE_VALUES.join(', ')}`,
        });
      }
      filter.page = req.query.page;
    }

    if (req.query.slug !== undefined) {
      filter.slug = req.query.slug === '' || req.query.slug === 'null' ? null : req.query.slug;
    }

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const faqs = await Faq.find(filter).sort({ order: 1, createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: faqs.length,
      data: faqs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get FAQ by id - GET /api/faqs/:id
const getFaqById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid FAQ id',
      });
    }

    const faq = await Faq.findById(id);
    if (!faq) {
      return res.status(404).json({
        success: false,
        message: 'FAQ not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: faq,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update FAQ - PUT /api/faqs/:id
const updateFaq = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid FAQ id',
      });
    }

    const updates = {};
    const allowedFields = ['page', 'slug', 'question', 'answer', 'order', 'isActive'];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.page !== undefined && !FAQ_PAGE_VALUES.includes(updates.page)) {
      return res.status(400).json({
        success: false,
        message: `Invalid page. Allowed values: ${FAQ_PAGE_VALUES.join(', ')}`,
      });
    }

    if (updates.slug === '') {
      updates.slug = null;
    }

    const updated = await Faq.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'FAQ not found',
      });
    }

    scheduleDocumentEmbedding('faq', updated._id);

    return res.status(200).json({
      success: true,
      message: 'FAQ updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete FAQ - DELETE /api/faqs/:id
const deleteFaq = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid FAQ id',
      });
    }

    const deleted = await Faq.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'FAQ not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'FAQ deleted successfully',
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
  createFaq,
  getAllFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
};
