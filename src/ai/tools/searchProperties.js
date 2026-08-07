/**
 * Tool: searchProperties
 * Responsibility: Future bridge to existing property search services.
 * Must NEVER query MongoDB directly — call propertyDbService (later).
 */

module.exports = {
  name: 'searchProperties',
  description:
    'Search properties using filters such as purpose, locality, bedrooms, and price range.',
  // TODO: Define OpenAI-compatible parameters schema
  // parameters: { type: 'object', properties: { ... }, required: [...] },

  /**
   * @param {object} args
   * @returns {Promise<object>}
   */
  async execute(args) {
    // TODO: Map args to existing propertyDbService filter shape
    // TODO: Call propertyDbService (do not duplicate search logic)
    // TODO: Return compact listing results for the model
    void args;
    throw new Error('searchProperties tool is not implemented yet');
  },
};
