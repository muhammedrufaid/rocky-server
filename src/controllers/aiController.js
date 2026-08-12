const { generateText, OpenAIServiceError } = require('../services/openaiService');
const {
  searchBlogChunks,
  BlogVectorSearchError,
} = require('../services/blogVectorSearchService');
const { generateBlogAnswer } = require('../services/blogRagService');
const { handleChat } = require('../ai/orchestrator/aiOrchestrator');

const MAX_MESSAGE_LENGTH = 2000;
const MAX_QUERY_LENGTH = 1000;

/**
 * POST /api/ai/test
 * Connectivity test: Express → OpenAI → JSON reply.
 * No MongoDB, no RAG, no streaming.
 */
const testOpenAI = async (req, res) => {
  try {
    const { message } = req.body || {};

    if (message === undefined || message === null) {
      return res.status(400).json({
        success: false,
        error: { message: 'Message is required.' },
      });
    }

    if (typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: { message: 'Message must be a string.' },
      });
    }

    const trimmed = message.trim();

    if (!trimmed) {
      return res.status(400).json({
        success: false,
        error: { message: 'Message cannot be empty.' },
      });
    }

    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          message: `Message must be at most ${MAX_MESSAGE_LENGTH} characters.`,
        },
      });
    }

    const reply = await generateText(trimmed);

    return res.status(200).json({
      success: true,
      data: { reply: typeof reply === 'string' ? reply : reply.text },
    });
  } catch (error) {
    if (error instanceof OpenAIServiceError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { message: error.message },
      });
    }

    console.error('[AI] Unexpected error', {
      category: 'unexpected_error',
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      error: { message: 'AI service is temporarily unavailable.' },
    });
  }
};

/**
 * POST /api/ai/blog-search
 * Retrieval-only test: query → embedding → Atlas Vector Search → chunks.
 * Does NOT call gpt-5-nano. Does NOT generate RAG answers.
 */
const searchBlogChunksHandler = async (req, res) => {
  try {
    const { query } = req.body || {};

    if (query === undefined || query === null) {
      return res.status(400).json({
        success: false,
        error: { message: 'Query is required.' },
      });
    }

    if (typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        error: { message: 'Query must be a string.' },
      });
    }

    const trimmed = query.trim();
    if (!trimmed) {
      return res.status(400).json({
        success: false,
        error: { message: 'Query cannot be empty.' },
      });
    }

    if (trimmed.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          message: `Query must be at most ${MAX_QUERY_LENGTH} characters.`,
        },
      });
    }

    const result = await searchBlogChunks(trimmed);

    return res.status(200).json({
      success: true,
      data: {
        query: result.query,
        results: result.results,
        timings: result.timings,
      },
    });
  } catch (error) {
    if (error instanceof BlogVectorSearchError || error instanceof OpenAIServiceError) {
      return res.status(error.statusCode || 502).json({
        success: false,
        error: { message: error.message },
      });
    }

    console.error('[AI] Blog search unexpected error', {
      category: 'unexpected_error',
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      error: { message: 'Blog vector search is temporarily unavailable.' },
    });
  }
};

/**
 * POST /api/ai/blog-chat
 * Blog-only RAG: message → retrieval → gpt-5-nano grounded answer.
 * No property DB, no confidential data, no streaming, no memory.
 */
const blogChatHandler = async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await generateBlogAnswer(message);

    return res.status(200).json({
      success: true,
      data: {
        answer: result.answer,
        sources: result.sources,
      },
    });
  } catch (error) {
    if (error instanceof BlogVectorSearchError || error instanceof OpenAIServiceError) {
      return res.status(error.statusCode || 502).json({
        success: false,
        error: { message: error.message },
      });
    }

    console.error('[AI] Blog chat unexpected error', {
      category: 'unexpected_error',
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      error: { message: 'Blog AI chat is temporarily unavailable.' },
    });
  }
};

/**
 * POST /api/ai/chat
 * Phase 1 orchestrator: validate → confidential guard → company.md → gpt-5-nano
 * Does NOT call Blog RAG as a generic fallback.
 */
const chatHandler = async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await handleChat(message);

    return res.status(200).json({
      success: true,
      data: {
        reply: result.reply,
      },
    });
  } catch (error) {
    if (error instanceof OpenAIServiceError) {
      return res.status(error.statusCode || 502).json({
        success: false,
        error: { message: error.message },
      });
    }

    if (error?.statusCode === 400 || error?.category === 'invalid_request') {
      return res.status(400).json({
        success: false,
        error: { message: error.message || 'Invalid request.' },
      });
    }

    console.error('[AI] Chat unexpected error', {
      category: 'unexpected_error',
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      error: { message: 'AI chat is temporarily unavailable.' },
    });
  }
};

module.exports = {
  testOpenAI,
  searchBlogChunksHandler,
  blogChatHandler,
  chatHandler,
};
