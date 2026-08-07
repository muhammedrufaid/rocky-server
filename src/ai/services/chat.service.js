/**
 * Chat Service
 * Responsibility: Orchestrate a single chat turn with MongoDB conversation memory.
 *
 * Flow:
 *
 *   Receive request
 *        ↓
 *   Resolve / generate sessionId
 *        ↓
 *   Find conversation by sessionId (create if none)
 *        ↓
 *   Load previous messages
 *        ↓
 *   Save current user message
 *        ↓
 *   Build messages: System Prompt → History (windowed) → Current User Message
 *        ↓
 *   AIProviderService.generateResponse()
 *        ↓
 *   Save assistant response
 *        ↓
 *   Return { reply, sessionId }
 */

const promptService = require('./prompt.service');
const aiProviderService = require('./aiProvider.service');
const conversationService = require('./conversation.service');

/**
 * Handle an incoming chat message with multi-turn memory.
 *
 * @param {{ message: string, sessionId?: string|null }} payload
 * @returns {Promise<{ reply: string, sessionId: string, conversationId: string }>}
 */
const handleChat = async ({ message, sessionId = null }) => {
  const startedAt = Date.now();

  // Session strategy: reuse client sessionId or mint a new one
  let resolvedSessionId = sessionId;
  if (resolvedSessionId == null || resolvedSessionId === '') {
    resolvedSessionId = conversationService.generateSessionId();
  } else {
    resolvedSessionId = conversationService.assertValidSessionId(resolvedSessionId);
  }

  const { conversation, created } = await conversationService.findOrCreateBySession({
    sessionId: resolvedSessionId,
  });

  const conversationId = conversation.conversationId;

  console.log(
    `[Chat] turn started | conversationId=${conversationId} | sessionId=${resolvedSessionId} | created=${created}`
  );

  // Load history BEFORE saving the current user message so we don't double-count it
  const previousMessages = await conversationService.getMessages({ conversationId });

  await conversationService.saveUserMessage({
    conversationId,
    content: message,
  });

  const systemPrompt = promptService.buildFullPrompt();

  const messages = conversationService.appendConversationHistory({
    systemPrompt,
    previousMessages,
    userMessage: message,
    limit: conversationService.CONVERSATION_WINDOW,
  });

  console.log(
    `[Chat] LLM payload built | conversationId=${conversationId} | sessionId=${resolvedSessionId} | historyCount=${previousMessages.length} | llmMessages=${messages.length - 1}`
  );

  const reply = await aiProviderService.generateResponse(messages);

  await conversationService.saveAssistantMessage({
    conversationId,
    content: reply,
  });

  const durationMs = Date.now() - startedAt;
  console.log(
    `[Chat] turn completed | conversationId=${conversationId} | sessionId=${resolvedSessionId} | durationMs=${durationMs}`
  );

  return {
    reply,
    sessionId: resolvedSessionId,
    conversationId,
  };
};

module.exports = {
  handleChat,
};
