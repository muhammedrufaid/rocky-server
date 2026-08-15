const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt } = require('./chat.prompt');
const { TOOL_DEFINITIONS, executeTool } = require('./chat.tools');

const HISTORY_TURNS = 10;
const MAX_STORED_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 4;
const TOOL_MAX_TOKENS = 1024;
const REPLY_MAX_TOKENS = 180;

const PROPERTY_CTAS = ['View listing', 'Book a viewing', 'See similar properties'];
const CONTENT_CTAS = ['Talk to an agent', 'Explore related properties'];

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
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
  if (leadCaptured) return null;
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
      userProfile: { preferredAreas: [], budget: { min: null, max: null }, bedrooms: null, purpose: null },
    });
  }
  return conversation;
}

function toOpenAIHistory(messages) {
  const recent = messages.slice(-HISTORY_TURNS * 2);
  return recent.map((m) => ({ role: m.role, content: m.content }));
}

async function runModelLoop({ sessionId, userProfile, history, userMessage }) {
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
        result = await executeTool(call.function?.name, args, { sessionId });
      } catch (err) {
        result = {
          propertyCards: [],
          sources: [],
          leadCaptured: false,
          profilePatch: {},
          modelPayload: { error: err.message || 'Tool failed' },
        };
      }

      if (result.propertyCards?.length) propertyCards.push(...result.propertyCards);
      if (result.sources?.length) sources.push(...result.sources);
      if (result.leadCaptured) leadCaptured = true;
      if (result.profilePatch) profile = mergeProfile(profile, result.profilePatch);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.modelPayload),
      });
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
    });

    const reply = result.reply || 'How can I help you with Dubai property today?';
    const suggestedCta = pickSuggestedCta({
      propertyCards: result.propertyCards,
      sources: result.sources,
      leadCaptured: result.leadCaptured,
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
