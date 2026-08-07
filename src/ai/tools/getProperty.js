/**
 * Tool: getProperty
 * Responsibility: Future bridge to existing property-by-ref lookup.
 * Must NEVER query MongoDB directly — call propertyDbService (later).
 */

module.exports = {
  name: 'getProperty',
  description: 'Get full details for a single property by propertyRefNo.',
  // TODO: Define OpenAI-compatible parameters schema
  // parameters: { type: 'object', properties: { propertyRefNo: { type: 'string' } }, required: ['propertyRefNo'] },

  /**
   * @param {object} args
   * @returns {Promise<object>}
   */
  async execute(args) {
    // TODO: Validate propertyRefNo
    // TODO: Call propertyDbService.fetchPropertyByRefNo (or equivalent)
    // TODO: Return a compact property detail payload for the model
    void args;
    throw new Error('getProperty tool is not implemented yet');
  },
};
