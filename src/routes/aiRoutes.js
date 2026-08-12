const express = require('express');
const router = express.Router();

const {
  testOpenAI,
  searchBlogChunksHandler,
  blogChatHandler,
  chatHandler,
} = require('../controllers/aiController');

// Temporary connectivity test — POST /api/ai/test
// Protected by global requireApiKey on /api (see src/index.js)
router.post('/test', testOpenAI);

// Temporary retrieval test — POST /api/ai/blog-search
// Query → embedding → Atlas Vector Search → chunks (no GPT / no RAG)
router.post('/blog-search', searchBlogChunksHandler);

// Blog-only RAG — POST /api/ai/blog-chat
// Question → blog retrieval → gpt-5-nano grounded answer
router.post('/blog-chat', blogChatHandler);

// Phase 1 orchestrator — POST /api/ai/chat
// validate → confidential guard → company knowledge → gpt-5-nano
router.post('/chat', chatHandler);

module.exports = router;
