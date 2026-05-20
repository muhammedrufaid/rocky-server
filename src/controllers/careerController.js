const mongoose = require('mongoose');
const Career = require('../models/Career');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create career application - POST /api/career
const createCareer = async (req, res) => {
  try {
    const { name, email, phone, position, cvFileName, cvType, cvSize } = req.body;

    if (
      !name ||
      !email ||
      !phone ||
      !position ||
      !cvFileName ||
      !cvType ||
      cvSize === undefined ||
      cvSize === null
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Please provide name, email, phone, position, cvFileName, cvType and cvSize',
      });
    }

    const career = await Career.create({
      name,
      email,
      phone,
      position,
      cvFileName,
      cvType,
      cvSize,
    });

    try {
      await sendToZapier({
        name: career.name,
        email: career.email,
        phone: career.phone,
        position: career.position,
        cvFileName: career.cvFileName,
        cvType: career.cvType,
        cvSize: career.cvSize,
        source: ZAPIER_SOURCES.CAREERS,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after career save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Career application created successfully',
      data: {
        ...career.toObject(),
        source: ZAPIER_SOURCES.CAREERS,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all career applications - GET /api/career
const getAllCareers = async (req, res) => {
  try {
    const careers = await Career.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: careers.length,
      data: careers,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get career application by id - GET /api/career/:id
const getCareerById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const career = await Career.findById(id);
    if (!career) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: career,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update career application - PUT /api/career/:id
const updateCareer = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const updates = {};
    const allowedFields = [
      'name',
      'email',
      'phone',
      'position',
      'cvFileName',
      'cvType',
      'cvSize',
    ];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await Career.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Career application updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete career application - DELETE /api/career/:id
const deleteCareer = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid career application id',
      });
    }

    const deleted = await Career.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Career application not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Career application deleted successfully',
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
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
};
