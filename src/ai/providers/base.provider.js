/**
 * Base AI Provider contract.
 * Every provider (Groq, OpenAI, Gemini, Claude, …) must implement generateResponse.
 *
 * Future capabilities (embeddings, image, voice) can add methods on the same contract
 * without changing ChatService.
 */

class BaseProvider {
  /**
   * @param {object} config
   */
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  /**
   * Generate a plain-text assistant reply from a messages array.
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {Promise<string>}
   */
  async generateResponse(messages) {
    void messages;
    throw new Error(`${this.name} provider does not implement generateResponse`);
  }
}

module.exports = BaseProvider;
