/**
 * AI Chat Routes
 * Responsibility: Mount AI chat endpoints under /api/ai
 *
 * POST /api/ai/chat — multi-turn chat with session-scoped MongoDB memory
 */

const express = require('express');
const { chat } = require('../controllers/chat.controller');

const router = express.Router();

router.post('/chat', chat);

module.exports = router;
