const express = require('express');
const router = express.Router();

const { chatHandler, chatStreamHandler } = require('../controllers/aiController');
const { aiRateLimiter } = require('../middleware/aiRateLimiter');

// POST /api/ai/chat — confidential → intent → structured | ragService
router.post('/chat', aiRateLimiter, chatHandler);

// POST /api/ai/chat/stream — same orchestration; SSE token delivery
router.post('/chat/stream', aiRateLimiter, chatStreamHandler);

module.exports = router;
