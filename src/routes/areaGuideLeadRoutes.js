const express = require('express');
const router = express.Router();

const {
  createAreaGuideLead,
  getAllAreaGuideLeads,
  getAreaGuideLeadById,
  updateAreaGuideLead,
  deleteAreaGuideLead,
} = require('../controllers/areaGuideLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create area guide inquiry - POST (public form; x-api-key only)
router.post('/', createAreaGuideLead);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
router.get('/', requireUserToken, getAllAreaGuideLeads);
router.get('/:id', requireUserToken, getAreaGuideLeadById);
router.put('/:id', requireUserToken, updateAreaGuideLead);
router.delete('/:id', requireUserToken, deleteAreaGuideLead);

module.exports = router;
