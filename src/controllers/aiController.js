const { OpenAIServiceError } = require('../services/openaiService');
const { RagServiceError } = require('../ai/ragService');
const { handleChat } = require('../ai/orchestrator/aiOrchestrator');

/**
 * POST /api/ai/chat
 * Confidential → intent → structured tools or unified ragService.
 * Non-streaming only (streaming is a later step).
 */
const chatHandler = async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await handleChat(message);

    return res.status(200).json({
      success: true,
      data: {
        reply: result.reply,
        ...(Array.isArray(result.sources) && result.sources.length
          ? { sources: result.sources }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof OpenAIServiceError || error instanceof RagServiceError) {
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
  chatHandler,
};
