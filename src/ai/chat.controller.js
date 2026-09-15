const { Conversation } = require('./chat.models');

const MAX_STORED_MESSAGES = 40;
const PLACEHOLDER_REPLY =
  'Thanks for your message. The assistant is being rebuilt — please check back soon.';

async function loadConversation(sessionId) {
  let conversation = await Conversation.findOne({ sessionId });
  if (!conversation) {
    conversation = await Conversation.create({ sessionId, messages: [] });
  }
  return conversation;
}

/**
 * POST /api/chat
 * body: { sessionId, message, intent? }
 */
const chat = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const conversation = await loadConversation(sessionId);

    conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
    conversation.messages.push({
      role: 'assistant',
      content: PLACEHOLDER_REPLY,
      createdAt: new Date(),
    });
    conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
    await conversation.save();

    return res.status(200).json({
      success: true,
      message: 'Chat response generated successfully',
      data: {
        sessionId,
        reply: PLACEHOLDER_REPLY,
        messages: conversation.messages,
      },
    });
  } catch (error) {
    console.error('POST /api/chat error:', error);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong. Please try again shortly.',
    });
  }
};

module.exports = { chat };
