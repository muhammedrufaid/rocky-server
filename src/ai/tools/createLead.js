/**
 * Tool: createLead
 * Responsibility: Future bridge to existing lead/contact create flows.
 * Must NEVER query MongoDB directly — call existing lead/contact services (later).
 */

module.exports = {
  name: 'createLead',
  description:
    'Capture a lead from the AI Concierge (name, email/phone, inquiry details).',
  // TODO: Define OpenAI-compatible parameters schema
  // parameters: { type: 'object', properties: { ... }, required: [...] },

  /**
   * @param {object} args
   * @returns {Promise<object>}
   */
  async execute(args) {
    // TODO: Validate required contact fields
    // TODO: Map to existing Contact / lead create path with subSource: AI Concierge
    // TODO: Do not reimplement Zapier — reuse existing side effects
    void args;
    throw new Error('createLead tool is not implemented yet');
  },
};
