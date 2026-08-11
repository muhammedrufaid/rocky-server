const mongoose = require('mongoose');
const AreaGuide = require('../models/AreaGuide');
const TeamMember = require('../models/TeamMember');

const isDuplicateKeyError = (error) =>
  Boolean(error && (error.code === 11000 || error.code === '11000'));

const duplicateFieldMessage = (error) => {
  const key = error?.keyPattern ? Object.keys(error.keyPattern)[0] : null;
  if (key === 'slug') return 'An area guide with this slug already exists';
  if (key === 'order') return 'An area guide with this order already exists';
  return 'An area guide with this value already exists';
};

const normalizeSlug = (slug) => String(slug || '').trim().toLowerCase();

const slugFromPath = (path) => {
  if (!path || typeof path !== 'string') return '';
  const cleaned = path.trim().replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
};

const validateKeyHighlights = (keyHighlights) => {
  if (keyHighlights === undefined) return null;
  if (!Array.isArray(keyHighlights)) {
    return 'keyHighlights must be an array';
  }

  for (let i = 0; i < keyHighlights.length; i += 1) {
    const item = keyHighlights[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `keyHighlights[${i}] must be an object`;
    }
    if (!item.icon || typeof item.icon !== 'string') {
      return `keyHighlights[${i}] must include an icon string`;
    }
    if (!item.title || typeof item.title !== 'string') {
      return `keyHighlights[${i}] must include a title string`;
    }
  }

  return null;
};

const validateAgentOrders = (agentOrders) => {
  if (agentOrders === undefined) return null;
  if (!Array.isArray(agentOrders)) {
    return 'agentOrders must be an array';
  }

  for (let i = 0; i < agentOrders.length; i += 1) {
    if (typeof agentOrders[i] !== 'number' || Number.isNaN(agentOrders[i])) {
      return `agentOrders[${i}] must be a number`;
    }
  }

  return null;
};

const validateListingsSearch = (listingsSearch) => {
  if (listingsSearch === undefined) return null;
  if (!Array.isArray(listingsSearch)) {
    return 'listingsSearch must be an array';
  }

  for (let i = 0; i < listingsSearch.length; i += 1) {
    if (typeof listingsSearch[i] !== 'string') {
      return `listingsSearch[${i}] must be a string`;
    }
  }

  return null;
};

const attachAgents = async (guide) => {
  const plain = guide.toObject ? guide.toObject() : { ...guide };
  const orders = Array.isArray(plain.agentOrders) ? plain.agentOrders : [];

  if (!orders.length) {
    plain.agents = [];
    return plain;
  }

  const members = await TeamMember.find({
    order: { $in: orders },
    isActive: true,
  }).sort({ order: 1 });

  const byOrder = new Map(members.map((m) => [m.order, m]));
  plain.agents = orders.map((order) => byOrder.get(order)).filter(Boolean);

  return plain;
};

// 1. Create Area Guide - POST /api/area-guides
const createAreaGuide = async (req, res) => {
  try {
    const {
      order,
      slug,
      title,
      about,
      keyHighlights,
      agentOrders,
      mapQuery,
      image,
      path,
      listingsSearch,
      isActive,
    } = req.body;

    if (
      order === undefined ||
      order === null ||
      order === '' ||
      !title ||
      !about ||
      !mapQuery
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please provide order, title, about and mapQuery',
      });
    }

    if (typeof order !== 'number' || Number.isNaN(order)) {
      return res.status(400).json({
        success: false,
        message: 'order must be a number',
      });
    }

    const resolvedSlug = normalizeSlug(slug) || slugFromPath(path);
    if (!resolvedSlug) {
      return res.status(400).json({
        success: false,
        message: 'Please provide slug (or a path that includes a slug)',
      });
    }

    const highlightsError = validateKeyHighlights(keyHighlights);
    if (highlightsError) {
      return res.status(400).json({
        success: false,
        message: highlightsError,
      });
    }

    const agentsError = validateAgentOrders(agentOrders);
    if (agentsError) {
      return res.status(400).json({
        success: false,
        message: agentsError,
      });
    }

    const listingsError = validateListingsSearch(listingsSearch);
    if (listingsError) {
      return res.status(400).json({
        success: false,
        message: listingsError,
      });
    }

    const existingSlug = await AreaGuide.findOne({ slug: resolvedSlug });
    if (existingSlug) {
      return res.status(400).json({
        success: false,
        message: 'An area guide with this slug already exists',
      });
    }

    const existingOrder = await AreaGuide.findOne({ order });
    if (existingOrder) {
      return res.status(400).json({
        success: false,
        message: 'An area guide with this order already exists',
      });
    }

    const areaGuide = await AreaGuide.create({
      order,
      slug: resolvedSlug,
      title,
      about,
      keyHighlights: keyHighlights || [],
      agentOrders: agentOrders || [],
      mapQuery,
      image,
      path: path || `/area-guides/${resolvedSlug}`,
      listingsSearch,
      isActive: isActive !== undefined ? isActive : true,
    });

    const data = await attachAgents(areaGuide);

    return res.status(201).json({
      success: true,
      message: 'Area guide created successfully',
      data,
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

// 2. Get all Area Guides - GET /api/area-guides?isActive=true
const getAreaGuides = async (req, res) => {
  try {
    const filter = {};

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const guides = await AreaGuide.find(filter).sort({ order: 1 });

    const includeAgents = req.query.includeAgents === 'true';
    const data = includeAgents
      ? await Promise.all(guides.map((guide) => attachAgents(guide)))
      : guides;

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get Area Guide by MongoDB _id - GET /api/area-guides/:id
const getAreaGuideById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const areaGuide = await AreaGuide.findById(id);
    if (!areaGuide) {
      return res.status(404).json({
        success: false,
        message: 'Area guide not found',
      });
    }

    const data = await attachAgents(areaGuide);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Get Area Guide by slug - GET /api/area-guides/slug/:slug
const getAreaGuideBySlug = async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: 'Slug is required',
      });
    }

    const filter = { slug };

    if (req.query.isActive === 'false') {
      filter.isActive = false;
    } else if (req.query.isActive === 'true' || req.query.isActive === undefined) {
      filter.isActive = true;
    }

    const areaGuide = await AreaGuide.findOne(filter);
    if (!areaGuide) {
      return res.status(404).json({
        success: false,
        message: 'Area guide not found',
      });
    }

    const data = await attachAgents(areaGuide);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Update Area Guide - PUT /api/area-guides/:id
const updateAreaGuide = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const updates = {};
    const allowedFields = [
      'order',
      'slug',
      'title',
      'about',
      'keyHighlights',
      'agentOrders',
      'mapQuery',
      'image',
      'path',
      'listingsSearch',
      'isActive',
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.slug !== undefined) {
      if (!updates.slug || typeof updates.slug !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'slug must be a non-empty string',
        });
      }
      updates.slug = normalizeSlug(updates.slug);
    }

    if (updates.order !== undefined) {
      if (typeof updates.order !== 'number' || Number.isNaN(updates.order)) {
        return res.status(400).json({
          success: false,
          message: 'order must be a number',
        });
      }
    }

    const highlightsError = validateKeyHighlights(updates.keyHighlights);
    if (highlightsError) {
      return res.status(400).json({
        success: false,
        message: highlightsError,
      });
    }

    const agentsError = validateAgentOrders(updates.agentOrders);
    if (agentsError) {
      return res.status(400).json({
        success: false,
        message: agentsError,
      });
    }

    const listingsError = validateListingsSearch(updates.listingsSearch);
    if (listingsError) {
      return res.status(400).json({
        success: false,
        message: listingsError,
      });
    }

    if (updates.slug) {
      const existingSlug = await AreaGuide.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (existingSlug) {
        return res.status(400).json({
          success: false,
          message: 'An area guide with this slug already exists',
        });
      }
    }

    if (updates.order !== undefined) {
      const existingOrder = await AreaGuide.findOne({
        order: updates.order,
        _id: { $ne: id },
      });
      if (existingOrder) {
        return res.status(400).json({
          success: false,
          message: 'An area guide with this order already exists',
        });
      }
    }

    const updated = await AreaGuide.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Area guide not found',
      });
    }

    const data = await attachAgents(updated);

    return res.status(200).json({
      success: true,
      message: 'Area guide updated successfully',
      data,
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

// 6. Delete Area Guide - DELETE /api/area-guides/:id (soft delete via isActive: false)
const deleteAreaGuide = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid area guide id',
      });
    }

    const deleted = await AreaGuide.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Area guide not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Area guide deleted successfully',
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
  createAreaGuide,
  getAreaGuides,
  getAreaGuideById,
  getAreaGuideBySlug,
  updateAreaGuide,
  deleteAreaGuide,
};
