const { generateText, OpenAIServiceError } = require('../services/openaiService');

const MAX_MESSAGE_LENGTH = 2000;

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
      data: { reply },
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

module.exports = {
  testOpenAI,
};
