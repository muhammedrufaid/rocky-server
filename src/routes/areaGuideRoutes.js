const express = require('express');
const router = express.Router();

const {
  createAreaGuide,
  getAllAreaGuides,
  getAreaGuideById,
  updateAreaGuide,
  deleteAreaGuide,
} = require('../controllers/areaGuideController');

// 1. Create area guide inquiry - POST /api/area-guides
router.post('/', createAreaGuide);

// 2. Get all area guide inquiries - GET /api/area-guides
router.get('/', getAllAreaGuides);

// 3. Get area guide inquiry by id - GET /api/area-guides/:id
router.get('/:id', getAreaGuideById);

// 4. Update area guide inquiry - PUT /api/area-guides/:id
router.put('/:id', updateAreaGuide);

// 5. Delete area guide inquiry - DELETE /api/area-guides/:id
router.delete('/:id', deleteAreaGuide);

module.exports = router;
