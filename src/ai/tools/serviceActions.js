/**
 * Controlled service / contact structured actions for SERVICE_INFO.
 * Prefer short conversion-oriented replies over long RAG dumps for known services.
 */

const { getServiceLink } = require('./knownLinks');
const {
  serviceMenuQuickActions,
  servicePmQuickActions,
} = require('./quickActions');
const { buildWhatsAppAction } = require('./whatsappAction');
const { FUNNEL_STAGES } = require('./funnelStages');

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
 * High-intent service need (wants help now).
 * @param {string} message
 */
const isHighIntentServiceRequest = (message) =>
  /\b(i\s+need|looking\s+for|want|interested\s+in|help\s+(me\s+)?with)\b/i.test(
    String(message || '')
  );

/**
 * Short deterministic service replies (no RAG required).
 * @param {string} key
 * @param {string} message
 */
const getShortServiceReply = (key, message) => {
  if (key === 'property-management') {
    if (isHighIntentServiceRequest(message)) {
      return 'Absolutely. Our Property Management team can help manage your property.';
    }
    return "Rocky's Property Management service helps owners manage and maintain their properties, including tenant and financial management.";
  }
  if (key === 'brokerage') {
    return "Rocky offers brokerage support for buying, selling, and renting properties across Dubai.";
  }
  if (key === 'listing-marketing') {
    return 'Rocky helps market and list properties to reach the right buyers and tenants.';
  }
  if (key === 'services') {
    return 'Rocky provides brokerage, property management, listing & marketing, and related real estate services.';
  }
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
    out.short_reply = getShortServiceReply('services', message);
    return out;
  }

  if (key === 'listing-marketing') {
    out.service_action = {
      type: 'service_action',
      label: 'Learn More',
      title: 'Property Listing & Marketing',
      url: '/services',
    };
    out.quick_actions = serviceMenuQuickActions();
    out.short_reply = getShortServiceReply(key, message);
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
  out.short_reply = getShortServiceReply(key, message);

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
    out.context = {
      flow: 'service',
      intent: 'SERVICE_INFO',
      funnelStage: FUNNEL_STAGES.HIGH_INTENT,
      conversionIntent: 'high',
    };
  } else if (key === 'brokerage') {
    out.quick_actions = serviceMenuQuickActions();
  }

  return out;
};

/**
 * Whether this service question can be answered without RAG.
 * @param {string} message
 */
const canAnswerServiceWithoutRag = (message) => {
  const key = detectServiceKey(message);
  return Boolean(key && getShortServiceReply(key, message));
};

/**
 * Immediate short service response (0 OpenAI).
 * @param {string} message
 */
const resolveShortServiceTurn = (message) => {
  const actions = resolveServiceActions(message);
  if (!actions.short_reply) return null;

  let reply = actions.short_reply;
  if (actions.contact_action && /property-management/i.test(actions.contact_action.service || '')) {
    reply = `${reply} Would you like to speak with our Property Management team?`;
  }

  return {
    reply,
    openaiCalls: 0,
    route: 'SERVICE_INFO',
    service_action: actions.service_action,
    contact_action: actions.contact_action,
    whatsapp_action: actions.whatsapp_action,
    quick_actions: actions.quick_actions,
    context: actions.context || {
      flow: 'service',
      intent: 'SERVICE_INFO',
      funnelStage: FUNNEL_STAGES.DISCOVERY,
      conversionIntent: 'medium',
    },
  };
};

module.exports = {
  detectServiceKey,
  resolveServiceActions,
  canAnswerServiceWithoutRag,
  resolveShortServiceTurn,
  getShortServiceReply,
  isHighIntentServiceRequest,
};
