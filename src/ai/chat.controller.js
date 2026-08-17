const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt } = require('./chat.prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./chat.tools');

const HISTORY_TURNS = 10;
const MAX_STORED_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 4;
const TOOL_MAX_TOKENS = 1024;
const REPLY_MAX_TOKENS = 600;

const PROPERTY_CTAS = ['View listing', 'Book a viewing', 'See similar properties'];
const CONTENT_CTAS = ['Talk to an agent', 'Explore related properties'];
const BOTH_EMPTY_REPLIES = [
  'Let me explore a few more suitable options around your preferred area. Do you have a preferred budget range?',
  'Let me narrow this down for you. What budget range would you like to stay within?',
  'Let me help you find the closest suitable options. Would you prefer to adjust the budget or consider nearby areas?',
];

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
}

function emptySearchFilters() {
  return {
    location: null,
    bedrooms: null,
    budgetMin: null,
    budgetMax: null,
    type: null,
    purpose: null,
  };
}

function copySearchFilters(filters = {}) {
  return {
    location: filters.location || null,
    bedrooms: filters.bedrooms ?? null,
    budgetMin: filters.budgetMin ?? null,
    budgetMax: filters.budgetMax ?? null,
    type: filters.type || null,
    purpose: filters.purpose || null,
  };
}

function toStoredPropertyCards(cards = []) {
  return (cards || []).slice(0, 10).map((card) => ({
    id: card.id || '',
    title: card.title || '',
    price: card.price ?? '',
    beds: card.beds ?? '',
    baths: card.baths ?? '',
    area: card.area || '',
    imageUrl: card.imageUrl || '',
    listingUrl: card.listingUrl || '',
  }));
}

function mergeProfile(current, patch) {
  const next = {
    preferredAreas: [...(current.preferredAreas || [])],
    budget: {
      min: current.budget?.min ?? null,
      max: current.budget?.max ?? null,
    },
    bedrooms: current.bedrooms ?? null,
    purpose: current.purpose || null,
    lastPropertyCards: toStoredPropertyCards(current.lastPropertyCards),
    lastSearchFilters: copySearchFilters(current.lastSearchFilters || emptySearchFilters()),
    leadCaptured: current.leadCaptured || false,
  };

  if (Array.isArray(patch.preferredAreas)) {
    for (const area of patch.preferredAreas) {
      const value = String(area || '').trim();
      if (!value) continue;
      const exists = next.preferredAreas.some((a) => a.toLowerCase() === value.toLowerCase());
      if (!exists) next.preferredAreas.push(value);
    }
    next.preferredAreas = next.preferredAreas.slice(-10);
  }
  if (patch.budget) {
    if (patch.budget.min !== undefined && patch.budget.min !== null) next.budget.min = patch.budget.min;
    if (patch.budget.max !== undefined && patch.budget.max !== null) next.budget.max = patch.budget.max;
  }
  if (patch.bedrooms !== undefined && patch.bedrooms !== null) next.bedrooms = patch.bedrooms;
  if (patch.purpose) next.purpose = patch.purpose;
  if (Array.isArray(patch.lastPropertyCards)) {
    next.lastPropertyCards = toStoredPropertyCards(patch.lastPropertyCards);
  }
  if (patch.lastSearchFilters) {
    next.lastSearchFilters = copySearchFilters(patch.lastSearchFilters);
  }
  if (patch.leadCaptured) next.leadCaptured = true;

  return next;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function pickSuggestedCta({ propertyCards, sources, leadCaptured, turnIndex }) {
  if (leadCaptured) return CONTENT_CTAS[0];
  if (propertyCards.length) return PROPERTY_CTAS[turnIndex % PROPERTY_CTAS.length];
  if (sources.length) return CONTENT_CTAS[turnIndex % CONTENT_CTAS.length];
  return null;
}

async function loadConversation(sessionId) {
  let conversation = await Conversation.findOne({ sessionId });
  if (!conversation) {
    conversation = await Conversation.create({
      sessionId,
      messages: [],
      userProfile: {
        preferredAreas: [],
        budget: { min: null, max: null },
        bedrooms: null,
        purpose: null,
        lastPropertyCards: [],
        lastSearchFilters: emptySearchFilters(),
        leadCaptured: false,
      },
    });
  }
  return conversation;
}

function toOpenAIHistory(messages) {
  const recent = messages.slice(-HISTORY_TURNS * 2);
  return recent.map((m) => ({ role: m.role, content: m.content }));
}

function pickBothEmptyReply(turnIndex) {
  return BOTH_EMPTY_REPLIES[turnIndex % BOTH_EMPTY_REPLIES.length];
}

async function runModelLoop({ sessionId, userProfile, history, userMessage, turnIndex }) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-5-nano';
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'minimal';

  const messages = [
    { role: 'system', content: getSystemPrompt(userProfile) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const propertyCards = [];
  const sources = [];
  let leadCaptured = false;
  let profile = userProfile;
  let previousPropertySearchEmpty = false;
  let lastSearchBothEmpty = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const hasToolResults = messages.some((m) => m.role === 'tool');
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      max_completion_tokens: hasToolResults ? REPLY_MAX_TOKENS : TOOL_MAX_TOKENS,
      reasoning_effort: reasoningEffort,
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) {
      throw new Error('Empty response from OpenAI');
    }

    console.log(
      'finish_reason:',
      completion.choices?.[0]?.finish_reason,
      '| usage:',
      completion.usage,
      '| content_length:',
      (msg.content || '').length
    );

    messages.push(msg);

    const toolCalls = msg.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      return {
        reply: (msg.content || '').trim(),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
      };
    }

    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (err) {
        args = {};
      }

      let result;
      try {
        result = await executeTool(call.function?.name, args, {
          sessionId,
          previousPropertySearchEmpty,
          lastSearchFilters: profile.lastSearchFilters,
          leadAlreadyCaptured: !!profile.leadCaptured,
        });
      } catch (err) {
        result = {
          propertyCards: [],
          sources: [],
          leadCaptured: false,
          profilePatch: {},
          modelPayload: { error: err.message || 'Tool failed' },
        };
      }

      console.log(
        'TOOL CALL:',
        call.function?.name,
        'args:',
        call.function?.arguments,
        '| propertyCards returned:',
        result.propertyCards?.length ?? 0
      );

      if (result.propertyCards?.length) propertyCards.push(...result.propertyCards);
      if (result.sources?.length) sources.push(...result.sources);
      if (result.leadCaptured) leadCaptured = true;
      if (result.profilePatch) profile = mergeProfile(profile, result.profilePatch);

      if (call.function?.name === 'search_properties') {
        const returnedCards = result.propertyCards?.length ?? 0;
        if (returnedCards === 0) previousPropertySearchEmpty = true;
        lastSearchBothEmpty = !!result.modelPayload?.bothEmpty;
        if (returnedCards > 0) {
          lastSearchBothEmpty = false;
          profile = mergeProfile(profile, {
            lastPropertyCards: result.propertyCards,
            lastSearchFilters: result.effectiveFilters,
          });
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.modelPayload),
      });
    }

    if (lastSearchBothEmpty && propertyCards.length === 0) {
      return {
        reply: pickBothEmptyReply(turnIndex),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
      };
    }
  }

  return {
    reply: 'Sorry, I could not finish that just now. Please try again.',
    propertyCards: uniqueBy(propertyCards, (c) => c.id),
    sources: uniqueBy(sources, (s) => s.url || s.title),
    leadCaptured,
    profile,
  };
}

const chat = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const conversation = await loadConversation(sessionId);
    const history = toOpenAIHistory(conversation.messages || []);

    const result = await runModelLoop({
      sessionId,
      userProfile: conversation.userProfile || {},
      history,
      userMessage: message,
      turnIndex: conversation.messages.length,
    });

    const reply = result.reply || 'How can I help you with Dubai property today?';
    const suggestedCta = pickSuggestedCta({
      propertyCards: result.propertyCards,
      sources: result.sources,
      leadCaptured: result.leadCaptured || result.profile.leadCaptured,
      turnIndex: conversation.messages.length,
    });

    conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
    conversation.messages.push({ role: 'assistant', content: reply, createdAt: new Date() });
    conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
    conversation.userProfile = result.profile;
    await conversation.save();

    return res.status(200).json({
      reply,
      propertyCards: result.propertyCards,
      sources: result.sources,
      suggestedCta,
    });
  } catch (error) {
    console.error('POST /api/chat error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process chat',
    });
  }
};

module.exports = { chat };
