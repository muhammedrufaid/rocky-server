const { OpenAIServiceError } = require('../services/openaiService');
const { RagServiceError } = require('../ai/ragService');
const {
  handleChat,
  handleChatStream,
  getStreamTimeoutMs,
} = require('../ai/orchestrator/aiOrchestrator');

/**
 * POST /api/ai/chat
 * Confidential → intent → structured tools or unified ragService.
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

/**
 * Write one SSE event.
 * @param {import('express').Response} res
 * @param {string} event
 * @param {object} data
 */
const writeSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
};

/**
 * POST /api/ai/chat/stream
 * Same orchestration as /chat; SSE delivery of answer tokens.
 */
const chatStreamHandler = async (req, res) => {
  const { message } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const abortController = new AbortController();
  const timeoutMs = getStreamTimeoutMs();
  let timedOut = false;
  let finished = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  // Detect client disconnect via the response, not the request.
  // req 'close' can fire when the request body finishes — too early for SSE.
  const onResponseClose = () => {
    if (!finished) {
      abortController.abort();
    }
  };
  res.on('close', onResponseClose);

  try {
    for await (const evt of handleChatStream(message, {
      signal: abortController.signal,
    })) {
      if (res.writableEnded || abortController.signal.aborted) break;
      writeSse(res, evt.event, evt.data);
      if (typeof res.flush === 'function') {
        res.flush();
      }
      if (evt.event === 'error' || evt.event === 'done') break;
    }

    if (timedOut && !res.writableEnded) {
      writeSse(res, 'error', { message: 'AI response timed out.' });
    }
  } catch (error) {
    if (!res.writableEnded && !abortController.signal.aborted) {
      const safeMessage =
        error instanceof OpenAIServiceError || error instanceof RagServiceError
          ? error.message
          : 'AI chat is temporarily unavailable.';
      writeSse(res, 'error', { message: safeMessage });
    }
  } finally {
    finished = true;
    clearTimeout(timeoutId);
    res.off('close', onResponseClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
};

module.exports = {
  chatHandler,
  chatStreamHandler,
};
