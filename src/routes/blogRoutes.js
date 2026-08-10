const express = require('express');
const router = express.Router();

const {
  createBlog,
  getBlogs,
  getBlogById,
  getBlogBySlug,
  updateBlog,
  deleteBlog,
} = require('../controllers/blogController');

// 1. Create Blog - POST /api/blogs
router.post('/', createBlog);

// 2. Get all Blogs - GET /api/blogs
router.get('/', getBlogs);

// 3. Get Blog by slug - GET /api/blogs/slug/:slug
// Must be registered before /:id to avoid treating "slug" as an ObjectId
router.get('/slug/:slug', getBlogBySlug);

// 4. Get Blog by id - GET /api/blogs/:id
router.get('/:id', getBlogById);

// 5. Update Blog - PUT /api/blogs/:id
router.put('/:id', updateBlog);

// 6. Delete Blog - DELETE /api/blogs/:id
router.delete('/:id', deleteBlog);

module.exports = router;
