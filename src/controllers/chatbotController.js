const crypto = require('crypto');
const { reindex, retrieve, chat, getHistory } = require('../lib/chatbot');

const MAX_MESSAGE_LENGTH = 1000;
const isValidSessionId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);

// 1. Rebuild chatbot embeddings - POST /api/chatbot/reindex
const reindexChatbot = async (req, res) => {
  try {
    const result = await reindex();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[Chatbot] Reindex failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Reindex failed',
    });
  }
};

// 2. Debug retrieval - POST /api/chatbot/search
const searchChatbot = async (req, res) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ success: false, message: 'Please provide query' });
    }

    const matches = await retrieve(query, 4);
    return res.status(200).json({ success: true, count: matches.length, data: matches });
  } catch (error) {
    console.error('[Chatbot] Search failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Search failed',
    });
  }
};

// 3. Chat - POST /api/chatbot
const sendChatMessage = async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ success: false, message: 'Please provide message' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Message must be ${MAX_MESSAGE_LENGTH} characters or less`,
      });
    }

    const { sessionId: rawSessionId } = req.body;
    if (rawSessionId !== undefined && !isValidSessionId(rawSessionId)) {
      return res.status(400).json({ success: false, message: 'Invalid sessionId' });
    }
    const sessionId = rawSessionId || crypto.randomUUID();

    // Optional UI action, e.g. { type: 'book_viewing', propertyRefNo, location } from a "Book a Viewing" button.
    const rawAction = req.body?.action;
    const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');
    const action =
      rawAction?.type === 'book_viewing'
        ? { type: 'book_viewing', propertyRefNo: text(rawAction.propertyRefNo), location: text(rawAction.location) }
        : null;

    const { reply, properties, propertyResult, recommendations, uiActions } = await chat({ sessionId, message, action });
    return res.status(200).json({
      success: true,
      sessionId,
      reply,
      properties,
      ...(propertyResult && { propertyResult }),
      ...(recommendations?.length && { recommendations }),
      ...(uiActions?.length && { uiActions }),
    });
  } catch (error) {
    console.error('[Chatbot] Chat request failed:', error.message);
    return res.status(500).json({ success: false, message: 'Chat is unavailable right now' });
  }
};

// 4. Chat history - GET /api/chatbot/:sessionId
const getChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ success: false, message: 'Invalid sessionId' });
    }

    const messages = await getHistory(sessionId);
    return res.status(200).json({ success: true, sessionId, count: messages.length, data: messages });
  } catch (error) {
    console.error('[Chatbot] History request failed:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  reindexChatbot,
  searchChatbot,
  sendChatMessage,
  getChatHistory,
};
