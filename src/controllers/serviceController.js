const mongoose = require('mongoose');
const Service = require('../models/Service');

const isDuplicateKeyError = (error) =>
  Boolean(error && (error.code === 11000 || error.code === '11000'));

const duplicateFieldMessage = (error) => {
  const key = error?.keyPattern ? Object.keys(error.keyPattern)[0] : null;
  if (key === 'slug') return 'A service with this slug already exists';
  if (key === 'id') return 'A service with this id already exists';
  return 'A service with this value already exists';
};

const validateSubservices = (subservices) => {
  if (subservices === undefined) return null;
  if (!Array.isArray(subservices)) {
    return 'subservices must be an array';
  }

  for (const item of subservices) {
    if (!item || typeof item !== 'object') {
      return 'Each subservice must be an object';
    }
    if (item.id === undefined || item.id === null || item.id === '') {
      return 'Each subservice must include id';
    }
    if (typeof item.id !== 'number' || Number.isNaN(item.id)) {
      return 'Each subservice id must be a number';
    }
    if (!item.title || typeof item.title !== 'string') {
      return 'Each subservice must include title';
    }
    if (item.points !== undefined && !Array.isArray(item.points)) {
      return 'subservice points must be an array';
    }
  }

  return null;
};

// 1. Create Service - POST /api/services
const createService = async (req, res) => {
  try {
    const {
      id,
      slug,
      title,
      image,
      icon,
      description,
      overviewHeading,
      overview,
      subservices,
      isActive,
    } = req.body;

    if (id === undefined || id === null || id === '' || !slug || !title || !description) {
      return res.status(400).json({
        success: false,
        message: 'Please provide id, slug, title and description',
      });
    }

    if (typeof id !== 'number' || Number.isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'id must be a number',
      });
    }

    if (overview !== undefined && !Array.isArray(overview)) {
      return res.status(400).json({
        success: false,
        message: 'overview must be an array',
      });
    }

    const subservicesError = validateSubservices(subservices);
    if (subservicesError) {
      return res.status(400).json({
        success: false,
        message: subservicesError,
      });
    }

    const existingSlug = await Service.findOne({ slug: String(slug).trim().toLowerCase() });
    if (existingSlug) {
      return res.status(400).json({
        success: false,
        message: 'A service with this slug already exists',
      });
    }

    const existingId = await Service.findOne({ id });
    if (existingId) {
      return res.status(400).json({
        success: false,
        message: 'A service with this id already exists',
      });
    }

    const service = await Service.create({
      id,
      slug: String(slug).trim().toLowerCase(),
      title,
      image,
      icon,
      description,
      overviewHeading,
      overview,
      subservices: subservices || [],
      isActive: isActive !== undefined ? isActive : true,
    });

    return res.status(201).json({
      success: true,
      message: 'Service created successfully',
      data: service,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(400).json({
        success: false,
        message: duplicateFieldMessage(error),
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all Services - GET /api/services?isActive=true
const getServices = async (req, res) => {
  try {
    const filter = {};

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const services = await Service.find(filter).sort({ id: 1 });

    return res.status(200).json({
      success: true,
      count: services.length,
      data: services,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get Service by MongoDB _id - GET /api/services/:id
const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service id',
      });
    }

    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: service,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Get Service by slug - GET /api/services/slug/:slug
const getServiceBySlug = async (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: 'Slug is required',
      });
    }

    const filter = { slug };

    // Mirror FAQ frontend convention: inactive content is hidden unless explicitly requested
    if (req.query.isActive === 'false') {
      filter.isActive = false;
    } else if (req.query.isActive === 'true' || req.query.isActive === undefined) {
      filter.isActive = true;
    }

    const service = await Service.findOne(filter);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: service,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Update Service - PUT /api/services/:id
const updateService = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service id',
      });
    }

    const updates = {};
    const allowedFields = [
      'id',
      'slug',
      'title',
      'image',
      'icon',
      'description',
      'overviewHeading',
      'overview',
      'subservices',
      'isActive',
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.id !== undefined && (typeof updates.id !== 'number' || Number.isNaN(updates.id))) {
      return res.status(400).json({
        success: false,
        message: 'id must be a number',
      });
    }

    if (updates.slug !== undefined) {
      if (!updates.slug || typeof updates.slug !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'slug must be a non-empty string',
        });
      }
      updates.slug = updates.slug.trim().toLowerCase();
    }

    if (updates.overview !== undefined && !Array.isArray(updates.overview)) {
      return res.status(400).json({
        success: false,
        message: 'overview must be an array',
      });
    }

    const subservicesError = validateSubservices(updates.subservices);
    if (subservicesError) {
      return res.status(400).json({
        success: false,
        message: subservicesError,
      });
    }

    if (updates.slug) {
      const existingSlug = await Service.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (existingSlug) {
        return res.status(400).json({
          success: false,
          message: 'A service with this slug already exists',
        });
      }
    }

    if (updates.id !== undefined) {
      const existingId = await Service.findOne({
        id: updates.id,
        _id: { $ne: id },
      });
      if (existingId) {
        return res.status(400).json({
          success: false,
          message: 'A service with this id already exists',
        });
      }
    }

    const updated = await Service.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Service updated successfully',
      data: updated,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(400).json({
        success: false,
        message: duplicateFieldMessage(error),
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 6. Delete Service - DELETE /api/services/:id (soft delete via isActive: false)
const deleteService = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service id',
      });
    }

    const deleted = await Service.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Service deleted successfully',
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
  createService,
  getServices,
  getServiceById,
  getServiceBySlug,
  updateService,
  deleteService,
};
