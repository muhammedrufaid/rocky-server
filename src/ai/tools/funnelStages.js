/**
 * Standardized conversion funnel stages for Rocky AI.
 */

const FUNNEL_STAGES = Object.freeze({
  DISCOVERY: 'DISCOVERY',
  PROPERTY_REQUIREMENTS: 'PROPERTY_REQUIREMENTS',
  PROPERTY_SEARCH: 'PROPERTY_SEARCH',
  PROPERTY_RESULTS: 'PROPERTY_RESULTS',
  PROPERTY_SELECTED: 'PROPERTY_SELECTED',
  HIGH_INTENT: 'HIGH_INTENT',
  CONTACT: 'CONTACT',
  COMPLETED: 'COMPLETED',
});

const FUNNEL_STAGE_SET = new Set(Object.values(FUNNEL_STAGES));

/**
 * @param {unknown} value
 * @returns {string|null}
 */
const sanitizeFunnelStage = (value) =>
  FUNNEL_STAGE_SET.has(value) ? value : null;

module.exports = {
  FUNNEL_STAGES,
  sanitizeFunnelStage,
};
