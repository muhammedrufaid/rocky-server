/**
 * Lightweight SELL_PROPERTY multi-turn flow.
 * Does NOT write to ai_knowledge or invent CRM — ends with a contact CTA
 * pointing the client at the existing POST /api/sell enquiry form.
 */

const { sellPropertyTypeQuickActions } = require('./quickActions');

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
          pendingClarification: 'sellPropertyType',
          sellDraft: draft,
        },
        openaiCalls: 0,
      };
    }
  }

  if (pending === 'sellPropertyType' && draft.propertyType) {
    // Just selected type — ask location next
    return {
      reply: 'Where is the property located?',
      context: {
        flow: 'sell_property',
        pendingClarification: 'sellLocation',
        sellDraft: draft,
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
        pendingClarification: 'sellBuilding',
        sellDraft: draft,
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
        pendingClarification: 'sellPrice',
        sellDraft: draft,
      },
      openaiCalls: 0,
    };
  }

  if (pending === 'sellPrice') {
    if (text) draft.expectedPrice = text.slice(0, 200);
    return {
      reply:
        'Thanks — I have your property details. Would you like to speak with our sales team to list your property?',
      contact_action: {
        type: 'contact_action',
        label: 'Contact us to sell',
        service: 'sell',
      },
      context: {
        flow: 'sell_property',
        pendingClarification: null,
        sellDraft: draft,
      },
      openaiCalls: 0,
    };
  }

  // Fresh sell intent
  const quick_actions = sellPropertyTypeQuickActions();
  return {
    reply: `I can help with that. ${quick_actions.question}`,
    quick_actions,
    context: {
      flow: 'sell_property',
      pendingClarification: 'sellPropertyType',
      sellDraft: draft,
    },
    openaiCalls: 0,
  };
};

module.exports = {
  resolveSellPropertyTurn,
  parseSellPropertyType,
};
