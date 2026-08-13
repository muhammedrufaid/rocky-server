/**
 * Controlled service / contact structured actions for SERVICE_INFO.
 * URLs come only from knownLinks — never invent paths.
 */

const { getServiceLink } = require('./knownLinks');
const {
  serviceMenuQuickActions,
  servicePmQuickActions,
} = require('./quickActions');
const { buildWhatsAppAction } = require('./whatsappAction');

/**
 * Detect which known service the user is asking about.
 * @param {string} message
 * @returns {'property-management'|'brokerage'|'listing-marketing'|'services'|null}
 */
const detectServiceKey = (message) => {
  const text = String(message || '').toLowerCase();
  if (/\bproperty\s+management\b/.test(text)) return 'property-management';
  if (/\bbrokerage\b/.test(text)) return 'brokerage';
  if (/\b(property\s+listing|listing\s*(&|and)?\s*marketing|marketing)\b/.test(text)) {
    return 'listing-marketing';
  }
  if (/\bservices?\b/.test(text)) return 'services';
  return null;
};

/**
 * Build service_action, optional contact/whatsapp, and quick_actions for services.
 * @param {string} message
 * @returns {object}
 */
const resolveServiceActions = (message) => {
  const key = detectServiceKey(message);
  const out = {};

  if (!key || key === 'services') {
    out.service_action = {
      type: 'service_action',
      label: 'Learn More',
      title: 'Our Services',
      url: '/services',
    };
    out.quick_actions = serviceMenuQuickActions();
    return out;
  }

  if (key === 'listing-marketing') {
    // No dedicated public path beyond /services — use services hub
    out.service_action = {
      type: 'service_action',
      label: 'Learn More',
      title: 'Property Listing & Marketing',
      url: '/services',
    };
    out.quick_actions = serviceMenuQuickActions();
    return out;
  }

  const link = getServiceLink(key);
  if (!link) return out;

  out.service_action = {
    type: 'service_action',
    label: 'Learn More',
    title: link.title,
    url: link.url,
  };

  if (key === 'property-management') {
    out.contact_action = {
      type: 'contact_action',
      label: 'Contact Property Management',
      service: 'property-management',
    };
    const wa = buildWhatsAppAction(
      'Hi Rocky, I would like to speak with the Property Management team.'
    );
    if (wa) out.whatsapp_action = wa;
    out.quick_actions = servicePmQuickActions();
  } else if (key === 'brokerage') {
    out.quick_actions = serviceMenuQuickActions();
  }

  return out;
};

module.exports = {
  detectServiceKey,
  resolveServiceActions,
};
