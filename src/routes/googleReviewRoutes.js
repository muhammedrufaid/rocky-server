const express = require('express');
const router = express.Router();
const { getGoogleBusinessProfileReviews } = require('../controllers/googleReviewController');

// GET /api/reviews/google
router.get('/google', getGoogleBusinessProfileReviews);

module.exports = router;
