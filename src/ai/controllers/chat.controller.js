/**
 * Chat Controller
 * Responsibility: HTTP boundary for AI chat — validate request, call ChatService, return response.
 * No provider or prompt logic.
 */

const chatService = require('../services/chat.service');
const { AIProviderError } = require('../providers/errors');
const { ConversationError } = require('../services/conversation.service');

/**
 * POST /api/ai/chat
 * Body: { message: string, sessionId?: string }
 */
const chat = async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a non-empty message',
      });
    }

    if (sessionId != null && sessionId !== '') {
      if (typeof sessionId !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'sessionId must be a string',
        });
      }
    }

    const result = await chatService.handleChat({
      message: message.trim(),
      sessionId: sessionId || null,
    });

    return res.status(200).json({
      success: true,
      data: {
        reply: result.reply,
        sessionId: result.sessionId,
      },
    });
  } catch (error) {
    console.error('[AI Chat Controller]', error.code || error.name, error.message);

    if (error instanceof ConversationError) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
        code: error.code,
      });
    }

    if (error instanceof AIProviderError) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
      });
    }

    // Unexpected Mongo / runtime errors
    if (error?.name === 'MongoError' || error?.name === 'MongoServerError') {
      return res.status(500).json({
        success: false,
        message: 'Database error. Please try again.',
        code: 'MONGO_ERROR',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Chat request failed. Please try again.',
    });
  }
};

module.exports = {
  chat,
};
