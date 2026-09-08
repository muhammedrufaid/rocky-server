const express = require('express');
const router = express.Router();
const {
  getGoogleBusinessProfileReviews,
  getGoogleBusinessProfiles,
} = require('../controllers/googleReviewController');

// GET /api/reviews/google/business-profiles
router.get('/google/business-profiles', getGoogleBusinessProfiles);

// GET /api/reviews/google
router.get('/google', getGoogleBusinessProfileReviews);

module.exports = router;
