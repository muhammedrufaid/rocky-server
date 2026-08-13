/**
 * Conversion / high-intent response builders.
 * Talk to an Agent is only offered after a property is selected (or explicit agent request).
 */

const {
  highIntentQuickActions,
  propertySelectedQuickActions,
  greetingQuickActions,
  knowledgeAreaQuickActions,
  knowledgeGeneralQuickActions,
  knowledgeInvestQuickActions,
} = require('./quickActions');
const { buildWhatsAppAction } = require('./whatsappAction');
const {
  detectHighIntent,
  detectConversionAction,
  resolvePropertyMention,
} = require('./highIntent');
const { sanitizeSelectedProperty } = require('./conversationContext');
const { FUNNEL_STAGES } = require('./funnelStages');

/**
 * Safe property payload for contact_action (no images, no agent/private fields).
 * @param {object|null} selected
 */
const toContactProperty = (selected) => {
  const safe = sanitizeSelectedProperty(selected);
  if (!safe) return null;
  return {
    title: safe.title,
    building: safe.building,
    locality: safe.locality,
    price: safe.price,
    listingType: safe.listingType,
    url: safe.url,
  };
};

/**
 * @param {object|null} selected
 * @param {string} label
 * @param {string} service
 */
const buildPropertyContactAction = (selected, label, service) => {
  const property = toContactProperty(selected);
  const action = {
    type: 'contact_action',
    label,
    service,
  };
  if (property) action.property = property;
  return action;
};

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
  const safeSelected = sanitizeSelectedProperty(selected);

  const whatsappPrefill = safeSelected?.title
    ? `Hi Rocky, I'm interested in "${safeSelected.title}"${
        safeSelected.locality ? ` in ${safeSelected.locality}` : ''
      } and would like more information.`
    : "Hi, I'm interested in Rocky Real Estate and would like further information from you.";

  // View Property — point at selected or first recent
  if (action === 'view_property') {
    const target =
      safeSelected ||
      sanitizeSelectedProperty(
        Array.isArray(context?.recentProperties) ? context.recentProperties[0] : null
      );
    if (target?.url) {
      return {
        reply: 'Here is the property page.',
        service_action: {
          type: 'service_action',
          label: 'View Property',
          title: target.title || 'View Property',
          url: target.url,
        },
        quick_actions: propertySelectedQuickActions(),
        context: {
          ...(context || {}),
          flow: 'property_search',
          intent: 'CONVERSION',
          funnelStage: FUNNEL_STAGES.PROPERTY_SELECTED,
          selectedProperty: target,
          conversionIntent: 'high',
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }
  }

  if (action === 'whatsapp') {
    const whatsapp_action = buildWhatsAppAction(whatsappPrefill);
    return {
      reply: whatsapp_action
        ? 'Would you like to continue on WhatsApp?'
        : 'Please use the contact options on our website to reach the Rocky team.',
      ...(whatsapp_action ? { whatsapp_action } : {}),
      ...(safeSelected
        ? {
            contact_action: buildPropertyContactAction(
              safeSelected,
              'Talk to an Agent',
              'property'
            ),
          }
        : {
            contact_action: {
              type: 'contact_action',
              label: 'Talk to an Agent',
              service: 'agent',
            },
          }),
      quick_actions: highIntentQuickActions(),
      context: {
        ...(context || {}),
        flow: context?.flow || 'conversion',
        intent: 'CONVERSION',
        funnelStage: FUNNEL_STAGES.CONTACT,
        conversionIntent: 'very_high',
        selectedProperty: safeSelected || context?.selectedProperty,
      },
      openaiCalls: 0,
      route: 'CONVERSION',
    };
  }

  if (action === 'agent' || action === 'viewing') {
    // Agent / viewing preferred when a property is selected.
    // Explicit agent request is still allowed without a property.
    const whatsapp_action = buildWhatsAppAction(whatsappPrefill);
    const hasProperty = Boolean(safeSelected);
    const reply =
      action === 'viewing'
        ? hasProperty
          ? 'Great choice. I can help you schedule a viewing.'
          : 'I can help you schedule a viewing. Please select a property first, or tell me which listing you mean.'
        : hasProperty
          ? 'Great choice. How would you like to continue?'
          : 'I can connect you with a Rocky property consultant.';

    return {
      reply,
      contact_action: hasProperty
        ? buildPropertyContactAction(
            safeSelected,
            action === 'viewing' ? 'Schedule a Viewing' : 'Talk to an Agent',
            action === 'viewing' ? 'viewing' : 'property'
          )
        : {
            type: 'contact_action',
            label: action === 'viewing' ? 'Schedule a Viewing' : 'Talk to an Agent',
            service: action === 'viewing' ? 'viewing' : 'agent',
          },
      ...(whatsapp_action ? { whatsapp_action } : {}),
      quick_actions: hasProperty
        ? propertySelectedQuickActions()
        : highIntentQuickActions(),
      context: {
        ...(context || {}),
        flow: context?.flow || 'conversion',
        intent: 'CONVERSION',
        funnelStage: hasProperty
          ? FUNNEL_STAGES.HIGH_INTENT
          : FUNNEL_STAGES.CONTACT,
        conversionIntent: 'very_high',
        selectedProperty: safeSelected || context?.selectedProperty,
      },
      openaiCalls: 0,
      route: 'CONVERSION',
    };
  }

  // Property selection / high intent with a specific listing
  if (high || selected) {
    const mentioned = safeSelected || sanitizeSelectedProperty(
      resolvePropertyMention(message, context)
    );
    if (mentioned) {
      const whatsapp_action = buildWhatsAppAction(
        `Hi Rocky, I'm interested in "${mentioned.title || 'a property'}" and would like more information.`
      );
      return {
        reply: 'Great choice. How would you like to continue?',
        quick_actions: propertySelectedQuickActions(),
        contact_action: buildPropertyContactAction(
          mentioned,
          'Talk to an Agent',
          'property'
        ),
        ...(whatsapp_action ? { whatsapp_action } : {}),
        context: {
          ...(context || {}),
          flow: context?.flow || 'property_search',
          intent: 'CONVERSION',
          funnelStage: FUNNEL_STAGES.PROPERTY_SELECTED,
          conversionIntent: 'high',
          selectedProperty: mentioned,
          recentProperties: context?.recentProperties,
          listingType: context?.listingType,
          filters: context?.filters,
          search: context?.search,
          locations: context?.locations,
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }

    // High intent without a selected property — do not invent an agent CTA for a listing
    if (high && action) {
      return null;
    }
  }

  return null;
};

/**
 * Next actions after knowledge / area / blog answers.
 * Avoid generic "Talk to an Agent" unless investment/high-intent.
 * @param {string} route
 * @param {string} [question]
 */
const knowledgeNextActions = (route, question = '') => {
  const text = String(question || '').toLowerCase();
  const invest = /\binvest|investment\b/.test(text);

  if (invest) {
    return {
      quick_actions: knowledgeInvestQuickActions(),
      contact_action: {
        type: 'contact_action',
        label: 'Talk to an Agent',
        service: 'agent',
      },
    };
  }

  if (route === 'AREA_GUIDE' || route === 'KNOWLEDGE_BOTH') {
    return {
      quick_actions: knowledgeAreaQuickActions(),
    };
  }

  return {
    quick_actions: knowledgeGeneralQuickActions(),
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
    funnelStage: FUNNEL_STAGES.DISCOVERY,
    conversionIntent: 'low',
  },
  openaiCalls: 0,
  route: 'GREETING',
});

module.exports = {
  resolveConversionTurn,
  knowledgeNextActions,
  buildGreetingResult,
  buildPropertyContactAction,
  toContactProperty,
};
