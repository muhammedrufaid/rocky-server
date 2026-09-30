const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const {
  reindexChatbot,
  searchChatbot,
  sendChatMessage,
  getChatHistory,
} = require('../controllers/chatbotController');

const requireAdminKey = (req, res, next) => {
  const expected = process.env.ADMIN_KEY;
  if (!expected) {
    return res.status(500).json({ success: false, message: 'ADMIN_KEY is not configured on the server' });
  }
  if (req.headers['x-admin-key'] !== expected) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Invalid or missing admin key' });
  }
  next();
};

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many messages. Please wait a minute and try again.' },
});

// 1. Rebuild embeddings - POST /api/chatbot/reindex
router.post('/reindex', requireAdminKey, reindexChatbot);

// 2. Debug retrieval - POST /api/chatbot/search
router.post('/search', requireAdminKey, searchChatbot);

// 3. Chat - POST /api/chatbot
router.post('/', chatLimiter, sendChatMessage);

// 4. Chat history - GET /api/chatbot/:sessionId
router.get('/:sessionId', getChatHistory);

module.exports = router;
