const express = require('express');
const router = express.Router();

const {
  createLandingPageLead,
  getAllLandingPageLeads,
  getLandingPageLeadById,
  updateLandingPageLead,
  deleteLandingPageLead,
} = require('../controllers/landingPageLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

router.post('/', createLandingPageLead);

router.get('/', requireUserToken, getAllLandingPageLeads);
router.get('/:id', requireUserToken, getLandingPageLeadById);
router.put('/:id', requireUserToken, updateLandingPageLead);
router.delete('/:id', requireUserToken, deleteLandingPageLead);

module.exports = router;
