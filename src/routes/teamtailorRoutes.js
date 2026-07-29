const express = require('express');
const router = express.Router();

const {
  getJobs,
  getJobById,
  syncJobs,
} = require('../controllers/teamtailorController');

// Sync jobs from TeamTailor API into MongoDB - POST /api/teamtailor/sync
router.post('/sync', syncJobs);

// List jobs - GET /api/teamtailor/jobs
router.get('/jobs', getJobs);

// Get job by TeamTailor id - GET /api/teamtailor/jobs/:id
router.get('/jobs/:id', getJobById);

module.exports = router;
