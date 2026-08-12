const express = require('express');
const router = express.Router();

const { testOpenAI } = require('../controllers/aiController');

// Temporary connectivity test — POST /api/ai/test
// Protected by global requireApiKey on /api (see src/index.js)
router.post('/test', testOpenAI);

module.exports = router;
