const mongoose = require('mongoose');
const Blog = require('../models/Blog');

const isDuplicateKeyError = (error) =>
  Boolean(error && (error.code === 11000 || error.code === '11000'));

const duplicateFieldMessage = (error) => {
  const key = error?.keyPattern ? Object.keys(error.keyPattern)[0] : null;
  if (key === 'slug') return 'A blog with this slug already exists';
  if (key === 'id') return 'A blog with this id already exists';
  return 'A blog with this value already exists';
};

/**
 * Light validation for content blocks.
 * Requires `type` on every block. Known types get field checks;
 * unknown / future types are allowed through for extensibility.
 */
const validateContent = (content) => {
  if (content === undefined) return null;
  if (!Array.isArray(content)) {
    return 'content must be an array';
  }

  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return `content[${i}] must be an object`;
    }
    if (!block.type || typeof block.type !== 'string') {
      return `content[${i}] must include a type string`;
    }

    const type = block.type.trim();
    if (!type) {
      return `content[${i}] type must be a non-empty string`;
    }

    if (type === 'paragraph' || type === 'heading2' || type === 'heading3') {
      if (typeof block.text !== 'string') {
        return `content[${i}] (${type}) must include a text string`;
      }
    } else if (type === 'list') {
      if (!Array.isArray(block.items)) {
        return `content[${i}] (list) must include an items array`;
      }
    } else if (type === 'image') {
      if (typeof block.src !== 'string' || !block.src) {
        return `content[${i}] (image) must include a src string`;
      }
      if (typeof block.alt !== 'string') {
        return `content[${i}] (image) must include an alt string`;
      }
    }
  }

  return null;
};

const normalizeSlug = (slug) => String(slug || '').trim().toLowerCase();

const slugFromPath = (path) => {
  if (!path || typeof path !== 'string') return '';
  const cleaned = path.trim().replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
};

// 1. Create Blog - POST /api/blogs
const createBlog = async (req, res) => {
  try {
    const {
      id,
      slug,
      title,
      category,
      subtitle,
      description,
      image,
      path,
      isFeatured,
      content,
      isActive,
    } = req.body;

    if (
      id === undefined ||
      id === null ||
      id === '' ||
      !title ||
      !category ||
      !description
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please provide id, title, category and description',
      });
    }

    if (typeof id !== 'number' || Number.isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: 'id must be a number',
      });
    }

    const resolvedSlug = normalizeSlug(slug) || slugFromPath(path);
    if (!resolvedSlug) {
      return res.status(400).json({
        success: false,
        message: 'Please provide slug (or a path that includes a slug)',
      });
    }

    if (content === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Please provide content',
      });
    }

    const contentError = validateContent(content);
    if (contentError) {
      return res.status(400).json({
        success: false,
        message: contentError,
      });
    }

    const existingSlug = await Blog.findOne({ slug: resolvedSlug });
    if (existingSlug) {
      return res.status(400).json({
        success: false,
        message: 'A blog with this slug already exists',
      });
    }

    const existingId = await Blog.findOne({ id });
    if (existingId) {
      return res.status(400).json({
        success: false,
        message: 'A blog with this id already exists',
      });
    }

    const blog = await Blog.create({
      id,
      slug: resolvedSlug,
      title,
      category,
      subtitle,
      description,
      image,
      path: path || `/blogs/${resolvedSlug}`,
      isFeatured: isFeatured !== undefined ? isFeatured : false,
      content: content || [],
      isActive: isActive !== undefined ? isActive : true,
    });

    return res.status(201).json({
      success: true,
      message: 'Blog created successfully',
      data: blog,
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

// 2. Get all Blogs - GET /api/blogs?isActive=true
const getBlogs = async (req, res) => {
  try {
    const filter = {};

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    if (req.query.category) {
      filter.category = String(req.query.category);
    }

    if (req.query.isFeatured !== undefined) {
      filter.isFeatured = req.query.isFeatured === 'true';
    }

    // Newest first by business id (matches frontend array order / recency)
    const blogs = await Blog.find(filter).sort({ id: -1 });

    return res.status(200).json({
      success: true,
      count: blogs.length,
      data: blogs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get Blog by MongoDB _id - GET /api/blogs/:id
const getBlogById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog id',
      });
    }

    const blog = await Blog.findById(id);
    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: blog,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Get Blog by slug - GET /api/blogs/slug/:slug
const getBlogBySlug = async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: 'Slug is required',
      });
    }

    const filter = { slug };

    // Mirror Service convention: inactive content is hidden unless explicitly requested
    if (req.query.isActive === 'false') {
      filter.isActive = false;
    } else if (req.query.isActive === 'true' || req.query.isActive === undefined) {
      filter.isActive = true;
    }

    const blog = await Blog.findOne(filter);
    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: blog,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Update Blog - PUT /api/blogs/:id
const updateBlog = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog id',
      });
    }

    const updates = {};
    const allowedFields = [
      'id',
      'slug',
      'title',
      'category',
      'subtitle',
      'description',
      'image',
      'path',
      'isFeatured',
      'content',
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
      updates.slug = normalizeSlug(updates.slug);
    }

    const contentError = validateContent(updates.content);
    if (contentError) {
      return res.status(400).json({
        success: false,
        message: contentError,
      });
    }

    if (updates.slug) {
      const existingSlug = await Blog.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (existingSlug) {
        return res.status(400).json({
          success: false,
          message: 'A blog with this slug already exists',
        });
      }
    }

    if (updates.id !== undefined) {
      const existingId = await Blog.findOne({
        id: updates.id,
        _id: { $ne: id },
      });
      if (existingId) {
        return res.status(400).json({
          success: false,
          message: 'A blog with this id already exists',
        });
      }
    }

    const updated = await Blog.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog updated successfully',
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

// 6. Delete Blog - DELETE /api/blogs/:id (soft delete via isActive: false)
const deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog id',
      });
    }

    const deleted = await Blog.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Blog deleted successfully',
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
  createBlog,
  getBlogs,
  getBlogById,
  getBlogBySlug,
  updateBlog,
  deleteBlog,
};
