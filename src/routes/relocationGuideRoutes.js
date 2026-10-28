const express = require('express');
const router = express.Router();

const { uploadCV } = require('../middleware/upload');
const {
  relocationGuideRateLimit,
  requestRelocationGuide,
} = require('../controllers/relocationGuideController');

// Public form. /api already requires x-api-key.
// CV upload matches POST /api/teamtailor/apply: form-data key "cv", then S3 folder "cvs".
router.post('/', relocationGuideRateLimit, uploadCV, requestRelocationGuide);

module.exports = router;
