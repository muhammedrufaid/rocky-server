/**
 * Controlled service / contact structured actions for SERVICE_INFO.
 * URLs come only from knownLinks — never invent paths.
 */

const { getServiceLink } = require('./knownLinks');

/**
 * Detect which known service the user is asking about.
 * @param {string} message
 * @returns {'property-management'|'brokerage'|'services'|null}
 */
const detectServiceKey = (message) => {
  const text = String(message || '').toLowerCase();
  if (/\bproperty\s+management\b/.test(text)) return 'property-management';
  if (/\bbrokerage\b/.test(text)) return 'brokerage';
  if (/\bservices?\b/.test(text)) return 'services';
  return null;
};

/**
 * Build service_action and optional contact_action for a service question.
 * Contact CTA is reserved for property-management (not every service Q).
 * @param {string} message
 * @returns {{ service_action?: object, contact_action?: object }}
 */
const resolveServiceActions = (message) => {
  const key = detectServiceKey(message);
  if (!key) return {};

  const link = getServiceLink(key);
  if (!link) return {};

  const out = {
    service_action: {
      type: 'service_action',
      label: 'Learn More',
      title: link.title,
      url: link.url,
    },
  };

  // Contact only for property-management specific questions — not general "services".
  if (key === 'property-management') {
    out.contact_action = {
      type: 'contact_action',
      label: 'Contact Property Management',
      service: 'property-management',
    };
  }

  return out;
};

module.exports = {
  detectServiceKey,
  resolveServiceActions,
};
