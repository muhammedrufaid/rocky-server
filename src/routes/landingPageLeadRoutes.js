const express = require('express');
const router = express.Router();

const {
  createLandingPageLead,
  getAllLandingPageLeads,
  getLandingPageLeadById,
  updateLandingPageLead,
  deleteLandingPageLead,
} = require('../controllers/landingPageLeadController');

// 1. Create landing page lead - POST /api/landing-page-lead
router.post('/', createLandingPageLead);

// 2. Get all landing page leads - GET /api/landing-page-lead
router.get('/', getAllLandingPageLeads);

// 3. Get landing page lead by id - GET /api/landing-page-lead/:id
router.get('/:id', getLandingPageLeadById);

// 4. Update landing page lead - PUT /api/landing-page-lead/:id
router.put('/:id', updateLandingPageLead);

// 5. Delete landing page lead - DELETE /api/landing-page-lead/:id
router.delete('/:id', deleteLandingPageLead);

module.exports = router;
