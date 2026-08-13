/**
 * Conversion / high-intent response builders.
 */

const {
  highIntentQuickActions,
  afterResultsQuickActions,
  greetingQuickActions,
  knowledgeAreaQuickActions,
  knowledgeGeneralQuickActions,
} = require('./quickActions');
const { buildWhatsAppAction } = require('./whatsappAction');
const {
  detectHighIntent,
  detectConversionAction,
  resolvePropertyMention,
} = require('./highIntent');

/**
 * Handle Talk to Agent / WhatsApp / Schedule Viewing / property selection.
 * @param {string} message
 * @param {object|null} context
 * @returns {object|null}
 */
const resolveConversionTurn = (message, context = null) => {
  const action = detectConversionAction(message);
  const high = detectHighIntent(message);
  const selected =
    resolvePropertyMention(message, context) || context?.selectedProperty || null;

  const whatsappPrefill = selected?.title
    ? `Hi Rocky, I'm interested in "${selected.title}" and would like more information.`
    : "Hi, I'm interested in Rocky Real Estate and would like further information from you.";

  if (action === 'whatsapp') {
    const whatsapp_action = buildWhatsAppAction(whatsappPrefill);
    return {
      reply: whatsapp_action
        ? 'You can message our Rocky team on WhatsApp using the button below.'
        : 'Please use the contact options on our website to reach the Rocky team.',
      ...(whatsapp_action ? { whatsapp_action } : {}),
      contact_action: {
        type: 'contact_action',
        label: 'Talk to an Agent',
        service: 'agent',
      },
      quick_actions: highIntentQuickActions(),
      context: {
        ...(context || {}),
        flow: context?.flow || 'conversion',
        intent: 'CONVERSION',
        conversionIntent: 'very_high',
        selectedProperty: selected || context?.selectedProperty,
      },
      openaiCalls: 0,
      route: 'CONVERSION',
    };
  }

  if (action === 'agent' || action === 'viewing') {
    const whatsapp_action = buildWhatsAppAction(whatsappPrefill);
    const reply =
      action === 'viewing'
        ? selected
          ? `Great choice${selected.title ? ` — ${selected.title}` : ''}. I can help you schedule a viewing with our team.`
          : 'I can help you schedule a viewing with our team.'
        : 'I can connect you with a Rocky property consultant.';

    return {
      reply,
      contact_action: {
        type: 'contact_action',
        label: action === 'viewing' ? 'Schedule a Viewing' : 'Talk to an Agent',
        service: action === 'viewing' ? 'viewing' : 'agent',
      },
      ...(whatsapp_action ? { whatsapp_action } : {}),
      quick_actions: highIntentQuickActions(),
      context: {
        ...(context || {}),
        flow: context?.flow || 'conversion',
        intent: 'CONVERSION',
        conversionIntent: 'very_high',
        selectedProperty: selected || context?.selectedProperty,
      },
      openaiCalls: 0,
      route: 'CONVERSION',
    };
  }

  // High intent with property mention ("I like the second one", "can I view this?")
  if (high || selected) {
    const mentioned = selected || resolvePropertyMention(message, context);
    if (mentioned || high) {
      const whatsapp_action = buildWhatsAppAction(
        mentioned?.title
          ? `Hi Rocky, I'm interested in "${mentioned.title}" and would like more information.`
          : whatsappPrefill
      );
      return {
        reply: mentioned
          ? `Great — I've noted your interest${mentioned.title ? ` in ${mentioned.title}` : ''}. Found something you like? I can help you take the next step.`
          : 'Found something you like? I can help you take the next step.',
        quick_actions: afterResultsQuickActions(true),
        contact_action: {
          type: 'contact_action',
          label: 'Talk to an Agent',
          service: 'agent',
        },
        ...(whatsapp_action ? { whatsapp_action } : {}),
        context: {
          ...(context || {}),
          flow: context?.flow || 'property_search',
          intent: 'CONVERSION',
          conversionIntent: 'high',
          selectedProperty: mentioned || context?.selectedProperty,
          recentProperties: context?.recentProperties,
          listingType: context?.listingType,
          filters: context?.filters,
          search: context?.search,
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }
  }

  return null;
};

/**
 * Next actions after knowledge / area / blog answers.
 * @param {string} route
 */
const knowledgeNextActions = (route) => {
  if (route === 'AREA_GUIDE' || route === 'KNOWLEDGE_BOTH') {
    return {
      quick_actions: knowledgeAreaQuickActions(),
      contact_action: {
        type: 'contact_action',
        label: 'Talk to an Agent',
        service: 'agent',
      },
    };
  }
  const wa = buildWhatsAppAction();
  return {
    quick_actions: knowledgeGeneralQuickActions(),
    ...(wa ? { whatsapp_action: wa } : {}),
    contact_action: {
      type: 'contact_action',
      label: 'Talk to an Agent',
      service: 'agent',
    },
  };
};

/**
 * Starter greeting with conversion quick actions.
 */
const buildGreetingResult = () => ({
  reply: "Hi 👋 I'm Rocky AI. How can I help you today?",
  quick_actions: greetingQuickActions(),
  context: {
    flow: null,
    intent: 'GREETING',
    conversionIntent: 'low',
  },
  openaiCalls: 0,
  route: 'GREETING',
});

module.exports = {
  resolveConversionTurn,
  knowledgeNextActions,
  buildGreetingResult,
};
