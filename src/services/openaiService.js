const OpenAI = require('openai');

const DEFAULT_MODEL = 'gpt-5-nano';

/**
 * Typed error for AI/OpenAI failures so the controller can map to safe HTTP responses.
 */
class OpenAIServiceError extends Error {
  /**
   * @param {string} message - Safe message safe to return to clients
   * @param {{ statusCode?: number, category?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'OpenAIServiceError';
    this.statusCode = options.statusCode || 502;
    this.category = options.category || 'provider_error';
  }
}

let client = null;

const getApiKey = () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) {
    return null;
  }
  return key.trim();
};

const getModel = () => {
  const model = process.env.OPENAI_MODEL;
  if (!model || typeof model !== 'string' || !model.trim()) {
    return DEFAULT_MODEL;
  }
  return model.trim();
};

/**
 * Lazily initialize a single OpenAI client.
 * @returns {OpenAI}
 */
const getClient = () => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new OpenAIServiceError('AI service is not configured.', {
      statusCode: 503,
      category: 'missing_api_key',
    });
  }

  if (!client) {
    client = new OpenAI({ apiKey });
  }

  return client;
};

/**
 * Map OpenAI SDK / network errors to safe OpenAIServiceError instances.
 * Never includes API keys or raw provider secrets.
 * @param {unknown} error
 * @returns {OpenAIServiceError}
 */
const mapOpenAIError = (error) => {
  if (error instanceof OpenAIServiceError) {
    return error;
  }

  const status = error?.status || error?.statusCode || error?.response?.status;
  const code = error?.code || error?.error?.code;

  if (status === 401 || code === 'invalid_api_key') {
    return new OpenAIServiceError('AI service authentication failed.', {
      statusCode: 502,
      category: 'invalid_api_key',
    });
  }

  if (status === 429 || code === 'rate_limit_exceeded') {
    return new OpenAIServiceError('AI service rate limit exceeded. Please try again later.', {
      statusCode: 429,
      category: 'rate_limit',
    });
  }

  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    error?.name === 'APIConnectionError' ||
    error?.name === 'APIConnectionTimeoutError'
  ) {
    return new OpenAIServiceError('AI service is temporarily unavailable.', {
      statusCode: 502,
      category: 'network_error',
    });
  }

  return new OpenAIServiceError('AI service is temporarily unavailable.', {
    statusCode: 502,
    category: 'provider_error',
  });
};

/**
 * Send a user message to OpenAI and return the generated text.
 * Independent of Express / MongoDB.
 *
 * @param {string} message
 * @returns {Promise<string>}
 */
const generateText = async (message) => {
  const startedAt = Date.now();
  const model = getModel();

  console.log('[OpenAI] request started', { model });

  try {
    const openai = getClient();

    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: message }],
    });

    const reply = completion?.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== 'string' || !reply.trim()) {
      throw new OpenAIServiceError('AI service returned an empty response.', {
        statusCode: 502,
        category: 'empty_response',
      });
    }

    const durationMs = Date.now() - startedAt;
    console.log('[OpenAI] request completed', {
      model,
      durationMs,
      category: 'success',
    });

    return reply.trim();
  } catch (error) {
    const mapped = mapOpenAIError(error);
    const durationMs = Date.now() - startedAt;

    console.error('[OpenAI] request failed', {
      model,
      durationMs,
      category: mapped.category,
      statusCode: mapped.statusCode,
    });

    throw mapped;
  }
};

module.exports = {
  generateText,
  getClient,
  mapOpenAIError,
  OpenAIServiceError,
  DEFAULT_MODEL,
};
