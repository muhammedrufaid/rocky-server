const express = require('express');
const router = express.Router();

const {
  createAreaGuide,
  getAreaGuides,
  getAreaGuideById,
  getAreaGuideBySlug,
  updateAreaGuide,
  deleteAreaGuide,
} = require('../controllers/areaGuideController');

// 1. Create Area Guide - POST /api/area-guides
router.post('/', createAreaGuide);

// 2. Get all Area Guides - GET /api/area-guides
router.get('/', getAreaGuides);

// 3. Get Area Guide by slug - GET /api/area-guides/slug/:slug
// Must be registered before /:id to avoid treating "slug" as an ObjectId
router.get('/slug/:slug', getAreaGuideBySlug);

// 4. Get Area Guide by id - GET /api/area-guides/:id
router.get('/:id', getAreaGuideById);

// 5. Update Area Guide - PUT /api/area-guides/:id
router.put('/:id', updateAreaGuide);

// 6. Delete Area Guide - DELETE /api/area-guides/:id
router.delete('/:id', deleteAreaGuide);

module.exports = router;
