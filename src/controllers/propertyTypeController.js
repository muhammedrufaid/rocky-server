const mongoose = require('mongoose');
const PropertyType = require('../models/PropertyType');
const { CATEGORIES } = PropertyType;

const parseCategories = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'Please provide categories as a non-empty array' };
  }

  const cleaned = value.map((item) => String(item).trim());
  const invalid = cleaned.filter((item) => !CATEGORIES.includes(item));
  if (invalid.length) {
    return { error: `Invalid category. Allowed values: ${CATEGORIES.join(', ')}` };
  }

  return { categories: CATEGORIES.filter((category) => cleaned.includes(category)) };
};

const duplicateResponse = (res) =>
  res.status(409).json({
    success: false,
    message: 'Property type already exists',
  });

// POST /api/property-types
const createPropertyType = async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const parsed = parseCategories(req.body?.categories);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name and categories',
      });
    }

    if (parsed.error) {
      return res.status(400).json({
        success: false,
        message: parsed.error,
      });
    }

    const existing = await PropertyType.findOne({ name });
    if (existing) return duplicateResponse(res);

    const propertyType = await PropertyType.create({ name, categories: parsed.categories });

    return res.status(201).json({
      success: true,
      message: 'Property type created successfully',
      data: propertyType,
    });
  } catch (error) {
    if (error.code === 11000) return duplicateResponse(res);

    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// GET /api/property-types?category=Residential|Commercial
const getAllPropertyTypes = async (req, res) => {
  try {
    const filter = {};

    if (req.query.category) {
      if (!CATEGORIES.includes(req.query.category)) {
        return res.status(400).json({
          success: false,
          message: `Invalid category. Allowed values: ${CATEGORIES.join(', ')}`,
        });
      }
      filter.categories = req.query.category;
    }

    const propertyTypes = await PropertyType.find(filter).sort({ name: 1 }).select('name categories');

    return res.status(200).json({
      success: true,
      count: propertyTypes.length,
      data: propertyTypes,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// GET /api/property-types/:id
const getPropertyTypeById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property type id',
      });
    }

    const propertyType = await PropertyType.findById(req.params.id).select('name categories');
    if (!propertyType) {
      return res.status(404).json({
        success: false,
        message: 'Property type not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: propertyType,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// PUT /api/property-types/:id
const updatePropertyType = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property type id',
      });
    }

    const existing = await PropertyType.findById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Property type not found',
      });
    }

    const updates = {};

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Name cannot be empty',
        });
      }
      updates.name = name;
    }

    if (req.body.categories !== undefined) {
      const parsed = parseCategories(req.body.categories);
      if (parsed.error) {
        return res.status(400).json({
          success: false,
          message: parsed.error,
        });
      }
      updates.categories = parsed.categories;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name or categories to update',
      });
    }

    const nextName = updates.name ?? existing.name;
    const duplicate = await PropertyType.findOne({ _id: { $ne: id }, name: nextName });
    if (duplicate) return duplicateResponse(res);

    const updated = await PropertyType.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).select('name categories');

    return res.status(200).json({
      success: true,
      message: 'Property type updated successfully',
      data: updated,
    });
  } catch (error) {
    if (error.code === 11000) return duplicateResponse(res);

    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// DELETE /api/property-types/:id
const deletePropertyType = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property type id',
      });
    }

    const deleted = await PropertyType.findByIdAndDelete(id).select('name categories');
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Property type not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Property type deleted successfully',
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
  createPropertyType,
  getAllPropertyTypes,
  getPropertyTypeById,
  updatePropertyType,
  deletePropertyType,
};
