const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt } = require('./chat.prompt');
const { TOOL_DEFINITIONS, executeTool, PURPOSE_OPTIONS, PURPOSE_SELECT, BEDROOM_OPTIONS, parsePurposeFromMessage, parseBedroomChoice, applyBedroomChoice, applyBudgetChoice, isBedroomsResolved, isAmbiguousListingQuery, isVagueConfirm, normalizePropertyType, parsePropertyTypeChange, parseBudgetFromMessage, parseEmptyResultChoice, emptyResultOptions, emptyResultsReply, nearbyAreaOptions, matchesNamedOption, foundListingsReply, purposeClarificationReply, bedroomsClarificationReply } = require('./chat.tools');

const HISTORY_TURNS = 10;
const MAX_STORED_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 4;
const TOOL_MAX_TOKENS = 1024;
const REPLY_MAX_TOKENS = 600;

const PROPERTY_CTAS = ['View listing', 'Book a viewing', 'See similar properties'];
const CONTENT_CTAS = ['Talk to an agent', 'Explore related properties'];

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
    bedroomsMin: null,
    bedroomsAny: false,
    bedroomsResolved: false,
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
    bedroomsMin: filters.bedroomsMin ?? null,
    bedroomsAny: !!filters.bedroomsAny,
    bedroomsResolved: !!filters.bedroomsResolved,
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
    slotFlow: {
      awaiting: current.slotFlow?.awaiting || null,
    },
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
  if (patch.slotFlow) {
    next.slotFlow = {
      awaiting: patch.slotFlow.awaiting || null,
    };
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
        slotFlow: { awaiting: null },
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

function emptyClarificationPayload() {
  return {
    propertyCards: [],
    sources: [],
    suggestedCta: null,
    viewAllMatching: null,
  };
}

function bedroomClarifyPayload(profile, purpose) {
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (purpose) last.purpose = purpose;
  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
      purpose: purpose || last.purpose || profile.purpose,
      lastSearchFilters: last,
      slotFlow: { awaiting: 'bedrooms' },
    }),
    reply: bedroomsClarificationReply(),
    options: BEDROOM_OPTIONS,
  };
}

function applyPropertyTypeChange(message, profile) {
  const newType = parsePropertyTypeChange(message);
  if (!newType) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  // Only treat it as a type change if we already have at least purpose or location in context
  if (!last.purpose && !last.location && !profile.purpose) return null;
  // Do not override if the type is already the same
  if (last.type && last.type.toLowerCase() === newType.toLowerCase()) return null;

  // Carry purpose from top-level profile into lastSearchFilters so trustedPurpose can read it
  const resolvedPurpose = last.purpose || profile.purpose || null;

  return {
    type: 'continue',
    profile: mergeProfile(profile, {
      lastSearchFilters: { ...last, type: newType, purpose: resolvedPurpose },
      slotFlow: { awaiting: null },
    }),
  };
}

function resolvePendingSlots(message, profile) {
  const awaiting = profile.slotFlow?.awaiting;

  // Property-type change takes priority over any pending clarification state
  const typeChange = applyPropertyTypeChange(message, profile);
  if (typeChange) return typeChange;

  if (!awaiting) return null;

  if (awaiting === 'purpose') {
    const purpose = parsePurposeFromMessage(message);
    if (!purpose) return null;

    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    last.purpose = purpose;
    if (!isBedroomsResolved(last)) {
      return bedroomClarifyPayload(
        mergeProfile(profile, { purpose, lastSearchFilters: last }),
        purpose
      );
    }

    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        purpose,
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
      }),
    };
  }

  if (awaiting === 'bedrooms') {
    const choice = parseBedroomChoice(message);
    if (!choice) {
      return {
        type: 'clarify',
        profile,
        reply: bedroomsClarificationReply(),
        options: BEDROOM_OPTIONS,
      };
    }

    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    applyBedroomChoice(last, choice);
    const patch = {
      lastSearchFilters: last,
      slotFlow: { awaiting: null },
    };
    if (choice.exact != null) patch.bedrooms = choice.exact;
    if (choice.min != null) patch.bedrooms = choice.min;

    return {
      type: 'continue',
      profile: mergeProfile(profile, patch),
    };
  }

  if (awaiting === 'emptyResults') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const emptyChoice = parseEmptyResultChoice(message);
    if (emptyChoice?.nearby) {
      const options = nearbyAreaOptions(last.location);
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          lastSearchFilters: last,
          slotFlow: { awaiting: 'nearbyArea' },
        }),
        reply: 'Which nearby area should I try?',
        options,
      };
    }
    if (emptyChoice?.budget) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          lastSearchFilters: last,
          slotFlow: { awaiting: 'budget' },
        }),
        reply: 'What is your maximum budget in AED?',
      };
    }
    if (emptyChoice?.bedrooms) {
      applyBedroomChoice(last, emptyChoice.bedrooms);
      const patch = { lastSearchFilters: last, slotFlow: { awaiting: null } };
      if (emptyChoice.bedrooms.exact != null) patch.bedrooms = emptyChoice.bedrooms.exact;
      if (emptyChoice.bedrooms.min != null) patch.bedrooms = emptyChoice.bedrooms.min;
      return { type: 'continue', profile: mergeProfile(profile, patch) };
    }

    const typedBeds = parseBedroomChoice(message);
    if (typedBeds && !isVagueConfirm(message)) {
      applyBedroomChoice(last, typedBeds);
      return {
        type: 'continue',
        profile: mergeProfile(profile, { lastSearchFilters: last, slotFlow: { awaiting: null } }),
      };
    }

    return {
      type: 'clarify',
      profile,
      reply: emptyResultsReply(last),
      options: emptyResultOptions(last),
    };
  }

  if (awaiting === 'nearbyArea') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const options = nearbyAreaOptions(last.location);
    const named = matchesNamedOption(message, options);
    if (!named || isVagueConfirm(message)) {
      return {
        type: 'clarify',
        profile,
        reply: 'Which nearby area should I try?',
        options,
      };
    }
    last.location = named;
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        preferredAreas: [named],
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
      }),
    };
  }

  if (awaiting === 'budget') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const budget = parseBudgetFromMessage(message, { requireBudgetContext: true });
    if (!budget) {
      return {
        type: 'clarify',
        profile,
        reply: 'What is your maximum budget in AED?',
      };
    }
    applyBudgetChoice(last, budget);
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
      }),
    };
  }

  return null;
}

function bedroomClarifyIfNeeded(message, profile) {
  if (parseBedroomChoice(message)) return null;
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  const purpose = parsePurposeFromMessage(message) || last.purpose || profile.purpose || null;
  if (!purpose) return null;
  if (isBedroomsResolved(last)) return null;
  if (!last.location && !last.type) return null;
  const listingLike =
    isAmbiguousListingQuery(message) ||
    !!parsePurposeFromMessage(message) ||
    profile.slotFlow?.awaiting === 'bedrooms';
  if (!listingLike) return null;
  last.purpose = purpose;
  return bedroomClarifyPayload(mergeProfile(profile, { purpose, lastSearchFilters: last }), purpose);
}

async function clarificationResponse(res, { reply, profile, conversation, message, options }) {
  conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
  conversation.messages.push({ role: 'assistant', content: reply, createdAt: new Date() });
  conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
  conversation.userProfile = profile;
  await conversation.save();

  const body = {
    reply,
    ...emptyClarificationPayload(),
  };
  if (options) {
    body.requiresClarification = true;
    body.options = options;
    body.select = PURPOSE_SELECT;
  }
  return res.status(200).json(body);
}

async function runForcedPropertySearch({ sessionId, profile, userMessage }) {
  const result = await executeTool(
    'search_properties',
    {},
    {
      sessionId,
      lastSearchFilters: profile.lastSearchFilters,
      leadAlreadyCaptured: !!profile.leadCaptured,
      slotFlow: profile.slotFlow,
      userMessage,
    }
  );

  let nextProfile = profile;
  if (result.profilePatch) nextProfile = mergeProfile(nextProfile, result.profilePatch);
  if (result.effectiveFilters) {
    nextProfile = mergeProfile(nextProfile, {
      lastSearchFilters: result.effectiveFilters,
      lastPropertyCards: result.propertyCards?.length ? result.propertyCards : nextProfile.lastPropertyCards,
    });
  }

  if (result.needsPurpose) {
    return {
      reply: result.clarificationReply || purposeClarificationReply(),
      profile: nextProfile,
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: result.options || PURPOSE_OPTIONS,
      select: PURPOSE_SELECT,
    };
  }

  if (result.needsBedrooms) {
    return {
      reply: result.clarificationReply || bedroomsClarificationReply(),
      profile: nextProfile,
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: BEDROOM_OPTIONS,
      select: PURPOSE_SELECT,
    };
  }

  if (result.needsEmptyResults || !(result.propertyCards || []).length) {
    const filters = result.effectiveFilters || nextProfile.lastSearchFilters || {};
    return {
      reply: result.clarificationReply || emptyResultsReply(filters),
      profile: mergeProfile(nextProfile, { slotFlow: { awaiting: 'emptyResults' } }),
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: result.options || emptyResultOptions(filters),
      select: PURPOSE_SELECT,
    };
  }

  return {
    reply: foundListingsReply(result.effectiveFilters || nextProfile.lastSearchFilters, result.modelPayload?.total),
    profile: mergeProfile(nextProfile, { slotFlow: { awaiting: null } }),
    propertyCards: result.propertyCards || [],
    sources: result.sources || [],
    suggestedCta: null,
    viewAllMatching: result.viewAllMatching || null,
  };
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
  let lastSearchNeedsPurpose = false;
  let lastSearchNeedsBedrooms = false;
  let lastSearchNeedsEmptyResults = false;
  let purposeClarifyReply = '';
  let bedroomsClarifyReply = '';
  let emptyClarifyReply = '';
  let emptyClarifyOptions = null;
  let viewAllMatching = null;
  let clarificationOptions = null;

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
        viewAllMatching,
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
          lastSearchFilters: profile.lastSearchFilters,
          leadAlreadyCaptured: !!profile.leadCaptured,
          slotFlow: profile.slotFlow,
          userMessage,
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
        if (result.needsPurpose || result.modelPayload?.needsPurpose) {
          lastSearchNeedsPurpose = true;
          purposeClarifyReply = result.clarificationReply || purposeClarificationReply();
          clarificationOptions = result.options || PURPOSE_OPTIONS;
          if (result.effectiveFilters) {
            const nextFilters = copySearchFilters(result.effectiveFilters);
            if (!nextFilters.purpose && profile.lastSearchFilters?.purpose) {
              nextFilters.purpose = profile.lastSearchFilters.purpose;
            }
            profile = mergeProfile(profile, {
              lastSearchFilters: nextFilters,
              slotFlow: { awaiting: 'purpose' },
            });
          }
        }
        if (result.needsBedrooms || result.modelPayload?.needsBedrooms) {
          lastSearchNeedsBedrooms = true;
          bedroomsClarifyReply = result.clarificationReply || bedroomsClarifyReply;
          if (result.effectiveFilters) {
            profile = mergeProfile(profile, {
              lastSearchFilters: result.effectiveFilters,
              slotFlow: { awaiting: 'bedrooms' },
            });
          }
        }
        if (result.needsEmptyResults || result.modelPayload?.needsEmptyResults) {
          lastSearchNeedsEmptyResults = true;
          emptyClarifyReply = result.clarificationReply || emptyResultsReply(result.effectiveFilters || {});
          emptyClarifyOptions = result.options || emptyResultOptions(result.effectiveFilters || {});
          if (result.effectiveFilters) {
            profile = mergeProfile(profile, {
              lastSearchFilters: result.effectiveFilters,
              slotFlow: { awaiting: 'emptyResults' },
            });
          }
        }
        if (returnedCards > 0) {
          lastSearchNeedsPurpose = false;
          lastSearchNeedsBedrooms = false;
          lastSearchNeedsEmptyResults = false;
          viewAllMatching = result.viewAllMatching || null;
          profile = mergeProfile(profile, {
            lastPropertyCards: result.propertyCards,
            lastSearchFilters: result.effectiveFilters,
            slotFlow: { awaiting: null },
          });
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.modelPayload),
      });
    }

    if (lastSearchNeedsPurpose && propertyCards.length === 0) {
      return {
        reply: purposeClarifyReply || purposeClarificationReply(),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching: null,
        requiresClarification: true,
        options: clarificationOptions || PURPOSE_OPTIONS,
        select: PURPOSE_SELECT,
      };
    }

    if (lastSearchNeedsBedrooms && propertyCards.length === 0) {
      return {
        reply: bedroomsClarifyReply || bedroomsClarificationReply(),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching: null,
        requiresClarification: true,
        options: BEDROOM_OPTIONS,
        select: PURPOSE_SELECT,
      };
    }

    if (lastSearchNeedsEmptyResults && propertyCards.length === 0) {
      return {
        reply: emptyClarifyReply || emptyResultsReply(profile.lastSearchFilters || {}),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching: null,
        requiresClarification: true,
        options: emptyClarifyOptions || emptyResultOptions(profile.lastSearchFilters || {}),
        select: PURPOSE_SELECT,
      };
    }
  }

  return {
    reply: 'Sorry, I could not finish that just now. Please try again.',
    propertyCards: uniqueBy(propertyCards, (c) => c.id),
    sources: uniqueBy(sources, (s) => s.url || s.title),
    leadCaptured,
    profile,
    viewAllMatching,
  };
}

const chat = async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const conversation = await loadConversation(sessionId);
    let profile = conversation.userProfile || {};
    const slotResult = resolvePendingSlots(message, profile);

    if (slotResult?.type === 'clarify') {
      return clarificationResponse(res, {
        reply: slotResult.reply,
        profile: slotResult.profile,
        conversation,
        message,
        options: slotResult.options,
      });
    }

    if (slotResult?.profile) {
      profile = slotResult.profile;
    }

    const bedroomGate = bedroomClarifyIfNeeded(message, profile);
    if (bedroomGate) {
      return clarificationResponse(res, {
        reply: bedroomGate.reply,
        profile: bedroomGate.profile,
        conversation,
        message,
        options: bedroomGate.options,
      });
    }

    const last = profile.lastSearchFilters || emptySearchFilters();
    const canSearchNow =
      slotResult?.type === 'continue' &&
      (parsePurposeFromMessage(message) || last.purpose || profile.purpose) &&
      isBedroomsResolved(last);

    if (canSearchNow) {
      const forced = await runForcedPropertySearch({ sessionId, profile, userMessage: message });
      conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
      conversation.messages.push({ role: 'assistant', content: forced.reply, createdAt: new Date() });
      conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
      conversation.userProfile = forced.profile;
      await conversation.save();

      const payload = {
        reply: forced.reply,
        propertyCards: forced.propertyCards || [],
        sources: forced.sources || [],
        suggestedCta: forced.options
          ? null
          : pickSuggestedCta({
              propertyCards: forced.propertyCards || [],
              sources: forced.sources || [],
              leadCaptured: !!forced.profile.leadCaptured,
              turnIndex: conversation.messages.length,
            }),
        viewAllMatching: forced.viewAllMatching || null,
      };
      if (forced.options) {
        payload.requiresClarification = true;
        payload.options = forced.options;
        payload.select = forced.select || PURPOSE_SELECT;
      }
      return res.status(200).json(payload);
    }

    const history = toOpenAIHistory(conversation.messages || []);

    const result = await runModelLoop({
      sessionId,
      userProfile: profile,
      history,
      userMessage: message,
      turnIndex: conversation.messages.length,
    });

    const reply = result.reply || 'How can I help you with Dubai property today?';
    const suggestedCta = result.options
      ? null
      : pickSuggestedCta({
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

    const payload = {
      reply,
      propertyCards: result.propertyCards,
      sources: result.sources,
      suggestedCta,
      viewAllMatching: result.viewAllMatching || null,
    };
    if (result.options) {
      payload.requiresClarification = true;
      payload.options = result.options;
      payload.select = result.select || PURPOSE_SELECT;
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error('POST /api/chat error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process chat',
    });
  }
};

module.exports = { chat };
