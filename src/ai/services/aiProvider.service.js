/**
 * AIProviderService
 * Responsibility: Provider-independent facade for AI generation.
 *
 * ChatService must NEVER import Groq/OpenAI/Gemini/Claude SDKs directly.
 * It only calls AIProviderService.generateResponse(messages).
 *
 * Selection is driven by LLM_PROVIDER. Switching providers requires env change only
 * (once that provider adapter exists).
 */

const { createProviderFromEnv } = require('../providers');
const { AIProviderError } = require('../providers/errors');

class AIProviderService {
  constructor() {
    this.provider = null;
    this.providerName = null;
  }

  /**
   * Lazily initialize the active provider from env.
   * Safe to call multiple times; re-reads env on first successful init only.
   */
  #ensureProvider() {
    if (this.provider) return;

    const name = (process.env.LLM_PROVIDER || '').trim().toLowerCase() || null;
    this.providerName = name;
    this.provider = createProviderFromEnv();
  }

  /**
   * Generate a plain-text assistant reply.
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {Promise<string>}
   */
  async generateResponse(messages) {
    this.#ensureProvider();

    const startedAt = Date.now();
    console.log(
      `[AIProvider] request started | provider=${this.providerName || 'unknown'}`
    );

    try {
      const reply = await this.provider.generateResponse(messages);
      const durationMs = Date.now() - startedAt;

      console.log(
        `[AIProvider] request completed | provider=${this.providerName} | durationMs=${durationMs}`
      );

      return reply;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const code = error?.code || error?.name || 'UNKNOWN';

      console.error(
        `[AIProvider] request failed | provider=${this.providerName || 'unknown'} | durationMs=${durationMs} | code=${code} | message=${error.message}`
      );

      if (error instanceof AIProviderError) {
        throw error;
      }

      throw new AIProviderError(
        'Something went wrong while generating a response. Please try again.',
        { code: 'AI_PROVIDER_ERROR', statusCode: 500, cause: error }
      );
    }
  }

  /**
   * Active provider name (after init), for diagnostics.
   * @returns {string|null}
   */
  getProviderName() {
    return this.providerName;
  }
}

module.exports = new AIProviderService();
