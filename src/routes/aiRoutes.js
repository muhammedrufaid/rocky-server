const express = require('express');
const router = express.Router();

const { chatHandler } = require('../controllers/aiController');

// POST /api/ai/chat — confidential → intent → structured | ragService
router.post('/chat', chatHandler);

module.exports = router;
