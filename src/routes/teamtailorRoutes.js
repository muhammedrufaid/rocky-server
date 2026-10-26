const express = require('express');
const router = express.Router();

const {
  getJobs,
  getJobById,
  syncJobs,
} = require('../controllers/teamtailorController');
const { uploadCV } = require('../middleware/upload');
const {
  applyRateLimit,
  applyForJob,
} = require('../controllers/teamtailorApplyController');

// Apply for a published job - POST /api/teamtailor/apply
// CV upload matches POST /api/career: uploadCV, then S3 folder "cvs"
router.post('/apply', applyRateLimit, uploadCV, applyForJob);

// Sync jobs from TeamTailor API into MongoDB - POST /api/teamtailor/sync
router.post('/sync', syncJobs);

// List jobs - GET /api/teamtailor/jobs
router.get('/jobs', getJobs);

// Get job by TeamTailor id - GET /api/teamtailor/jobs/:id
router.get('/jobs/:id', getJobById);

module.exports = router;
