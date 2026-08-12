const OpenAI = require('openai');

const DEFAULT_MODEL = 'gpt-5-nano';
const DEFAULT_REASONING_EFFORT = 'low';
const ALLOWED_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

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
 * GPT-5 reasoning effort for Chat Completions (`reasoning_effort`).
 * @returns {'minimal'|'low'|'medium'|'high'}
 */
const getReasoningEffort = () => {
  const raw = process.env.OPENAI_REASONING_EFFORT;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return DEFAULT_REASONING_EFFORT;
  }
  const value = raw.trim().toLowerCase();
  if (!ALLOWED_REASONING_EFFORTS.has(value)) {
    return DEFAULT_REASONING_EFFORT;
  }
  return value;
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
 * Send a chat completion to OpenAI and return the generated text.
 * Independent of Express / MongoDB.
 *
 * Uses Chat Completions API with GPT-5 `reasoning_effort`.
 *
 * @param {string} message - User message
 * @param {{ system?: string, model?: string, reasoningEffort?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ text: string, model: string, durationMs: number, reasoningEffort: string }>}
 */
const generateText = async (message, options = {}) => {
  const startedAt = Date.now();
  const model = options.model || getModel();
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  const reasoningEffort =
    typeof options.reasoningEffort === 'string' &&
    ALLOWED_REASONING_EFFORTS.has(options.reasoningEffort.trim().toLowerCase())
      ? options.reasoningEffort.trim().toLowerCase()
      : getReasoningEffort();

  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new OpenAIServiceError('Message is required.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  console.log('[OpenAI] request started', {
    model,
    reasoningEffort,
    hasSystem: Boolean(system),
  });

  try {
    const openai = getClient();

    const messages = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: message.trim() });

    const completion = await openai.chat.completions.create(
      {
        model,
        messages,
        reasoning_effort: reasoningEffort,
      },
      options.signal ? { signal: options.signal } : undefined
    );

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
      reasoningEffort,
      durationMs,
      category: 'success',
    });

    return {
      text: reply.trim(),
      model,
      durationMs,
      reasoningEffort,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || options.signal?.aborted) {
      throw new OpenAIServiceError('AI request was cancelled.', {
        statusCode: 499,
        category: 'aborted',
      });
    }

    const mapped = mapOpenAIError(error);
    const durationMs = Date.now() - startedAt;

    // Surface API/model compatibility issues clearly (do not silently drop reasoning_effort)
    const providerMessage =
      typeof error?.message === 'string' ? error.message.replace(/sk-[^\s]+/gi, '[redacted]') : '';
    const looksLikeReasoningCompat =
      /reasoning[_ ]?effort|unsupported_parameter|unrecognized_request|unknown_parameter/i.test(
        providerMessage
      );

    console.error('[OpenAI] request failed', {
      model,
      reasoningEffort,
      durationMs,
      category: looksLikeReasoningCompat
        ? 'reasoning_effort_compatibility'
        : mapped.category,
      statusCode: mapped.statusCode,
      providerHint: looksLikeReasoningCompat
        ? providerMessage.slice(0, 240)
        : undefined,
    });

    if (looksLikeReasoningCompat) {
      throw new OpenAIServiceError(
        'OpenAI rejected the configured reasoning_effort for this model/API.',
        {
          statusCode: 502,
          category: 'reasoning_effort_compatibility',
        }
      );
    }

    throw mapped;
  }
};

/**
 * Stream a chat completion. Yields only newly generated text deltas.
 *
 * @param {string} message
 * @param {{ system?: string, model?: string, reasoningEffort?: string, signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<{ text: string, model: string, reasoningEffort: string }, { text: string, model: string, durationMs: number, reasoningEffort: string }, void>}
 */
async function* generateTextStream(message, options = {}) {
  const startedAt = Date.now();
  const model = options.model || getModel();
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  const reasoningEffort =
    typeof options.reasoningEffort === 'string' &&
    ALLOWED_REASONING_EFFORTS.has(options.reasoningEffort.trim().toLowerCase())
      ? options.reasoningEffort.trim().toLowerCase()
      : getReasoningEffort();

  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new OpenAIServiceError('Message is required.', {
      statusCode: 400,
      category: 'invalid_request',
    });
  }

  console.log('[OpenAI] stream started', {
    model,
    reasoningEffort,
    hasSystem: Boolean(system),
  });

  try {
    const openai = getClient();
    const messages = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: message.trim() });

    const stream = await openai.chat.completions.create(
      {
        model,
        messages,
        reasoning_effort: reasoningEffort,
        stream: true,
      },
      options.signal ? { signal: options.signal } : undefined
    );

    let fullText = '';

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        break;
      }
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length) {
        fullText += delta;
        yield { text: delta, model, reasoningEffort };
      }
    }

    if (options.signal?.aborted) {
      throw new OpenAIServiceError('AI request was cancelled.', {
        statusCode: 499,
        category: 'aborted',
      });
    }

    const trimmed = fullText.trim();
    if (!trimmed) {
      throw new OpenAIServiceError('AI service returned an empty response.', {
        statusCode: 502,
        category: 'empty_response',
      });
    }

    const durationMs = Date.now() - startedAt;
    console.log('[OpenAI] stream completed', {
      model,
      reasoningEffort,
      durationMs,
      category: 'success',
    });

    return {
      text: trimmed,
      model,
      durationMs,
      reasoningEffort,
    };
  } catch (error) {
    if (error instanceof OpenAIServiceError) throw error;
    if (error?.name === 'AbortError' || options.signal?.aborted) {
      throw new OpenAIServiceError('AI request was cancelled.', {
        statusCode: 499,
        category: 'aborted',
      });
    }
    throw mapOpenAIError(error);
  }
}

module.exports = {
  generateText,
  generateTextStream,
  getClient,
  getReasoningEffort,
  mapOpenAIError,
  OpenAIServiceError,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
};
