/**
 * Lightweight SELL_PROPERTY multi-turn flow with conversion CTAs.
 * Does NOT write to ai_knowledge or invent CRM — ends with contact + WhatsApp CTAs.
 */

const {
  sellPropertyTypeQuickActions,
  sellDoneQuickActions,
} = require('./quickActions');
const { buildWhatsAppAction } = require('./whatsappAction');

const SELL_TYPE_MAP = {
  apartment: 'Apartment',
  villa: 'Villa',
  townhouse: 'Townhouse',
  commercial: 'Commercial',
};

/**
 * @param {string} message
 * @returns {string|null}
 */
const parseSellPropertyType = (message) => {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return null;
  if (SELL_TYPE_MAP[text]) return SELL_TYPE_MAP[text];
  for (const [key, value] of Object.entries(SELL_TYPE_MAP)) {
    if (new RegExp(`\\b${key}s?\\b`, 'i').test(text)) return value;
  }
  return null;
};

/**
 * @param {string} message
 * @param {object|null} context
 */
const resolveSellPropertyTurn = (message, context = null) => {
  const draft = {
    ...(context?.sellDraft && typeof context.sellDraft === 'object'
      ? context.sellDraft
      : {}),
  };

  const pending = context?.pendingClarification || 'sellPropertyType';
  const text = String(message || '').trim();
  const whatsapp_action = buildWhatsAppAction(
    'Hi Rocky, I would like help selling my property.'
  );

  // Seed type from the original sell message when possible
  if (!draft.propertyType) {
    const seeded = parseSellPropertyType(text);
    if (seeded) draft.propertyType = seeded;
  }

  if (pending === 'sellPropertyType' || !draft.propertyType) {
    if (!draft.propertyType) {
      const quick_actions = sellPropertyTypeQuickActions();
      return {
        reply: `I can help with that. ${quick_actions.question}`,
        quick_actions,
        context: {
          flow: 'sell_property',
          intent: 'SELL_PROPERTY',
          pendingClarification: 'sellPropertyType',
          sellDraft: draft,
          conversionIntent: 'medium',
        },
        openaiCalls: 0,
      };
    }
  }

  if (pending === 'sellPropertyType' && draft.propertyType) {
    return {
      reply: 'Where is the property located?',
      context: {
        flow: 'sell_property',
        intent: 'SELL_PROPERTY',
        pendingClarification: 'sellLocation',
        sellDraft: draft,
        conversionIntent: 'medium',
      },
      openaiCalls: 0,
    };
  }

  if (pending === 'sellLocation') {
    if (text) draft.location = text.slice(0, 200);
    return {
      reply: 'What is the building or property name?',
      context: {
        flow: 'sell_property',
        intent: 'SELL_PROPERTY',
        pendingClarification: 'sellBuilding',
        sellDraft: draft,
        conversionIntent: 'medium',
      },
      openaiCalls: 0,
    };
  }

  if (pending === 'sellBuilding') {
    if (text) draft.building = text.slice(0, 200);
    return {
      reply: 'What is your expected selling price?',
      context: {
        flow: 'sell_property',
        intent: 'SELL_PROPERTY',
        pendingClarification: 'sellPrice',
        sellDraft: draft,
        conversionIntent: 'medium',
      },
      openaiCalls: 0,
    };
  }

  if (pending === 'sellPrice') {
    if (text) draft.expectedPrice = text.slice(0, 200);
    return {
      reply: 'Thanks. Would you like our team to contact you?',
      quick_actions: sellDoneQuickActions(),
      contact_action: {
        type: 'contact_action',
        label: 'Talk to Rocky',
        service: 'sell',
      },
      ...(whatsapp_action ? { whatsapp_action } : {}),
      context: {
        flow: 'sell_property',
        intent: 'SELL_PROPERTY',
        pendingClarification: null,
        sellDraft: draft,
        conversionIntent: 'high',
      },
      openaiCalls: 0,
    };
  }

  const quick_actions = sellPropertyTypeQuickActions();
  return {
    reply: `I can help with that. ${quick_actions.question}`,
    quick_actions,
    context: {
      flow: 'sell_property',
      intent: 'SELL_PROPERTY',
      pendingClarification: 'sellPropertyType',
      sellDraft: draft,
      conversionIntent: 'medium',
    },
    openaiCalls: 0,
  };
};

module.exports = {
  resolveSellPropertyTurn,
  parseSellPropertyType,
};
