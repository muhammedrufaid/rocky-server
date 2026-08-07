/**
 * Provider errors — typed so the HTTP layer can return friendly messages.
 * Never include API keys in error messages.
 */

class AIProviderError extends Error {
  /**
   * @param {string} message Friendly message safe to return to clients
   * @param {{ code?: string, statusCode?: number, cause?: Error }} [options]
   */
  constructor(message, { code = 'AI_PROVIDER_ERROR', statusCode = 500, cause } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

module.exports = {
  AIProviderError,
};
