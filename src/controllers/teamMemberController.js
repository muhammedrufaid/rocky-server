const mongoose = require('mongoose');
const TeamMember = require('../models/TeamMember');

const isDuplicateKeyError = (error) =>
  Boolean(error && (error.code === 11000 || error.code === '11000'));

const duplicateFieldMessage = (error) => {
  const key = error?.keyPattern ? Object.keys(error.keyPattern)[0] : null;
  if (key === 'slug') return 'A team member with this slug already exists';
  if (key === 'order') return 'A team member with this order already exists';
  return 'A team member with this value already exists';
};

const normalizeSlug = (slug) => String(slug || '').trim().toLowerCase();

const slugifyName = (name) =>
  String(name || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');

const parseBooleanQuery = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

const validateStringArray = (value, fieldName) => {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') {
      return `${fieldName}[${i}] must be a string`;
    }
  }
  return null;
};

const resolveSlug = ({ slug, name }) => {
  const fromSlug = normalizeSlug(slug);
  if (fromSlug) return fromSlug;
  return slugifyName(name);
};

// 1. Create Team Member - POST /api/team-members
const createTeamMember = async (req, res) => {
  try {
    const {
      order,
      isAdmin,
      isAgent,
      name,
      slug,
      department,
      designation,
      image,
      phone,
      email,
      whatsapp,
      languages,
      experience,
      businessCardPdf,
      isActive,
    } = req.body;

    if (
      order === undefined ||
      order === null ||
      order === '' ||
      !name ||
      !department ||
      !designation
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please provide order, name, department and designation',
      });
    }

    if (typeof order !== 'number' || Number.isNaN(order)) {
      return res.status(400).json({
        success: false,
        message: 'order must be a number',
      });
    }

    const languagesError = validateStringArray(languages, 'languages');
    if (languagesError) {
      return res.status(400).json({
        success: false,
        message: languagesError,
      });
    }

    const experienceError = validateStringArray(experience, 'experience');
    if (experienceError) {
      return res.status(400).json({
        success: false,
        message: experienceError,
      });
    }

    const resolvedSlug = resolveSlug({ slug, name });
    if (!resolvedSlug) {
      return res.status(400).json({
        success: false,
        message: 'Please provide slug (or a name that can generate one)',
      });
    }

    const existingSlug = await TeamMember.findOne({ slug: resolvedSlug });
    if (existingSlug) {
      return res.status(400).json({
        success: false,
        message: 'A team member with this slug already exists',
      });
    }

    const existingOrder = await TeamMember.findOne({ order });
    if (existingOrder) {
      return res.status(400).json({
        success: false,
        message: 'A team member with this order already exists',
      });
    }

    const teamMember = await TeamMember.create({
      order,
      isAdmin: isAdmin !== undefined ? Boolean(isAdmin) : false,
      isAgent: isAgent !== undefined ? Boolean(isAgent) : false,
      name,
      slug: resolvedSlug,
      department,
      designation,
      image,
      phone,
      email,
      whatsapp,
      languages,
      experience,
      businessCardPdf,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
    });

    return res.status(201).json({
      success: true,
      message: 'Team member created successfully',
      data: teamMember,
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

// 2. Get all Team Members - GET /api/team-members
const getTeamMembers = async (req, res) => {
  try {
    const filter = {};

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const isAgent = parseBooleanQuery(req.query.isAgent);
    if (isAgent !== undefined) {
      filter.isAgent = isAgent;
    }

    const isAdmin = parseBooleanQuery(req.query.isAdmin);
    if (isAdmin !== undefined) {
      filter.isAdmin = isAdmin;
    }

    if (req.query.department) {
      filter.department = String(req.query.department);
    }

    const teamMembers = await TeamMember.find(filter).sort({ order: 1 });

    return res.status(200).json({
      success: true,
      count: teamMembers.length,
      data: teamMembers,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get Team Member by MongoDB _id - GET /api/team-members/:id
const getTeamMemberById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid team member id',
      });
    }

    const teamMember = await TeamMember.findById(id);
    if (!teamMember) {
      return res.status(404).json({
        success: false,
        message: 'Team member not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: teamMember,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Get Team Member by slug - GET /api/team-members/slug/:slug
const getTeamMemberBySlug = async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: 'Slug is required',
      });
    }

    const filter = { slug };

    // Mirror Service/Blog convention: inactive content is hidden unless explicitly requested
    if (req.query.isActive === 'false') {
      filter.isActive = false;
    } else if (req.query.isActive === 'true' || req.query.isActive === undefined) {
      filter.isActive = true;
    }

    const teamMember = await TeamMember.findOne(filter);
    if (!teamMember) {
      return res.status(404).json({
        success: false,
        message: 'Team member not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: teamMember,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Update Team Member - PUT /api/team-members/:id
const updateTeamMember = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid team member id',
      });
    }

    const updates = {};
    const allowedFields = [
      'order',
      'isAdmin',
      'isAgent',
      'name',
      'slug',
      'department',
      'designation',
      'image',
      'phone',
      'email',
      'whatsapp',
      'languages',
      'experience',
      'businessCardPdf',
      'isActive',
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (updates.order !== undefined && (typeof updates.order !== 'number' || Number.isNaN(updates.order))) {
      return res.status(400).json({
        success: false,
        message: 'order must be a number',
      });
    }

    if (updates.isAdmin !== undefined) {
      updates.isAdmin = Boolean(updates.isAdmin);
    }

    if (updates.isAgent !== undefined) {
      updates.isAgent = Boolean(updates.isAgent);
    }

    if (updates.isActive !== undefined) {
      updates.isActive = Boolean(updates.isActive);
    }

    if (updates.slug !== undefined) {
      if (!updates.slug || typeof updates.slug !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'slug must be a non-empty string',
        });
      }
      updates.slug = normalizeSlug(updates.slug);
    }

    const languagesError = validateStringArray(updates.languages, 'languages');
    if (languagesError) {
      return res.status(400).json({
        success: false,
        message: languagesError,
      });
    }

    const experienceError = validateStringArray(updates.experience, 'experience');
    if (experienceError) {
      return res.status(400).json({
        success: false,
        message: experienceError,
      });
    }

    if (updates.slug) {
      const existingSlug = await TeamMember.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (existingSlug) {
        return res.status(400).json({
          success: false,
          message: 'A team member with this slug already exists',
        });
      }
    }

    if (updates.order !== undefined) {
      const existingOrder = await TeamMember.findOne({
        order: updates.order,
        _id: { $ne: id },
      });
      if (existingOrder) {
        return res.status(400).json({
          success: false,
          message: 'A team member with this order already exists',
        });
      }
    }

    const updated = await TeamMember.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Team member not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Team member updated successfully',
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

// 6. Delete Team Member - DELETE /api/team-members/:id (soft delete via isActive: false)
const deleteTeamMember = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid team member id',
      });
    }

    const deleted = await TeamMember.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Team member not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Team member deleted successfully',
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
  createTeamMember,
  getTeamMembers,
  getTeamMemberById,
  getTeamMemberBySlug,
  updateTeamMember,
  deleteTeamMember,
};
