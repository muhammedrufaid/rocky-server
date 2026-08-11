const express = require('express');
const router = express.Router();

const {
  createAreaGuideLead,
  getAllAreaGuideLeads,
  getAreaGuideLeadById,
  updateAreaGuideLead,
  deleteAreaGuideLead,
} = require('../controllers/areaGuideLeadController');

// 1. Create area guide inquiry - POST /api/area-guide-leads
router.post('/', createAreaGuideLead);

// 2. Get all area guide inquiries - GET /api/area-guide-leads
router.get('/', getAllAreaGuideLeads);

// 3. Get area guide inquiry by id - GET /api/area-guide-leads/:id
router.get('/:id', getAreaGuideLeadById);

// 4. Update area guide inquiry - PUT /api/area-guide-leads/:id
router.put('/:id', updateAreaGuideLead);

// 5. Delete area guide inquiry - DELETE /api/area-guide-leads/:id
router.delete('/:id', deleteAreaGuideLead);

module.exports = router;
