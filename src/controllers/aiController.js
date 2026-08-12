const { generateText, OpenAIServiceError } = require('../services/openaiService');
const {
  searchBlogChunks,
  BlogVectorSearchError,
} = require('../services/blogVectorSearchService');
const { generateBlogAnswer } = require('../services/blogRagService');
const { generateKnowledgeAnswer } = require('../services/knowledgeRagService');
const {
  KnowledgeVectorSearchError,
} = require('../services/knowledgeVectorSearchService');
const {
  handleChat,
  handleChatStream,
  getStreamTimeoutMs,
} = require('../ai/orchestrator/aiOrchestrator');

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
 * POST /api/ai/knowledge-chat
 * Area Guide / FAQ Knowledge RAG (standalone — not wired into /api/ai/chat yet).
 * Does NOT modify Blog RAG. Does NOT use properties/leads/contacts.
 */
const knowledgeChatHandler = async (req, res) => {
  try {
    const { message } = req.body || {};
    const result = await generateKnowledgeAnswer(message);

    return res.status(200).json({
      success: true,
      data: {
        reply: result.answer,
        sources: result.sources,
      },
    });
  } catch (error) {
    if (
      error instanceof KnowledgeVectorSearchError ||
      error instanceof OpenAIServiceError
    ) {
      return res.status(error.statusCode || 502).json({
        success: false,
        error: { message: error.message },
      });
    }

    console.error('[AI] Knowledge chat unexpected error', {
      category: 'unexpected_error',
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      error: { message: 'Knowledge AI chat is temporarily unavailable.' },
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
        ...(Array.isArray(result.sources) && result.sources.length
          ? { sources: result.sources }
          : {}),
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

/**
 * Write one SSE event and flush when possible (Nginx / proxies).
 * @param {import('express').Response} res
 * @param {string} event
 * @param {object} data
 */
const writeSseEvent = (res, event, data) => {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
  return true;
};

/**
 * POST /api/ai/chat/stream
 * Same security + orchestration as /chat; streams answer tokens via SSE.
 */
const chatStreamHandler = async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const abortController = new AbortController();
  let timedOut = false;
  let clientGone = false;
  let terminalSent = false;
  const timeoutMs = getStreamTimeoutMs();

  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort('timeout');
  }, timeoutMs);

  const onClose = () => {
    // Client disconnected before we finished the SSE response
    if (!res.writableEnded) {
      clientGone = true;
      if (!abortController.signal.aborted) {
        abortController.abort('client_disconnect');
      }
    }
  };
  res.on('close', onClose);

  try {
    const { message } = req.body || {};

    for await (const evt of handleChatStream(message, {
      signal: abortController.signal,
    })) {
      if (clientGone || res.writableEnded) break;
      writeSseEvent(res, evt.event, evt.data);
      if (evt.event === 'done' || evt.event === 'error') {
        terminalSent = true;
        break;
      }
    }

    // Timeout may abort mid-stream before orchestrator yields an error event
    if (timedOut && !terminalSent && !clientGone && !res.writableEnded) {
      writeSseEvent(res, 'error', {
        success: false,
        message: 'The response took too long. Please try again.',
      });
    }
  } catch (error) {
    console.error('[AI] Chat stream unexpected error', {
      category: error?.category || 'unexpected_error',
      name: error?.name,
    });
    if (!clientGone && !res.writableEnded && !terminalSent) {
      writeSseEvent(res, 'error', {
        success: false,
        message: 'Unable to generate a response.',
      });
    }
  } finally {
    clearTimeout(timeoutId);
    res.off('close', onClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
};

module.exports = {
  testOpenAI,
  searchBlogChunksHandler,
  blogChatHandler,
  knowledgeChatHandler,
  chatHandler,
  chatStreamHandler,
};
