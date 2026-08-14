/**
 * Conversion / high-intent response builders.
 * Talk to an Agent is only offered after a property is selected (or explicit agent request).
 * listingAgentPhone is ONLY returned on property_agent contact after Talk to an Agent.
 */

const {
  highIntentQuickActions,
  propertySelectedQuickActions,
  greetingQuickActions,
  knowledgeAreaQuickActions,
  knowledgeGeneralQuickActions,
  knowledgeTopicQuickActions,
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
const { fetchListingAgentForSelectedProperty } = require('./propertyTools');
const { COMPANY_LINKS } = require('./knownLinks');

/**
 * Safe property payload for non-agent contact actions (no images, no agent phone).
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
 * Property + listing agent fields for Talk to an Agent only.
 * @param {object|null} selected
 * @param {{ listingAgent?: string|null, listingAgentPhone?: string|null }} agent
 */
const toPropertyAgentContactProperty = (selected, agent = {}) => {
  const base = toContactProperty(selected);
  if (!base) return null;
  const out = { ...base };
  if (agent.listingAgent) out.listingAgent = agent.listingAgent;
  if (agent.listingAgentPhone) out.listingAgentPhone = agent.listingAgentPhone;
  // Never include image / email / private fields
  return out;
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
 * Talk-to-agent contact_action with listing agent (phone only when present on the listing).
 * @param {object|null} selected
 * @param {{ listingAgent?: string|null, listingAgentPhone?: string|null }} agent
 */
const buildPropertyAgentContactAction = (selected, agent = {}) => {
  const property = toPropertyAgentContactProperty(selected, agent);
  const action = {
    type: 'contact_action',
    label: 'Talk to an Agent',
    service: 'property_agent',
  };
  if (property) action.property = property;
  return action;
};

/**
 * Handle Talk to Agent / WhatsApp / Schedule Viewing / property selection.
 * @param {string} message
 * @param {object|null} context
 * @returns {Promise<object|null>}
 */
const resolveConversionTurn = async (message, context = null) => {
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

  // "I'm Interested" → select property then conversion CTAs (no agent phone yet)
  if (action === 'interested' || (high && !action)) {
    const mentioned =
      safeSelected ||
      sanitizeSelectedProperty(resolvePropertyMention(message, context)) ||
      sanitizeSelectedProperty(
        Array.isArray(context?.recentProperties) ? context.recentProperties[0] : null
      );
    if (mentioned) {
      return {
        reply: 'Great choice. How would you like to proceed?',
        quick_actions: propertySelectedQuickActions(),
        context: {
          ...(context || {}),
          flow: context?.flow || 'property_search',
          intent: 'CONVERSION',
          funnelStage: FUNNEL_STAGES.PROPERTY_SELECTED,
          conversionIntent: 'high',
          selectedProperty: mentioned,
          recentProperties: context?.recentProperties,
          previousRecentProperties: context?.previousRecentProperties,
          listingType: context?.listingType,
          filters: context?.filters,
          search: context?.search,
          locations: context?.locations,
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }
  }

  // Official Rocky WhatsApp — never use listing agent phone
  if (action === 'whatsapp') {
    const whatsapp_action = buildWhatsAppAction(whatsappPrefill);
    return {
      reply: whatsapp_action
        ? 'Would you like to continue on WhatsApp?'
        : 'Please use the contact options on our website to reach the Rocky team.',
      ...(whatsapp_action ? { whatsapp_action } : {}),
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

  // Talk to an Agent — listing agent phone ONLY here, from DB for selected property
  if (action === 'agent') {
    const hasProperty = Boolean(safeSelected);

    if (!hasProperty) {
      return {
        reply: 'I can connect you with a Rocky property consultant.',
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
          funnelStage: FUNNEL_STAGES.CONTACT,
          conversionIntent: 'very_high',
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }

    const agent = await fetchListingAgentForSelectedProperty(safeSelected);
    const contact_action = buildPropertyAgentContactAction(safeSelected, agent);
    const reply = agent.listingAgentPhone
      ? 'Sure. I can connect you directly with the agent handling this property.'
      : 'I can connect you with our team about this property. An agent will follow up shortly.';

    return {
      reply,
      contact_action,
      // Do not also emit Schedule Viewing / WhatsApp as the selected action
      context: {
        ...(context || {}),
        flow: context?.flow || 'conversion',
        intent: 'CONVERSION',
        funnelStage: FUNNEL_STAGES.CONTACT,
        conversionIntent: 'very_high',
        selectedProperty: safeSelected,
        recentProperties: context?.recentProperties,
        previousRecentProperties: context?.previousRecentProperties,
        listingType: context?.listingType,
        filters: context?.filters,
        search: context?.search,
        locations: context?.locations,
      },
      openaiCalls: 0,
      route: 'CONVERSION',
    };
  }

  // Schedule a Viewing — separate flow; never expose listingAgentPhone
  if (action === 'viewing') {
    const hasProperty = Boolean(safeSelected);
    const reply = hasProperty
      ? 'Great choice. I can help you schedule a viewing.'
      : 'I can help you schedule a viewing. Please select a property first, or tell me which listing you mean.';

    return {
      reply,
      contact_action: hasProperty
        ? buildPropertyContactAction(safeSelected, 'Schedule a Viewing', 'viewing')
        : {
            type: 'contact_action',
            label: 'Schedule a Viewing',
            service: 'viewing',
          },
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

  // Property selection / high intent with a specific listing (no agent phone yet)
  if (high || selected) {
    const mentioned =
      safeSelected ||
      sanitizeSelectedProperty(resolvePropertyMention(message, context));
    if (mentioned) {
      return {
        reply: 'Great choice. How would you like to proceed?',
        quick_actions: propertySelectedQuickActions(),
        context: {
          ...(context || {}),
          flow: context?.flow || 'property_search',
          intent: 'CONVERSION',
          funnelStage: FUNNEL_STAGES.PROPERTY_SELECTED,
          conversionIntent: 'high',
          selectedProperty: mentioned,
          recentProperties: context?.recentProperties,
          previousRecentProperties: context?.previousRecentProperties,
          listingType: context?.listingType,
          filters: context?.filters,
          search: context?.search,
          locations: context?.locations,
        },
        openaiCalls: 0,
        route: 'CONVERSION',
      };
    }

    if (high && action) {
      return null;
    }
  }

  return null;
};

/**
 * Next actions after knowledge / area / blog / content-topic answers.
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

  if (route === 'CONTENT_TOPIC' || route === 'BLOG') {
    const whatsapp_action = buildWhatsAppAction(
      'Hi Rocky, I would like more information about a topic from your website.'
    );
    return {
      service_action: {
        type: 'service_action',
        label: 'Learn More',
        title: 'Rocky Blogs',
        url: COMPANY_LINKS.blogs,
      },
      contact_action: {
        type: 'contact_action',
        label: 'Contact Us',
        service: 'agent',
      },
      ...(whatsapp_action ? { whatsapp_action } : {}),
      quick_actions: knowledgeTopicQuickActions(),
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
  buildPropertyAgentContactAction,
  toContactProperty,
  toPropertyAgentContactProperty,
};
