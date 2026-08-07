/**
 * Conversation Service
 * Responsibility: Conversation and message persistence for multi-turn AI memory.
 */

const crypto = require('crypto');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

/** Max messages (user + assistant) sent to the LLM per turn. Older history stays in MongoDB. */
const CONVERSATION_WINDOW = 20;

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

class ConversationError extends Error {
  constructor(message, { code = 'CONVERSATION_ERROR', statusCode = 500, cause } = {}) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

/**
 * Validate sessionId shape. Rejects empty / non-string / overly long values.
 * @param {unknown} sessionId
 * @returns {string}
 */
const assertValidSessionId = (sessionId) => {
  if (sessionId == null || sessionId === '') {
    throw new ConversationError('sessionId is required', {
      code: 'INVALID_SESSION',
      statusCode: 400,
    });
  }

  if (typeof sessionId !== 'string') {
    throw new ConversationError('sessionId must be a string', {
      code: 'INVALID_SESSION',
      statusCode: 400,
    });
  }

  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new ConversationError('Invalid sessionId', {
      code: 'INVALID_SESSION',
      statusCode: 400,
    });
  }

  // Allow UUID and simple opaque tokens (alphanumeric, dash, underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new ConversationError('Invalid sessionId format', {
      code: 'INVALID_SESSION',
      statusCode: 400,
    });
  }

  return trimmed;
};

/**
 * Generate a new opaque session id when the client does not send one.
 * @returns {string}
 */
const generateSessionId = () => crypto.randomUUID();

/**
 * Create a new conversation for a session.
 * @param {{ sessionId: string }} params
 * @returns {Promise<object>}
 */
const createConversation = async ({ sessionId }) => {
  const validSessionId = assertValidSessionId(sessionId);
  const conversationId = crypto.randomUUID();

  try {
    const conversation = await Conversation.create({
      conversationId,
      sessionId: validSessionId,
      status: 'active',
    });

    console.log(
      `[Conversation] created | conversationId=${conversationId} | sessionId=${validSessionId}`
    );

    return conversation;
  } catch (error) {
    throw new ConversationError('Failed to create conversation', {
      code: 'MONGO_ERROR',
      statusCode: 500,
      cause: error,
    });
  }
};

/**
 * Load a conversation by conversationId, or the active one for a sessionId.
 * @param {{ conversationId?: string, sessionId?: string }} params
 * @returns {Promise<object|null>}
 */
const getConversation = async ({ conversationId, sessionId } = {}) => {
  try {
    if (conversationId) {
      if (typeof conversationId !== 'string' || !conversationId.trim()) {
        throw new ConversationError('Invalid conversationId', {
          code: 'CONVERSATION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const conversation = await Conversation.findOne({
        conversationId: conversationId.trim(),
      }).lean();

      if (!conversation) {
        throw new ConversationError('Conversation not found', {
          code: 'CONVERSATION_NOT_FOUND',
          statusCode: 404,
        });
      }

      if (sessionId) {
        const validSessionId = assertValidSessionId(sessionId);
        if (conversation.sessionId !== validSessionId) {
          throw new ConversationError('Conversation does not belong to this session', {
            code: 'INVALID_SESSION',
            statusCode: 403,
          });
        }
      }

      return conversation;
    }

    if (sessionId) {
      const validSessionId = assertValidSessionId(sessionId);
      return Conversation.findOne({
        sessionId: validSessionId,
        status: 'active',
      })
        .sort({ updatedAt: -1 })
        .lean();
    }

    throw new ConversationError('conversationId or sessionId is required', {
      code: 'INVALID_SESSION',
      statusCode: 400,
    });
  } catch (error) {
    if (error instanceof ConversationError) throw error;

    throw new ConversationError('Failed to load conversation', {
      code: 'MONGO_ERROR',
      statusCode: 500,
      cause: error,
    });
  }
};

/**
 * Load messages for a conversation, oldest first.
 * @param {{ conversationId: string, limit?: number }} params
 * @returns {Promise<Array<{ role: string, content: string, createdAt: Date }>>}
 */
const getMessages = async ({ conversationId, limit } = {}) => {
  if (!conversationId || typeof conversationId !== 'string') {
    throw new ConversationError('conversationId is required', {
      code: 'CONVERSATION_NOT_FOUND',
      statusCode: 404,
    });
  }

  try {
    // When limiting, fetch the latest N then restore chronological order
    if (limit && Number.isFinite(limit) && limit > 0) {
      const latest = await Message.find({ conversationId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('role content createdAt -_id')
        .lean();

      const messages = latest.reverse();
      console.log(
        `[Conversation] messages loaded | conversationId=${conversationId} | count=${messages.length}`
      );
      return messages;
    }

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: 1 })
      .select('role content createdAt -_id')
      .lean();

    console.log(
      `[Conversation] messages loaded | conversationId=${conversationId} | count=${messages.length}`
    );
    return messages;
  } catch (error) {
    if (error instanceof ConversationError) throw error;

    throw new ConversationError('Failed to load messages', {
      code: 'MONGO_ERROR',
      statusCode: 500,
      cause: error,
    });
  }
};

/**
 * Persist a message and touch conversation.updatedAt.
 * @param {{ conversationId: string, role: string, content: string }} params
 * @returns {Promise<object>}
 */
const saveMessage = async ({ conversationId, role, content }) => {
  if (!conversationId || typeof conversationId !== 'string') {
    throw new ConversationError('conversationId is required', {
      code: 'CONVERSATION_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!VALID_ROLES.has(role)) {
    throw new ConversationError(`Invalid message role: ${role}`, {
      code: 'INVALID_MESSAGE',
      statusCode: 400,
    });
  }

  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new ConversationError('Message content is required', {
      code: 'INVALID_MESSAGE',
      statusCode: 400,
    });
  }

  try {
    const conversation = await Conversation.findOne({ conversationId });
    if (!conversation) {
      throw new ConversationError('Conversation not found', {
        code: 'CONVERSATION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const message = await Message.create({
      conversationId,
      role,
      content: content.trim(),
    });

    conversation.updatedAt = new Date();
    await conversation.save();

    console.log(
      `[Conversation] message saved | conversationId=${conversationId} | role=${role}`
    );

    return message;
  } catch (error) {
    if (error instanceof ConversationError) throw error;

    throw new ConversationError('Failed to save message', {
      code: 'MONGO_ERROR',
      statusCode: 500,
      cause: error,
    });
  }
};

/**
 * Save a user message.
 * @param {{ conversationId: string, content: string }} params
 * @returns {Promise<object>}
 */
const saveUserMessage = async ({ conversationId, content }) => {
  return saveMessage({ conversationId, role: 'user', content });
};

/**
 * Save an assistant message.
 * @param {{ conversationId: string, content: string }} params
 * @returns {Promise<object>}
 */
const saveAssistantMessage = async ({ conversationId, content }) => {
  return saveMessage({ conversationId, role: 'assistant', content });
};

/**
 * Build the LLM messages array:
 *   [system] + latest CONVERSATION_WINDOW turns (previous history + current user message).
 *
 * Older messages remain stored in MongoDB but are not sent to the model.
 *
 * @param {{
 *   systemPrompt: string,
 *   previousMessages: Array<{ role: string, content: string }>,
 *   userMessage: string,
 *   limit?: number
 * }} params
 * @returns {Array<{ role: string, content: string }>}
 */
const appendConversationHistory = ({
  systemPrompt,
  previousMessages = [],
  userMessage,
  limit = CONVERSATION_WINDOW,
}) => {
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new ConversationError('systemPrompt is required', {
      code: 'INVALID_MESSAGE',
      statusCode: 400,
    });
  }

  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new ConversationError('userMessage is required', {
      code: 'INVALID_MESSAGE',
      statusCode: 400,
    });
  }

  const history = (previousMessages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  history.push({ role: 'user', content: userMessage.trim() });

  const windowed = history.slice(-limit);

  return [{ role: 'system', content: systemPrompt }, ...windowed];
};

/**
 * Find active conversation for session, or create one.
 * @param {{ sessionId: string }} params
 * @returns {Promise<{ conversation: object, created: boolean }>}
 */
const findOrCreateBySession = async ({ sessionId }) => {
  const validSessionId = assertValidSessionId(sessionId);
  const existing = await getConversation({ sessionId: validSessionId });

  if (existing) {
    return { conversation: existing, created: false };
  }

  const conversation = await createConversation({ sessionId: validSessionId });
  return { conversation, created: true };
};

/**
 * Soft-close a conversation (history remains in MongoDB).
 * Useful for starting a fresh thread under the same session later.
 * @param {{ conversationId: string, sessionId?: string }} params
 * @returns {Promise<object>}
 */
const closeConversation = async ({ conversationId, sessionId }) => {
  const conversation = await getConversation({ conversationId, sessionId });

  try {
    const updated = await Conversation.findOneAndUpdate(
      { conversationId: conversation.conversationId },
      { status: 'closed', updatedAt: new Date() },
      { new: true }
    ).lean();

    console.log(
      `[Conversation] closed | conversationId=${conversation.conversationId} | sessionId=${conversation.sessionId}`
    );

    return updated;
  } catch (error) {
    throw new ConversationError('Failed to close conversation', {
      code: 'MONGO_ERROR',
      statusCode: 500,
      cause: error,
    });
  }
};

module.exports = {
  CONVERSATION_WINDOW,
  ConversationError,
  generateSessionId,
  assertValidSessionId,
  createConversation,
  getConversation,
  getMessages,
  saveMessage,
  saveUserMessage,
  saveAssistantMessage,
  appendConversationHistory,
  findOrCreateBySession,
  closeConversation,
};
