/**
 * Groq Provider
 * Responsibility: Call Groq chat completions and return plain text.
 * No streaming, no tool calling, no structured outputs in this phase.
 */

const Groq = require('groq-sdk');
const BaseProvider = require('./base.provider');
const { AIProviderError } = require('./errors');

/** Default model — override with GROQ_MODEL */
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
/** Default request timeout (ms) — override with GROQ_TIMEOUT_MS */
const DEFAULT_TIMEOUT_MS = 30000;

class GroqProvider extends BaseProvider {
  /**
   * @param {{ apiKey: string, model?: string, timeoutMs?: number }} config
   */
  constructor(config) {
    super(config);
    this.name = 'groq';

    if (!config?.apiKey) {
      throw new AIProviderError(
        'Groq is not configured. Please set GROQ_API_KEY.',
        { code: 'MISSING_API_KEY', statusCode: 500 }
      );
    }

    this.model = config.model || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
    this.timeoutMs =
      config.timeoutMs ||
      Number(process.env.GROQ_TIMEOUT_MS) ||
      DEFAULT_TIMEOUT_MS;

    this.client = new Groq({
      apiKey: config.apiKey,
      timeout: this.timeoutMs,
      maxRetries: 1,
    });
  }

  /**
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {Promise<string>}
   */
  async generateResponse(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AIProviderError('No messages were provided to the AI provider.', {
        code: 'INVALID_MESSAGES',
        statusCode: 400,
      });
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.7,
      });

      const content = completion?.choices?.[0]?.message?.content;

      if (!content || typeof content !== 'string') {
        throw new AIProviderError(
          'The AI provider returned an empty response. Please try again.',
          { code: 'EMPTY_RESPONSE', statusCode: 502 }
        );
      }

      return content.trim();
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      throw this.#mapGroqError(error);
    }
  }

  /**
   * Map Groq/SDK errors to friendly AIProviderError instances.
   * @param {Error & { status?: number, code?: string, error?: object }} error
   * @returns {AIProviderError}
   */
  #mapGroqError(error) {
    const status = error?.status || error?.statusCode;
    const rawMessage = error?.message || '';
    const lower = rawMessage.toLowerCase();

    if (
      error?.name === 'APIConnectionTimeoutError' ||
      error?.code === 'ETIMEDOUT' ||
      lower.includes('timeout') ||
      lower.includes('timed out')
    ) {
      return new AIProviderError(
        'The AI provider took too long to respond. Please try again.',
        { code: 'PROVIDER_TIMEOUT', statusCode: 504, cause: error }
      );
    }

    if (status === 401 || status === 403) {
      return new AIProviderError(
        'The AI provider rejected the request. Please check server configuration.',
        { code: 'PROVIDER_AUTH_ERROR', statusCode: 500, cause: error }
      );
    }

    if (status === 429) {
      return new AIProviderError(
        'The AI provider is busy right now. Please try again in a moment.',
        { code: 'PROVIDER_RATE_LIMIT', statusCode: 429, cause: error }
      );
    }

    if (status >= 500) {
      return new AIProviderError(
        'The AI provider is temporarily unavailable. Please try again later.',
        { code: 'PROVIDER_UNAVAILABLE', statusCode: 502, cause: error }
      );
    }

    return new AIProviderError(
      'Something went wrong while contacting the AI provider. Please try again.',
      { code: 'PROVIDER_API_ERROR', statusCode: 502, cause: error }
    );
  }
}

module.exports = GroqProvider;
