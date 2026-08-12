const express = require('express');
const router = express.Router();

const { chatHandler, chatStreamHandler } = require('../controllers/aiController');

// POST /api/ai/chat — confidential → intent → structured | ragService
router.post('/chat', chatHandler);

// POST /api/ai/chat/stream — same orchestration; SSE token delivery
router.post('/chat/stream', chatStreamHandler);

module.exports = router;
