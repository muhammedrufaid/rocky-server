const mongoose = require('mongoose');
const Sell = require('../models/sell');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create sell inquiry - POST /api/sell
const createSell = async (req, res) => {
  try {
    const { fullName, phone, email, propertyType, locationArea, message } = req.body;

    if (!fullName || !phone || !email || !propertyType || !locationArea || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, phone, email, propertyType, locationArea and message',
      });
    }

    const sell = await Sell.create({
      fullName,
      phone,
      email,
      propertyType,
      locationArea,
      message,
    });

    try {
      await sendToZapier({
        fullName: sell.fullName,
        phone: sell.phone,
        email: sell.email,
        propertyType: sell.propertyType,
        locationArea: sell.locationArea,
        message: sell.message,
        source: ZAPIER_SOURCES.SELL_INQUIRY,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after sell save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Sell inquiry created successfully',
      data: {
        ...sell.toObject(),
        source: ZAPIER_SOURCES.SELL_INQUIRY,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all sell inquiries - GET /api/sell
const getAllSell = async (req, res) => {
  try {
    const sells = await Sell.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: sells.length,
      data: sells,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get sell inquiry by id - GET /api/sell/:id
const getSellById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sell id',
      });
    }

    const sell = await Sell.findById(id);
    if (!sell) {
      return res.status(404).json({
        success: false,
        message: 'Sell inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: sell,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update sell inquiry - PUT /api/sell/:id
const updateSell = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sell id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'phone', 'email', 'propertyType', 'locationArea', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await Sell.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Sell inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Sell inquiry updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete sell inquiry - DELETE /api/sell/:id
const deleteSell = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sell id',
      });
    }

    const deleted = await Sell.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Sell inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Sell inquiry deleted successfully',
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
  createSell,
  getAllSell,
  getSellById,
  updateSell,
  deleteSell,
};

