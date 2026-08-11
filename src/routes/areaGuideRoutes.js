const express = require('express');
const router = express.Router();

const {
  createAreaGuide,
  getAreaGuides,
  getAreaGuideById,
  getAreaGuideBySlug,
  updateAreaGuide,
  deleteAreaGuide,
  getAgentsByListingsSearch,
  syncAllAreaGuideAgents,
  syncAreaGuideAgents,
} = require('../controllers/areaGuideController');

// 1. Create Area Guide - POST /api/area-guides
router.post('/', createAreaGuide);

// 2. Sync all area guide agentOrders from property listings
// Must be before /:id
router.post('/sync-agents', syncAllAreaGuideAgents);

// 3. Get all Area Guides - GET /api/area-guides
router.get('/', getAreaGuides);

// 4. Preview agents from listingsSearch - GET /api/area-guides/agents
// Must be before /:id
router.get('/agents', getAgentsByListingsSearch);

// 5. Get Area Guide by slug - GET /api/area-guides/slug/:slug
router.get('/slug/:slug', getAreaGuideBySlug);

// 6. Get Area Guide by id - GET /api/area-guides/:id
router.get('/:id', getAreaGuideById);

// 7. Sync one area guide agentOrders - POST /api/area-guides/:id/sync-agents
router.post('/:id/sync-agents', syncAreaGuideAgents);

// 8. Update Area Guide - PUT /api/area-guides/:id
router.put('/:id', updateAreaGuide);

// 9. Delete Area Guide - DELETE /api/area-guides/:id
router.delete('/:id', deleteAreaGuide);

module.exports = router;
