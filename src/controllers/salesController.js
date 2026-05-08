const mongoose = require('mongoose');
const Sales = require('../models/sales');

// 1. Create sales inquiry - POST /api/sales
const createSales = async (req, res) => {
  try {
    const { fullName, phone, email, propertyType, locationArea, message } = req.body;

    if (!fullName || !phone || !email || !propertyType || !locationArea || !message) {
      return res.status(400).json({
        success: false,
        message:
          'Please provide fullName, phone, email, propertyType, locationArea and message',
      });
    }

    const sales = await Sales.create({
      fullName,
      phone,
      email,
      propertyType,
      locationArea,
      message,
    });

    return res.status(201).json({
      success: true,
      message: 'Sales inquiry created successfully',
      data: sales,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all sales inquiries - GET /api/sales
const getAllSales = async (req, res) => {
  try {
    const sales = await Sales.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: sales.length,
      data: sales,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get sales inquiry by id - GET /api/sales/:id
const getSalesById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sales id',
      });
    }

    const sales = await Sales.findById(id);
    if (!sales) {
      return res.status(404).json({
        success: false,
        message: 'Sales inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: sales,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update sales inquiry - PUT /api/sales/:id
const updateSales = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sales id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'phone', 'email', 'propertyType', 'locationArea', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await Sales.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Sales inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Sales inquiry updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete sales inquiry - DELETE /api/sales/:id
const deleteSales = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sales id',
      });
    }

    const deleted = await Sales.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Sales inquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Sales inquiry deleted successfully',
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
  createSales,
  getAllSales,
  getSalesById,
  updateSales,
  deleteSales,
};

