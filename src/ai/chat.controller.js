const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt, getListingReplyPrompt } = require('./chat.prompt');
const {
  shouldUseSse,
  isResponseOpen,
  createSseSession,
  ChatAbortedError,
  throwIfAborted,
} = require('./chat.sse');
const {
  emptyViewingRequest,
  copyViewingRequest,
  applyViewingRequestFlow,
  isBookViewingAction,
  isListingSearchOverride,
  finalizeViewingCapture,
  normalizeSearchProfileAfterPatch,
  requiresBedroomsForSearch,
  buildViewingLeadIntent,
  logViewingDebug,
} = require('./chat.tools');
const { TOOL_DEFINITIONS, executeTool, PURPOSE_OPTIONS, PURPOSE_SELECT, BEDROOM_OPTIONS, SELL_OPTIONS, SELL_SERVICE_LOCATION_OPTIONS, PM_NEED_OPTIONS, CONVERSATION_INTENTS, emptySearchFilters, copySearchFilters, parseSellIntent, isSellCta, isAlreadySharedDetails, parseSellListingDetails, sellClarificationReply, sellFlowOptions, isSellServiceTransitionQuery, isMultiPropertyServiceQuery, parseSellServiceLocationChoice, sellServiceLocationReply, advanceSellListing, emptySellListing, copySellListing, shouldCaptureSellLead, buildSellLeadIntent, hasSellContact, hasServiceContact, emptyServiceInquiry, copyServiceInquiry, seedServiceInquiry, parseServiceContactDetails, parseContactDetails, serviceContactReply, buildServiceLeadIntent, shouldCaptureServiceLead, isServiceInquiryMessage, parsePmNeedChoice, pmNeedReply, pmPropertyReply, hasPmPropertyContext, applyPmPropertyDetails, parseConversationIntent, currentConversationIntent, isExplicitIntentStarter, isPurposeChipReply, shouldResetOnListingIntent, isListingIntent, intentToPurpose, purposeToIntent, normalizeIntentValue, startFreshIntent, listingStartReply, listingStartOptions, listingIntakeReply, needsListingIntake, applyMessageToSearchFilters, parsePropertyTypesFromMessage, mergePropertyTypes, typesFromFilters, applyTypesToFilters, isShowMoreRequest, filtersFromRequestBody, uniqueIdList, parsePurposeFromMessage, parseBedroomChoice, applyBedroomChoice, applyBudgetChoice, isBedroomsResolved, isAmbiguousListingQuery, isListingFollowUp, isGeneralKnowledgeQuery, shouldSkipPropertySearch, isVagueConfirm, normalizePropertyType, parseLocationFromMessage, parseLocationReply, wantsDifferentLocation, locationClarificationReply, parseDesiredPropertyType, parsePropertyTypeChange, parseAlternativeChip, parseBudgetFromMessage, parseEmptyResultChoice, emptyResultOptions, emptyResultsReply, nearbyAreaOptions, matchesNamedOption, foundListingsReply, purposeClarificationReply, bedroomsClarificationReply, isPropertyUiAction, qualifyListingSearch, nextMissingListingSlot, listingSlotQuestion, listingSearchResetPatch, isExplicitSearchReset, hasInProgressListingSearch, isCurrentListingReference, buildSearchAcknowledgement, joinAckAndQuestion, stripExposedUrlsFromReply } = require('./chat.tools');

const HISTORY_TURNS = 10;
const MAX_STORED_MESSAGES = 40;
const MAX_TOOL_ROUNDS = 4;
const TOOL_MAX_TOKENS = 1024;
const REPLY_MAX_TOKENS = 600;
/** Content replies need enough tokens after reasoning models — 110 was truncating to empty content. */
const CONTENT_REPLY_MAX_TOKENS = 600;
const FRIENDLY_CHAT_ERROR = "Sorry, I couldn't pull that up — try again in a moment";

const PROPERTY_CTAS = ['View listing', 'Book a viewing', 'See similar properties'];
const CONTENT_CTAS = ['Talk to an agent', 'Explore related properties'];

function synthesizeContentReply(chunks = [], sources = []) {
  const first = (chunks || []).find((c) => String(c?.content || '').trim());
  if (first) {
    const excerpt = String(first.content)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220)
      .replace(/\s+\S*$/, '');
    const title = String(first.title || '').trim();
    if (excerpt) {
      return title
        ? `${excerpt}. Would you like more details from “${title}”?`
        : `${excerpt}. Would you like more details?`;
    }
  }
  if ((sources || []).length) {
    return 'I found related information for you — see the links below. Would you like more details?';
  }
  return '';
}

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
}

function isAbortError(err) {
  return (
    err instanceof ChatAbortedError ||
    err?.name === 'ChatAbortedError' ||
    err?.name === 'APIUserAbortError'
  );
}

/** §4.3 Path C JSON / done payload. */
function buildPathCPayload(result, reply, suggestedCta) {
  const payload = {
    reply,
    propertyCards: result.propertyCards || [],
    sources: result.sources || [],
    suggestedCta,
    viewAllMatching: result.viewAllMatching || null,
    // §2.1 — Path C must include leadCaptured (JSON and done).
    leadCaptured: !!(result.leadCaptured || result.profile?.leadCaptured),
  };
  if (result.options) {
    payload.requiresClarification = true;
    payload.options = result.options;
    payload.select = result.select || PURPOSE_SELECT;
  }
  if (result.inputType) payload.inputType = result.inputType;
  if (Array.isArray(result.quickReplies) && result.quickReplies.length) {
    payload.quickReplies = result.quickReplies;
  }
  return attachPropertySearchMeta(payload, result);
}

function attachPropertySearchMeta(payload, source = {}) {
  if (!payload || !source) return payload;
  if (source.hasMore !== undefined) payload.hasMore = !!source.hasMore;
  if (source.total !== undefined) payload.total = source.total;
  if (source.returnedCount !== undefined) payload.returnedCount = source.returnedCount;
  if (source.remaining !== undefined) payload.remaining = source.remaining;
  if (source.nextCursor !== undefined) payload.nextCursor = source.nextCursor;
  if (source.presentation) payload.presentation = source.presentation;
  if (source.intent) payload.intent = source.intent;
  if (source.searchState) payload.searchState = source.searchState;
  if (source.resultCount !== undefined) payload.resultCount = source.resultCount;
  if (source.marketStats) payload.marketStats = source.marketStats;
  if (source.overallMarketStats) payload.overallMarketStats = source.overallMarketStats;
  if (source.marketStatsScope) payload.marketStatsScope = source.marketStatsScope;
  if (Array.isArray(source.suggestedActions)) payload.suggestedActions = source.suggestedActions;
  if (source.alternativeInventory) payload.alternativeInventory = source.alternativeInventory;
  if (source.inventoryCounts) payload.inventoryCounts = source.inventoryCounts;
  return payload;
}

function metaFromLoopState(propertyCards, sources, viewAllMatching, presentation) {
  return {
    propertyCards: uniqueBy(propertyCards, (c) => c.id),
    sources: uniqueBy(sources, (s) => s.url || s.title),
    viewAllMatching: viewAllMatching || null,
    presentation: presentation || null,
  };
}

async function persistChatTurn(conversation, { message, reply, profile }) {
  // §7 — exactly one save per successful turn, after full reply text is known.
  conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
  conversation.messages.push({ role: 'assistant', content: reply, createdAt: new Date() });
  conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
  conversation.userProfile = profile;
  await conversation.save();
}

async function accumulateChatStream(stream, { onContentDelta, abortSignal } = {}) {
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  let finish_reason = null;
  let usage = null;

  for await (const chunk of stream) {
    throwIfAborted(abortSignal);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish_reason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      msg.content += delta.content;
      if (onContentDelta) onContentDelta(delta.content);
    }
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const part of delta.tool_calls) {
      const idx = part.index ?? 0;
      if (!msg.tool_calls[idx]) {
        msg.tool_calls[idx] = {
          id: '',
          type: part.type || 'function',
          function: { name: '', arguments: '' },
        };
      }
      const dest = msg.tool_calls[idx];
      if (part.id) dest.id = part.id;
      if (part.type) dest.type = part.type;
      if (part.function?.name) dest.function.name += part.function.name;
      if (part.function?.arguments) dest.function.arguments += part.function.arguments;
    }
  }

  if (!msg.tool_calls.length) delete msg.tool_calls;
  else msg.tool_calls = msg.tool_calls.filter(Boolean);
  return { message: msg, finish_reason, usage };
}

function toStoredPropertyCards(cards = []) {
  return (cards || []).slice(0, 10).map((card) => ({
    id: card.id || card.propertyRefNo || '',
    propertyRefNo: card.propertyRefNo || card.id || '',
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
    intent: current.intent || null,
    lastPropertyCards: toStoredPropertyCards(current.lastPropertyCards),
    shownPropertyIds: uniqueIdList(current.shownPropertyIds),
    lastSearchFilters: copySearchFilters(current.lastSearchFilters || emptySearchFilters()),
    slotFlow: {
      awaiting: current.slotFlow?.awaiting || null,
      alternatives: current.slotFlow?.alternatives || null,
    },
    sellListing: copySellListing(current.sellListing || {}),
    serviceInquiry: copyServiceInquiry(current.serviceInquiry || {}),
    viewingRequest: copyViewingRequest(current.viewingRequest || {}),
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
    if (patch.budget.min !== undefined) next.budget.min = patch.budget.min;
    if (patch.budget.max !== undefined) next.budget.max = patch.budget.max;
  }
  if (patch.bedrooms !== undefined) next.bedrooms = patch.bedrooms;
  if (patch.purpose !== undefined) next.purpose = patch.purpose;
  if (patch.intent !== undefined) next.intent = patch.intent;
  if (Array.isArray(patch.lastPropertyCards)) {
    next.lastPropertyCards = toStoredPropertyCards(patch.lastPropertyCards);
  }
  if (patch.resetShownPropertyIds) {
    next.shownPropertyIds = [];
  }
  if (Array.isArray(patch.shownPropertyIds)) {
    next.shownPropertyIds = uniqueIdList([...(next.shownPropertyIds || []), ...patch.shownPropertyIds]);
  }
  if (patch.lastSearchFilters) {
    next.lastSearchFilters = copySearchFilters(patch.lastSearchFilters);
  }
  if (patch.slotFlow) {
    next.slotFlow = {
      awaiting: patch.slotFlow.awaiting || null,
      alternatives: patch.slotFlow.alternatives ?? null,
    };
  }
  if (patch.sellListing) {
    next.sellListing = copySellListing({
      ...(next.sellListing || {}),
      ...patch.sellListing,
    });
  }
  if (patch.serviceInquiry) {
    next.serviceInquiry = copyServiceInquiry({
      ...(next.serviceInquiry || {}),
      ...patch.serviceInquiry,
    });
  }
  if (patch.viewingRequest) {
    next.viewingRequest = copyViewingRequest({
      ...(next.viewingRequest || {}),
      ...patch.viewingRequest,
    });
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
  if (sources.length) return CONTENT_CTAS[0];
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
        intent: null,
        lastPropertyCards: [],
        shownPropertyIds: [],
        lastSearchFilters: emptySearchFilters(),
        slotFlow: { awaiting: null },
        sellListing: emptySellListing(),
        serviceInquiry: emptyServiceInquiry(),
        viewingRequest: emptyViewingRequest(),
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

function listingSlotResponse(profile, filters, extraPatch = {}) {
  const previous = profile.lastSearchFilters || emptySearchFilters();
  const {
    slotFlow: _ignoredSlotFlow,
    lastSearchFilters: _ignoredFilters,
    explicitPurpose: explicitPurposeFlag,
    ...rest
  } = extraPatch || {};
  const next = normalizeSearchProfileAfterPatch(previous, filters || emptySearchFilters(), {
    explicitPurpose: explicitPurposeFlag === true,
  });
  const missing = nextMissingListingSlot(next);
  const question = missing ? listingSlotQuestion(missing, next) : null;
  const ack = buildSearchAcknowledgement(next, { previous });
  const patch = {
    ...listingSearchResetPatch(previous, next),
    ...rest,
    lastSearchFilters: next,
    slotFlow: question
      ? { awaiting: question.awaiting, alternatives: null }
      : { awaiting: null, alternatives: null },
  };
  patch.purpose = next.purpose || null;
  patch.intent = purposeToIntent(next.purpose) || null;
  if (next.location) patch.preferredAreas = rest.preferredAreas || [next.location];
  if (requiresBedroomsForSearch(next)) {
    if (next.bedrooms != null) patch.bedrooms = next.bedrooms;
    else if (next.bedroomsMin != null) patch.bedrooms = next.bedroomsMin;
    else patch.bedrooms = null;
  } else {
    patch.bedrooms = null;
  }
  patch.budget = {
    min: next.budgetMin ?? null,
    max: next.budgetMax ?? null,
  };
  console.log(
    'LISTING_PROFILE_STATE',
    JSON.stringify({
      intent: patch.intent,
      purpose: next.purpose || null,
      budgetProvided: next.budgetProvided === true,
      pendingSlot: patch.slotFlow?.awaiting || null,
      missing: missing || null,
    })
  );
  if (!missing) {
    return { type: 'continue', profile: mergeProfile(profile, patch) };
  }
  return {
    type: 'clarify',
    profile: mergeProfile(profile, patch),
    reply: joinAckAndQuestion(ack, question.reply),
    options: question.options,
    inputType: question.inputType || null,
    quickReplies: question.quickReplies || null,
  };
}

function bedroomClarifyPayload(profile, purpose) {
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (purpose) last.purpose = purpose;
  return listingSlotResponse(profile, last, {
    purpose: purpose || last.purpose || profile.purpose,
    intent: purposeToIntent(purpose || last.purpose) || profile.intent,
  });
}

function leaveSearchSlotForGeneralQuestion(profile) {
  return {
    type: 'delegate',
    profile: mergeProfile(profile, {
      slotFlow: { awaiting: null, alternatives: null },
    }),
  };
}

/** Leave sell context for a service/content answer without reusing the sell property in search filters. */
function leaveSellForServiceQuestion(profile, scope = 'different') {
  const patch = {
    slotFlow: { awaiting: null, alternatives: null },
  };
  if (scope !== 'same') {
    patch.lastSearchFilters = emptySearchFilters();
  }
  return {
    type: 'delegate',
    profile: mergeProfile(profile, patch),
  };
}

/** Property management / service inquiry — runs before sell so PM never shows sell chips. */
function applyServiceInquiryFlow(message, profile, history = []) {
  const awaiting = profile.slotFlow?.awaiting;
  const sellListing = profile.sellListing || {};
  const inPm =
    profile.intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT ||
    profile.serviceInquiry?.intent === 'property_management' ||
    awaiting === 'pmNeed' ||
    awaiting === 'pmProperty' ||
    awaiting === 'serviceLocation' ||
    awaiting === 'serviceContact';

  if (awaiting === 'pmNeed') {
    const need = parsePmNeedChoice(message);
    if (!need && !isVagueConfirm(message)) {
      const inquiry = applyPmPropertyDetails(message, profile.serviceInquiry || {});
      if (!parsePmNeedChoice(message) && (inquiry.propertyType || inquiry.referenceLocation)) {
        return {
          type: 'clarify',
          profile: mergeProfile(profile, {
            intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
            serviceInquiry: inquiry,
            slotFlow: { awaiting: 'pmNeed', alternatives: null },
          }),
          reply: pmNeedReply(),
          options: PM_NEED_OPTIONS,
        };
      }
      return {
        type: 'clarify',
        profile,
        reply: pmNeedReply(),
        options: PM_NEED_OPTIONS,
      };
    }
    let inquiry = copyServiceInquiry(profile.serviceInquiry || {});
    inquiry.intent = 'property_management';
    inquiry.need = need || inquiry.need || 'full';
    inquiry = applyPmPropertyDetails(message, inquiry);
    const hasReferenceLocation = !!(inquiry.referenceLocation || sellListing.location);
    if (hasReferenceLocation && !inquiry.locationScope && sellListing.location) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
          lastSearchFilters: emptySearchFilters(),
          serviceInquiry: {
            ...inquiry,
            referenceLocation: inquiry.referenceLocation || sellListing.location,
          },
          slotFlow: { awaiting: 'serviceLocation', alternatives: null },
        }),
        reply: sellServiceLocationReply(sellListing, inquiry),
        options: SELL_SERVICE_LOCATION_OPTIONS,
      };
    }
    if (hasPmPropertyContext(inquiry)) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
          lastSearchFilters: emptySearchFilters(),
          serviceInquiry: inquiry,
          slotFlow: { awaiting: 'serviceContact', alternatives: null },
        }),
        reply: serviceContactReply(inquiry),
      };
    }
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: inquiry,
        slotFlow: { awaiting: 'pmProperty', alternatives: null },
      }),
      reply: pmPropertyReply(inquiry),
    };
  }

  if (awaiting === 'pmProperty') {
    const inquiry = applyPmPropertyDetails(message, profile.serviceInquiry || {});
    if (!hasPmPropertyContext(inquiry)) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
          serviceInquiry: inquiry,
          slotFlow: { awaiting: 'pmProperty', alternatives: null },
        }),
        reply: pmPropertyReply(inquiry),
      };
    }
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: inquiry,
        slotFlow: { awaiting: 'serviceContact', alternatives: null },
      }),
      reply: serviceContactReply(inquiry),
    };
  }

  if (awaiting === 'serviceLocation') {
    const choice = parseSellServiceLocationChoice(message);
    const inquiry = copyServiceInquiry(profile.serviceInquiry || {});
    if (!choice) {
      return {
        type: 'clarify',
        profile,
        reply: sellServiceLocationReply(sellListing, inquiry),
        options: SELL_SERVICE_LOCATION_OPTIONS,
      };
    }
    const nextInquiry = {
      ...inquiry,
      locationScope: choice,
      referenceLocation: choice === 'same' ? inquiry.referenceLocation || sellListing.location : null,
      propertyType: choice === 'same' ? inquiry.propertyType || sellListing.type : inquiry.propertyType,
    };
    if (choice === 'different' || !hasPmPropertyContext(nextInquiry)) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          lastSearchFilters: emptySearchFilters(),
          serviceInquiry: nextInquiry,
          slotFlow: { awaiting: 'pmProperty', alternatives: null },
        }),
        reply: pmPropertyReply(nextInquiry),
      };
    }
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: nextInquiry,
        slotFlow: { awaiting: 'serviceContact', alternatives: null },
      }),
      reply: serviceContactReply(nextInquiry),
    };
  }

  if (awaiting === 'serviceContact') {
    const prior = copyServiceInquiry(profile.serviceInquiry || {});
    const typeChange = parsePropertyTypeChange(message) || normalizePropertyType(message);
    const locChange = parseLocationFromMessage(message) || parseSellListingDetails(message, {}).location;
    const correctionBits = [];
    let nextPrior = { ...prior };
    if (typeChange) {
      nextPrior.propertyNote = [prior.propertyNote, typeChange].filter(Boolean).join(' — ');
      nextPrior.propertyType = typeChange;
      correctionBits.push(typeChange.toLowerCase());
    }
    if (locChange) {
      nextPrior.referenceLocation = locChange;
      nextPrior.locationScope = nextPrior.locationScope || 'different';
      correctionBits.push(locChange);
    }
    const inquiry = parseServiceContactDetails(message, nextPrior);
    let reply = serviceContactReply(inquiry);
    if (correctionBits.length) {
      reply = `Got it — I've updated that to ${correctionBits.join(' in ')}.\n\n${reply}`;
    }
    const complete = hasServiceContact(inquiry);
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        serviceInquiry: inquiry,
        slotFlow: { awaiting: complete ? null : 'serviceContact', alternatives: null },
      }),
      reply,
    };
  }

  if (!isServiceInquiryMessage(message) && !inPm) return null;
  if (!isServiceInquiryMessage(message)) return null;

  const inquiry = seedServiceInquiry(profile.serviceInquiry || {}, sellListing, history, message);
  inquiry.intent = 'property_management';
  const hasReferenceLocation = !!(inquiry.referenceLocation || sellListing.location);

  if (!inquiry.need) {
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: inquiry,
        slotFlow: { awaiting: 'pmNeed', alternatives: null },
      }),
      reply: pmNeedReply(),
      options: PM_NEED_OPTIONS,
    };
  }

  if (hasReferenceLocation && !inquiry.locationScope && sellListing.location) {
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: {
          ...inquiry,
          referenceLocation: inquiry.referenceLocation || sellListing.location,
        },
        slotFlow: { awaiting: 'serviceLocation', alternatives: null },
      }),
      reply: sellServiceLocationReply(sellListing, inquiry),
      options: SELL_SERVICE_LOCATION_OPTIONS,
    };
  }

  if (!hasPmPropertyContext(inquiry)) {
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
        lastSearchFilters: emptySearchFilters(),
        serviceInquiry: inquiry,
        slotFlow: { awaiting: 'pmProperty', alternatives: null },
      }),
      reply: pmPropertyReply(inquiry),
    };
  }

  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
      intent: CONVERSATION_INTENTS.PROPERTY_MANAGEMENT,
      lastSearchFilters: emptySearchFilters(),
      serviceInquiry: inquiry,
      slotFlow: { awaiting: 'serviceContact', alternatives: null },
    }),
    reply: serviceContactReply(inquiry),
  };
}

function applySellFlow(message, profile, history = []) {
  if (
    isServiceInquiryMessage(message) ||
    profile.slotFlow?.awaiting === 'serviceLocation' ||
    profile.slotFlow?.awaiting === 'serviceContact' ||
    profile.slotFlow?.awaiting === 'pmNeed' ||
    profile.slotFlow?.awaiting === 'pmProperty' ||
    profile.intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT
  ) {
    return null;
  }
  const awaitingSell = profile.slotFlow?.awaiting === 'sell';
  const inSell = awaitingSell || profile.sellListing?.intent === 'sell';
  const sellNow = parseSellIntent(message);
  const cta = isSellCta(message);
  if (!sellNow && !cta && !inSell) return null;
  if (cta && !inSell) return null;

  const sellListing = profile.sellListing || {};
  const hasSellProperty = !!(sellListing.type && sellListing.location);

  if (profile.slotFlow?.awaiting === 'sellServiceLocation') {
    const choice = parseSellServiceLocationChoice(message);
    if (choice === 'same') return leaveSellForServiceQuestion(profile, 'same');
    if (choice === 'different') return leaveSellForServiceQuestion(profile, 'different');
    return {
      type: 'clarify',
      profile,
      reply: sellServiceLocationReply(sellListing, profile.serviceInquiry || {}),
      options: SELL_SERVICE_LOCATION_OPTIONS,
    };
  }

  const buyerSearch =
    inSell &&
    !sellNow &&
    !cta &&
    (parsePurposeFromMessage(message) === 'Buy' ||
      parsePurposeFromMessage(message) === 'Rent' ||
      parsePurposeFromMessage(message) === 'Off-plan' ||
      (/^\s*(show|find|search)\b/i.test(message) && isListingFollowUp(message)));
  if (buyerSearch) {
    const nextPurpose = parsePurposeFromMessage(message);
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        lastSearchFilters: emptySearchFilters(),
        sellListing: emptySellListing(),
        intent: nextPurpose ? purposeToIntent(nextPurpose) : null,
        purpose: nextPurpose || null,
        slotFlow: { awaiting: null, alternatives: null },
      }),
    };
  }

  // Content questions (Golden Visa, flexi rent, costs, etc.) must leave SELL — never repeat sell chips.
  if (inSell && !sellNow && !cta && (isGeneralKnowledgeQuery(message) || shouldSkipPropertySearch(message))) {
    return leaveSellForServiceQuestion(profile, 'different');
  }

  // After contact is already collected, do not trap unrelated follow-ups inside SELL.
  if (
    inSell &&
    !sellNow &&
    !cta &&
    hasSellContact(sellListing) &&
    !isAlreadySharedDetails(message) &&
    String(message || '').trim().length > 12
  ) {
    const contactOnly = parseContactDetails(message, {});
    const looksLikeNewContact =
      !!(contactOnly.name || contactOnly.email || contactOnly.phone) &&
      String(message || '').length < 160;
    if (!looksLikeNewContact) {
      return leaveSellForServiceQuestion(profile, 'different');
    }
  }

  const listing = advanceSellListing(
    message,
    profile.sellListing || {},
    history,
    profile.lastSearchFilters || {}
  );
  // Do not copy Buy/Rent search filters into the sell profile — that leaks area/type
  const filters = {
    ...emptySearchFilters(),
    type: listing.type || null,
    location: listing.location || null,
    bedrooms: listing.bedrooms ?? null,
    purpose: null,
  };
  const options = sellFlowOptions(listing, message);
  const sellActionDone = hasSellContact(listing) && (cta || isAlreadySharedDetails(message));

  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
      intent: CONVERSATION_INTENTS.SELL_PROPERTY,
      lastSearchFilters: filters,
      sellListing: listing,
      purpose: null,
      slotFlow: { awaiting: sellActionDone ? null : 'sell', alternatives: null },
    }),
    reply: sellClarificationReply(listing, message),
    options: options || undefined,
  };
}

function applyRelocationIntent(message, profile) {
  if (!wantsDifferentLocation(message)) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (!last.purpose && !last.location && !last.type && !profile.purpose) return null;

  const newTypes = parsePropertyTypesFromMessage(message);
  const previousLocation = last.location;
  last.location = null;
  if (newTypes.length) applyTypesToFilters(last, newTypes);
  const resolvedPurpose = last.purpose || profile.purpose || null;
  if (resolvedPurpose) last.purpose = resolvedPurpose;

  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
      purpose: resolvedPurpose || profile.purpose,
      lastSearchFilters: last,
      slotFlow: { awaiting: 'location', alternatives: null },
    }),
    reply: locationClarificationReply(),
    options: nearbyAreaOptions(previousLocation),
  };
}

function applyPropertyTypeChange(message, profile) {
  const incoming = parsePropertyTypesFromMessage(message);
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (!last.purpose && !last.location && !profile.purpose && !isListingIntent(profile.intent)) return null;

  const mentionedLocation = parseLocationFromMessage(message);
  if (mentionedLocation && last.location) {
    const locDiffers = mentionedLocation.trim().toLowerCase() !== last.location.trim().toLowerCase();
    if (locDiffers) return null;
  }

  if (incoming.length > 1) {
    applyTypesToFilters(last, mergePropertyTypes(typesFromFilters(last), incoming, message));
    const explicitPurpose = parsePurposeFromMessage(message);
    if (explicitPurpose) last.purpose = explicitPurpose;
    if (mentionedLocation && !last.location) last.location = mentionedLocation;
    const beds = parseBedroomChoice(message);
    if (beds) applyBedroomChoice(last, beds);
    const budget = parseBudgetFromMessage(message);
    if (budget) applyBudgetChoice(last, budget);
    return listingSlotResponse(profile, last, {
      preferredAreas: last.location ? [last.location] : undefined,
      explicitPurpose: !!explicitPurpose,
    });
  }

  const newType = parsePropertyTypeChange(message) || (incoming.length === 1 ? incoming[0] : null);
  if (!newType) return null;

  const currentTypes = typesFromFilters(last);
  if (currentTypes.length === 1 && currentTypes[0].toLowerCase() === newType.toLowerCase() && last.location) {
    return null;
  }

  const explicitPurpose = parsePurposeFromMessage(message);
  applyTypesToFilters(last, mergePropertyTypes(currentTypes, [newType], message));
  if (explicitPurpose) last.purpose = explicitPurpose;

  if (mentionedLocation && !last.location) {
    last.location = mentionedLocation;
    return listingSlotResponse(profile, last, {
      preferredAreas: [mentionedLocation],
      explicitPurpose: !!explicitPurpose,
    });
  }

  if (!last.location) {
    const normalized = listingSlotResponse(profile, last, { explicitPurpose: !!explicitPurpose });
    if (normalized.type === 'clarify') return normalized;
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        lastSearchFilters: last,
        slotFlow: { awaiting: 'location', alternatives: null },
      }),
      reply: locationClarificationReply(),
      options: nearbyAreaOptions(null),
    };
  }

  return listingSlotResponse(profile, last, { explicitPurpose: !!explicitPurpose });
}

function applyShowMore(message, profile) {
  if (!isShowMoreRequest(message)) return null;
  const intent = profile.intent || purposeToIntent(profile.purpose || profile.lastSearchFilters?.purpose);
  if (!isListingIntent(intent) && !profile.lastSearchFilters?.purpose && !profile.purpose) {
    return null;
  }
  return {
    type: 'continue',
    profile: mergeProfile(profile, {
      slotFlow: { awaiting: null, alternatives: null },
    }),
  };
}

function applyConversationIntent(message, profile, explicitIntent = null) {
  const requestedIntent = normalizeIntentValue(explicitIntent);
  const detected = requestedIntent || parseConversationIntent(message);
  if (!detected) return null;

  const current = currentConversationIntent(profile);
  const starter = isExplicitIntentStarter(message);
  const switching = !!(current && detected !== current);
  const restart = shouldResetOnListingIntent(message, profile, explicitIntent);

  // In-sentence "to buy" / purpose chips must merge into the current search
  // profile. Only menu starters reset. Body intent on an in-progress search
  // (e.g. studio parsed, user taps Rent) must not wipe bedrooms = 0.
  if (isListingIntent(detected) && !starter && !switching && !restart) {
    return null;
  }

  if (
    switching &&
    isListingIntent(detected) &&
    isListingIntent(current) &&
    !starter &&
    !restart
  ) {
    if (parsePropertyTypesFromMessage(message).length || parseLocationFromMessage(message)) {
      return null;
    }
    const previous = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    if (!previous.purpose) previous.purpose = intentToPurpose(current);
    const patched = copySearchFilters(previous);
    patched.purpose = intentToPurpose(detected);
    return listingSlotResponse(profile, patched, {
      intent: detected,
      purpose: patched.purpose,
      resetShownPropertyIds: true,
      explicitPurpose: true,
    });
  }

  if (!switching && !restart && current === detected) return null;

  const nextProfile = startFreshIntent(detected, message, profile);
  const reply = listingStartReply(detected, nextProfile, message);
  const options = listingStartOptions(detected, nextProfile, message);

  if (isListingIntent(detected) && !nextMissingListingSlot(nextProfile.lastSearchFilters || {})) {
    return {
      type: 'continue',
      profile: nextProfile,
    };
  }

  return {
    type: 'clarify',
    profile: nextProfile,
    reply: reply || listingIntakeReply(detected),
    options,
  };
}

function resolvePendingSlots(message, profile, history = [], explicitIntent = null, viewingSelection = {}) {
  if (isListingSearchOverride(message) && profile.viewingRequest?.active && !isBookViewingAction(message)) {
    profile = mergeProfile(profile, {
      viewingRequest: { ...copyViewingRequest(profile.viewingRequest), active: false },
      slotFlow: ['viewingContact', 'viewingTime', 'viewingProperty'].includes(profile.slotFlow?.awaiting)
        ? { awaiting: null, alternatives: null }
        : profile.slotFlow,
    });
  }

  const intentGate = applyConversationIntent(message, profile, explicitIntent);
  if (intentGate) return intentGate;

  const awaiting = profile.slotFlow?.awaiting;

  const serviceFlow = applyServiceInquiryFlow(message, profile, history);
  if (serviceFlow) return serviceFlow;

  const sellFlow = applySellFlow(message, profile, history);
  if (sellFlow) return sellFlow;

  const viewingFlow = applyViewingRequestFlow(message, profile, history, viewingSelection);
  if (viewingFlow) {
    return {
      type: viewingFlow.type,
      profile: mergeProfile(profile, viewingFlow.profilePatch || {}),
      reply: viewingFlow.reply,
      options: viewingFlow.options,
    };
  }

  const showMore = applyShowMore(message, profile);
  if (showMore) return showMore;

  if (isExplicitSearchReset(message)) {
    const next = applyMessageToSearchFilters(emptySearchFilters(), message);
    return listingSlotResponse(profile, next, {
      resetShownPropertyIds: true,
      lastPropertyCards: [],
      shownPropertyIds: [],
    });
  }

  // "villa in another location" — reset location and keep type/bedrooms/purpose
  const relocation = applyRelocationIntent(message, profile);
  if (relocation) return relocation;

  // Property-type change takes priority over any pending clarification state
  const typeChange = applyPropertyTypeChange(message, profile);
  if (typeChange) return typeChange;

  // New-location search: explicit different location in message → reset and proceed
  const newLocSearch = applyNewLocationSearch(message, profile);
  if (newLocSearch) return newLocSearch;

  const listingUpdate = applyListingFilterUpdate(message, profile);
  if (listingUpdate) return listingUpdate;

  if (!awaiting) return null;

  if (awaiting === 'listingIntake') {
    const last = applyMessageToSearchFilters(
      copySearchFilters(profile.lastSearchFilters || emptySearchFilters()),
      message,
      { awaiting }
    );
    const purpose = last.purpose || profile.purpose || intentToPurpose(profile.intent);
    if (purpose) last.purpose = purpose;
    return listingSlotResponse(profile, last, {
      purpose,
      intent: profile.intent || purposeToIntent(purpose),
    });
  }

  if (awaiting === 'purpose') {
    const purpose = parsePurposeFromMessage(message);
    if (!purpose) return null;

    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    last.purpose = purpose;
    return listingSlotResponse(profile, last, {
      purpose,
      intent: purposeToIntent(purpose),
    });
  }

  if (awaiting === 'bedrooms') {
    const choice = parseBedroomChoice(message);
    if (!choice) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
      return listingSlotResponse(profile, profile.lastSearchFilters || emptySearchFilters());
    }

    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    applyBedroomChoice(last, choice);
    return listingSlotResponse(profile, last);
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
      last.budgetProvided = false;
      last.budgetMin = null;
      last.budgetMax = null;
      return listingSlotResponse(profile, last);
    }
    if (emptyChoice?.askBedrooms) {
      return bedroomClarifyPayload(mergeProfile(profile, { lastSearchFilters: last }), last.purpose || profile.purpose);
    }
    if (emptyChoice?.askType) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          lastSearchFilters: last,
          slotFlow: { awaiting: 'listingIntake', alternatives: null },
        }),
        reply: 'What type of property would you like instead?',
        options: ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Office', 'Shop', 'Warehouse'],
      };
    }
    if (emptyChoice?.location) {
      last.location = emptyChoice.location;
      return {
        type: 'continue',
        profile: mergeProfile(profile, {
          preferredAreas: [emptyChoice.location],
          lastSearchFilters: last,
          slotFlow: { awaiting: null, alternatives: null },
          resetShownPropertyIds: true,
        }),
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

    if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
      return leaveSearchSlotForGeneralQuestion(profile);
    }

    return {
      type: 'clarify',
      profile,
      reply: emptyResultsReply(last),
      options: emptyResultOptions(last),
    };
  }

  if (awaiting === 'alternatives') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());

    // Parse stored alternative list from slotFlow.alternatives JSON
    let storedAlts = [];
    try {
      storedAlts = profile.slotFlow?.alternatives ? JSON.parse(profile.slotFlow.alternatives) : [];
    } catch {
      storedAlts = [];
    }

    // Try to match message to one of the stored alternatives by label
    const matched = storedAlts.find((a) => {
      return String(a.label || '').toLowerCase() === message.trim().toLowerCase();
    });

    // Also try parsing the message directly as an alternative chip (typed equivalent)
    const chipPatch = matched ? matched.patch : parseAlternativeChip(message, last);

    if (!chipPatch || isVagueConfirm(message)) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
      // Re-show the same alternatives with a prompt to pick one
      return {
        type: 'clarify',
        profile,
        reply: storedAlts.length > 0
          ? 'Here are the closest alternatives I found — please pick one:'
          : emptyResultsReply(copySearchFilters(profile.lastSearchFilters || emptySearchFilters())),
        options: storedAlts.map((a) => a.label),
      };
    }

    // Apply the patch to lastSearchFilters
    const next = copySearchFilters(last);
    if (chipPatch.location) next.location = chipPatch.location;
    if (chipPatch.type) next.type = chipPatch.type;
    if (chipPatch.bedroomChoice) {
      applyBedroomChoice(next, chipPatch.bedroomChoice);
    } else if (
      chipPatch.location &&
      !chipPatch.type &&
      nearbyAreaOptions(last.location).some(
        (a) => a.toLowerCase() === String(chipPatch.location).trim().toLowerCase()
      )
    ) {
      // Bare nearby-area chip after a location-empty offer — search any bedrooms there
      next.bedrooms = null;
      next.bedroomsMin = null;
      next.bedroomsAny = true;
      next.bedroomsResolved = true;
    }
    // Carry purpose forward
    const resolvedPurpose = next.purpose || profile.purpose || null;
    if (resolvedPurpose) next.purpose = resolvedPurpose;

    const patch = { lastSearchFilters: next, slotFlow: { awaiting: null, alternatives: null } };
    if (chipPatch.bedroomChoice?.exact != null) patch.bedrooms = chipPatch.bedroomChoice.exact;
    if (chipPatch.bedroomChoice?.min != null) patch.bedrooms = chipPatch.bedroomChoice.min;
    if (chipPatch.type) patch.purpose = resolvedPurpose;   // ensure purpose stays

    return {
      type: 'continue',
      profile: mergeProfile(profile, patch),
    };
  }

  if (awaiting === 'location') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const options = nearbyAreaOptions(last.location);
    const named = matchesNamedOption(message, options) || parseLocationReply(message);
    if (!named || isVagueConfirm(message) || wantsDifferentLocation(message)) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
      return {
        type: 'clarify',
        profile,
        reply: locationClarificationReply(),
        options,
      };
    }
    last.location = named;
    const resolvedPurpose = last.purpose || profile.purpose || null;
    if (resolvedPurpose) last.purpose = resolvedPurpose;
    return listingSlotResponse(profile, last, { preferredAreas: [named] });
  }

  if (awaiting === 'nearbyArea') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const options = nearbyAreaOptions(last.location);
    const named = matchesNamedOption(message, options);
    if (!named || isVagueConfirm(message)) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
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
    const patched = applyMessageToSearchFilters(last, message, { awaiting: 'budget' });
    const budget = parseBudgetFromMessage(message, { requireBudgetContext: true });
    const changed =
      JSON.stringify(copySearchFilters(last)) !== JSON.stringify(copySearchFilters(patched));
    if (budget || changed) {
      return listingSlotResponse(profile, patched, {
        budget: { min: patched.budgetMin ?? null, max: patched.budgetMax ?? null },
      });
    }
    if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
      return leaveSearchSlotForGeneralQuestion(profile);
    }
    return listingSlotResponse(profile, last);
  }

  return null;
}

/**
 * Detects a listing refinement that names a different location (or escapes
 * empty-results with a fresh listing statement). Follow-ups are patches:
 * only mentioned fields change; bedrooms/budget/purpose stay unless stated.
 */
function applyNewLocationSearch(message, profile) {
  if (wantsDifferentLocation(message)) return null;
  const mentionedLocation = parseLocationFromMessage(message);
  const mentionedTypes = parsePropertyTypesFromMessage(message);
  const purposeFromMsg = parsePurposeFromMessage(message);
  const bedsFromMsg = parseBedroomChoice(message);
  const budget = parseBudgetFromMessage(message);

  const looksLikeListing =
    /\b(show|find|search|looking|buy|purchase|rent|lease|for\s+sale|apartments?|villas?|townhouses?|penthouses?|duplexes?|studios?|flats?|offices?|propert(?:y|ies)|homes?|listings?)\b/i.test(
      message
    ) || !!mentionedLocation;
  if (!looksLikeListing && !purposeFromMsg) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  const awaiting = profile.slotFlow?.awaiting;
  const inEmptySlot = awaiting === 'emptyResults' || awaiting === 'alternatives';

  if (!last.location && !inEmptySlot) return null;

  const locDiffers =
    !!(mentionedLocation && last.location) &&
    mentionedLocation.trim().toLowerCase() !== last.location.trim().toLowerCase();
  const lastTypes = typesFromFilters(last);
  const typeDiffers =
    mentionedTypes.length > 0 &&
    mentionedTypes.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase();

  const freshEscape =
    inEmptySlot &&
    !!(mentionedLocation || last.location) &&
    !!(purposeFromMsg || mentionedTypes.length || bedsFromMsg || budget);

  if (!locDiffers && !typeDiffers && !freshEscape) return null;
  if (!mentionedLocation && !locDiffers && !(inEmptySlot && last.location && (typeDiffers || purposeFromMsg))) {
    return null;
  }

  const resolvedLocation = mentionedLocation || last.location;
  if (!resolvedLocation) return null;

  const newFilters = applyMessageToSearchFilters(last, message, { awaiting });
  if (!newFilters.purpose) newFilters.purpose = last.purpose || profile.purpose || null;
  if (!newFilters.location && !newFilters.locationAny) newFilters.location = resolvedLocation;

  return listingSlotResponse(profile, newFilters, {
    preferredAreas: newFilters.location ? [newFilters.location] : [resolvedLocation],
    explicitPurpose: !!purposeFromMsg,
  });
}

function applyListingFilterUpdate(message, profile) {
  const result = qualifyListingSearch(message, profile);
  if (!result) return null;
  return {
    type: result.type,
    profile: mergeProfile(profile, result.profilePatch),
    reply: result.reply,
    options: result.options,
    inputType: result.inputType || null,
    quickReplies: result.quickReplies || null,
  };
}

function bedroomClarifyIfNeeded(message, profile) {
  if (isPropertyUiAction(message) || isBookViewingAction(message)) return null;
  if (['viewingContact', 'viewingTime', 'viewingProperty'].includes(profile.slotFlow?.awaiting)) return null;
  if (profile.viewingRequest?.active) return null;
  if (
    parseSellIntent(message) ||
    profile.slotFlow?.awaiting === 'sell' ||
    profile.slotFlow?.awaiting === 'pmNeed' ||
    profile.slotFlow?.awaiting === 'pmProperty' ||
    profile.sellListing?.intent === 'sell' ||
    profile.intent === CONVERSATION_INTENTS.SELL_PROPERTY ||
    profile.intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT
  ) {
    return null;
  }
  if (shouldSkipPropertySearch(message) || isGeneralKnowledgeQuery(message)) return null;
  const result = qualifyListingSearch(message, profile);
  if (!result || result.type !== 'clarify') return null;
  return {
    type: 'clarify',
    profile: mergeProfile(profile, result.profilePatch),
    reply: result.reply,
    options: result.options,
    inputType: result.inputType || null,
    quickReplies: result.quickReplies || null,
  };
}

async function maybeCaptureServiceLead(sessionId, profile) {
  const inquiry = profile.serviceInquiry || {};
  if (!shouldCaptureServiceLead(inquiry)) {
    return { profile, leadCaptured: false };
  }
  const result = await executeTool(
    'capture_lead',
    {
      name: inquiry.name,
      phone: inquiry.phone,
      whatsapp: inquiry.whatsapp,
      email: inquiry.email || '',
      intent: buildServiceLeadIntent(inquiry),
      emailOptional: true,
    },
    { sessionId, leadAlreadyCaptured: !!profile.leadCaptured }
  );
  let nextProfile = profile;
  if (result.profilePatch) {
    nextProfile = mergeProfile(profile, result.profilePatch);
  }
  return { profile: nextProfile, leadCaptured: !!result.leadCaptured };
}

async function maybeCaptureSellLead(sessionId, profile, message) {
  const listing = profile.sellListing || {};
  if (!shouldCaptureSellLead(message, listing)) {
    return { profile, leadCaptured: false };
  }
  const result = await executeTool(
    'capture_lead',
    {
      name: listing.name,
      phone: listing.phone,
      email: listing.email,
      intent: buildSellLeadIntent(message, listing),
    },
    { sessionId, leadAlreadyCaptured: !!profile.leadCaptured }
  );
  let nextProfile = profile;
  if (result.profilePatch) {
    nextProfile = mergeProfile(profile, result.profilePatch);
  }
  return { profile: nextProfile, leadCaptured: !!result.leadCaptured };
}

async function maybeCaptureViewingLead(sessionId, profile) {
  const vr = copyViewingRequest(profile.viewingRequest || {});
  if (vr.submitted) {
    logViewingDebug('VIEWING_LEAD_CREATE', {
      sessionId,
      skipped: true,
      reason: 'already_submitted',
      propertyRefNo: vr.propertyRefNo || null,
    });
    return {
      profile,
      leadCaptured: true,
      result: {
        leadCaptured: true,
        modelPayload: { ok: true, alreadyCaptured: true },
      },
    };
  }
  logViewingDebug('VIEWING_LEAD_CREATE', {
    sessionId,
    skipped: false,
    reason: 'attempt',
    propertyRefNo: vr.propertyRefNo || null,
    name: vr.name || null,
    email: vr.email || null,
    phone: vr.phone || null,
  });
  const result = await executeTool(
    'capture_lead',
    {
      name: vr.name,
      phone: vr.phone,
      email: vr.email || '',
      intent: buildViewingLeadIntent(vr, profile),
      emailOptional: true,
      phoneOptional: true,
    },
    { sessionId, leadAlreadyCaptured: false }
  );
  let nextProfile = profile;
  if (result.profilePatch) {
    nextProfile = mergeProfile(profile, result.profilePatch);
  }
  return { profile: nextProfile, leadCaptured: !!result.leadCaptured, result };
}

async function clarificationResponse(res, { reply, profile, conversation, message, options, inputType, quickReplies, leadCaptured = false }) {
  const safeReply = String(reply || '').trim() || FRIENDLY_CHAT_ERROR;
  conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
  conversation.messages.push({ role: 'assistant', content: safeReply, createdAt: new Date() });
  conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
  conversation.userProfile = profile;
  await conversation.save();

  const body = {
    reply: safeReply,
    leadCaptured,
    ...emptyClarificationPayload(),
  };
  if (options) {
    body.requiresClarification = true;
    body.options = options;
    body.select = PURPOSE_SELECT;
  }
  if (inputType) body.inputType = inputType;
  if (Array.isArray(quickReplies) && quickReplies.length) body.quickReplies = quickReplies;
  return res.status(200).json(body);
}

async function polishListingReply(fallback, context, userMessage, previousSearch) {
  const seed = String(fallback || '').trim();
  if (!context || !process.env.OPENAI_API_KEY) return seed;
  try {
    const openai = getOpenAI();
    const model = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-5-nano';
    const completion = await openai.chat.completions.create({
      model,
      max_completion_tokens: 450,
      messages: [
        { role: 'system', content: getListingReplyPrompt() },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage,
            previousSearch: previousSearch || null,
            responseContext: (() => {
              if (!context || typeof context !== 'object') return context;
              const { searchUrl, exactListings, ...safe } = context;
              const presentation = context.presentation || null;
              const { viewAll, ...safePresentation } = presentation || {};
              return {
                ...safe,
                presentation: Object.keys(safePresentation).length ? safePresentation : null,
              };
            })(),
          }),
        },
      ],
    });
    const text = stripExposedUrlsFromReply(String(completion.choices?.[0]?.message?.content || '').trim());
    return text || seed;
  } catch (err) {
    console.error('polishListingReply failed:', err.message || err);
    return seed;
  }
}

async function runForcedPropertySearch({ sessionId, profile, userMessage, previousSearch }) {
  const result = await executeTool(
    'search_properties',
    {},
    {
      sessionId,
      lastSearchFilters: profile.lastSearchFilters,
      leadAlreadyCaptured: !!profile.leadCaptured,
      slotFlow: profile.slotFlow,
      userMessage,
      intent: profile.intent,
      shownPropertyIds: profile.shownPropertyIds,
      previousSearch,
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

  if (
    result.needsPurpose ||
    result.needsBedrooms ||
    result.needsPropertyType ||
    result.needsLocation ||
    result.needsBudget
  ) {
    return {
      reply: result.clarificationReply || purposeClarificationReply(),
      profile: nextProfile,
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: result.options || PURPOSE_OPTIONS,
      inputType: result.inputType || null,
      quickReplies: result.quickReplies || null,
      select: PURPOSE_SELECT,
    };
  }

  if (result.modelPayload?.skipped) {
    return {
      reply: null,
      profile: nextProfile,
      propertyCards: [],
      sources: [],
      skippedSearch: true,
      suggestedCta: null,
      viewAllMatching: null,
    };
  }

  if (result.needsEmptyResults || !(result.propertyCards || []).length) {
    const filters = result.effectiveFilters || nextProfile.lastSearchFilters || {};
    // Forward the slotFlow from the result (includes awaiting + alternatives JSON)
    const resultSlotFlow = result.profilePatch?.slotFlow || { awaiting: 'emptyResults' };
    const hasOpts = Array.isArray(result.options) && result.options.length > 0;
    const responseOpts = hasOpts ? result.options : emptyResultOptions(filters);
    return {
      reply: await polishListingReply(
        result.clarificationReply || emptyResultsReply(filters),
        result.responseContext,
        userMessage,
        previousSearch || profile.lastSearchFilters
      ),
      profile: mergeProfile(nextProfile, { slotFlow: resultSlotFlow }),
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      presentation: result.presentation || null,
      requiresClarification: true,
      options: responseOpts,
      select: PURPOSE_SELECT,
      hasMore: false,
      total: result.total ?? 0,
      returnedCount: 0,
      remaining: 0,
      nextCursor: null,
    };
  }

  const fallbackReply =
    result.replyOverride ||
    foundListingsReply(result.effectiveFilters || nextProfile.lastSearchFilters, result.modelPayload?.total);
  const success = {
    reply: await polishListingReply(
      fallbackReply,
      result.responseContext,
      userMessage,
      previousSearch || profile.lastSearchFilters
    ),
    profile: mergeProfile(nextProfile, { slotFlow: { awaiting: null } }),
    propertyCards: uniqueBy(result.propertyCards || [], (c) => c.id),
    sources: result.sources || [],
    suggestedCta: null,
    viewAllMatching: result.viewAllMatching || null,
    presentation: result.presentation || null,
    intent: result.intent || null,
    searchState: result.searchState || null,
    resultCount: result.resultCount ?? result.total ?? 0,
    marketStats: result.marketStats || null,
    overallMarketStats: result.overallMarketStats || null,
    marketStatsScope: result.marketStatsScope || null,
    suggestedActions: result.suggestedActions || result.options || null,
    alternativeInventory: result.alternativeInventory || null,
    inventoryCounts: result.inventoryCounts || null,
    hasMore: !!result.hasMore,
    total: result.total ?? result.modelPayload?.total ?? 0,
    returnedCount: result.returnedCount ?? (result.propertyCards || []).length,
    remaining: result.remaining ?? 0,
    nextCursor: result.hasMore ? result.nextCursor || 'shownPropertyIds' : null,
  };
  if (Array.isArray(result.options) && result.options.length) {
    success.requiresClarification = true;
    success.options = result.options;
    success.select = result.select || PURPOSE_SELECT;
  }
  return success;
}

async function runModelLoop({ sessionId, userProfile, history, userMessage, turnIndex, sse = null }) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-5-nano';
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'minimal';
  const abortSignal = sse?.signal || null;
  const streamEnabled = Boolean(sse?.enabled);

  const messages = [
    { role: 'system', content: getSystemPrompt(userProfile) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const propertyCards = [];
  const sources = [];
  let leadCaptured = false;
  let profile = userProfile;
  let lastSearchNeedsSlot = false;
  let lastSearchNeedsEmptyResults = false;
  let slotClarifyReply = '';
  let emptyClarifyReply = '';
  let emptyClarifyOptions = null;
  let viewAllMatching = null;
  let presentation = null;
  let clarificationOptions = null;
  let clarificationInputType = null;
  let clarificationQuickReplies = null;
  let usedSearchContent = false;
  let usedSearchProperties = false;
  let lastContentChunks = [];
  let searchContentHits = 0;
  let lastSearchPagination = null;

  const snapshotMeta = () => metaFromLoopState(propertyCards, sources, viewAllMatching, presentation);

  const completionParams = (forceContentAnswer, contentOnlyReply, hasToolResults) => ({
    model,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: forceContentAnswer ? 'none' : 'auto',
    max_completion_tokens: contentOnlyReply
      ? CONTENT_REPLY_MAX_TOKENS
      : hasToolResults
        ? REPLY_MAX_TOKENS
        : TOOL_MAX_TOKENS,
    reasoning_effort: reasoningEffort,
  });

  async function createAssistantMessage({ forceContentAnswer, contentOnlyReply, hasToolResults }) {
    throwIfAborted(abortSignal);
    const params = completionParams(forceContentAnswer, contentOnlyReply, hasToolResults);
    const requestOptions = abortSignal ? { signal: abortSignal } : undefined;

    if (!streamEnabled) {
      const completion = await openai.chat.completions.create(params, requestOptions);
      const msg = completion.choices?.[0]?.message;
      if (!msg) throw new Error('Empty response from OpenAI');
      console.log(
        'finish_reason:',
        completion.choices?.[0]?.finish_reason,
        '| usage:',
        completion.usage,
        '| content_length:',
        (msg.content || '').length
      );
      return msg;
    }

    // Live tokens only after tools are done and we know this round is text (§3, §6, §11).
    if (forceContentAnswer) {
      sse.begin(snapshotMeta());
      const stream = await openai.chat.completions.create({ ...params, stream: true }, requestOptions);
      const acc = await accumulateChatStream(stream, {
        abortSignal,
        onContentDelta: (text) => sse.token(text),
      });
      console.log(
        'finish_reason:',
        acc.finish_reason,
        '| usage:',
        acc.usage,
        '| content_length:',
        (acc.message.content || '').length
      );
      return acc.message;
    }

    // Auto round: stream internally so we can replay raw deltas if this IS the final text.
    // Do not flush SSE yet — this round may still be tool_calls (§6).
    const bufferedDeltas = [];
    const stream = await openai.chat.completions.create({ ...params, stream: true }, requestOptions);
    const acc = await accumulateChatStream(stream, {
      abortSignal,
      onContentDelta: (text) => bufferedDeltas.push(text),
    });
    console.log(
      'finish_reason:',
      acc.finish_reason,
      '| usage:',
      acc.usage,
      '| content_length:',
      (acc.message.content || '').length
    );
    const toolCalls = acc.message.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      sse.begin(snapshotMeta());
      for (const delta of bufferedDeltas) sse.token(delta);
    }
    return acc.message;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    throwIfAborted(abortSignal);
    const hasToolResults = messages.some((m) => m.role === 'tool');
    const contentOnlyReply =
      hasToolResults && usedSearchContent && !usedSearchProperties && propertyCards.length === 0;
    // After a successful content search, force a text answer — models otherwise re-call
    // search_content until MAX_TOOL_ROUNDS and the user sees "could not finish".
    const forceContentAnswer = contentOnlyReply && searchContentHits > 0;
    const msg = await createAssistantMessage({
      forceContentAnswer,
      contentOnlyReply,
      hasToolResults,
    });
    if (!msg) {
      throw new Error('Empty response from OpenAI');
    }

    messages.push(msg);

    const toolCalls = msg.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      let reply = String(msg.content || '').trim();
      if (!reply && usedSearchContent) {
        reply = synthesizeContentReply(lastContentChunks, sources) || FRIENDLY_CHAT_ERROR;
      }
      if (!reply) {
        reply = FRIENDLY_CHAT_ERROR;
      }
      if (usedSearchProperties) reply = stripExposedUrlsFromReply(reply);
      return {
        reply,
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching,
        presentation,
        ...(lastSearchPagination || {}),
      };
    }

    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (err) {
        args = {};
      }

      // Ignore repeat search_content once we already have chunks — answer instead next round
      if (
        call.function?.name === 'search_content' &&
        searchContentHits > 0 &&
        lastContentChunks.length > 0 &&
        !usedSearchProperties
      ) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            count: lastContentChunks.length,
            chunks: lastContentChunks,
            instruction:
              'You already have matching content. Do NOT call tools again. Answer the visitor now in at most 2 short sentences.',
          }),
        });
        continue;
      }

      let result;
      try {
        result = await executeTool(call.function?.name, args, {
          sessionId,
          lastSearchFilters: profile.lastSearchFilters,
          leadAlreadyCaptured: !!profile.leadCaptured,
          slotFlow: profile.slotFlow,
          userMessage,
          intent: profile.intent,
          shownPropertyIds: profile.shownPropertyIds,
          previousSearch,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        result = {
          propertyCards: [],
          sources: [],
          leadCaptured: false,
          profilePatch: {},
          modelPayload: { error: err.message || 'Tool failed' },
        };
      }
      // §8 — disconnect during an in-flight tool: discard; do not merge or persist.
      throwIfAborted(abortSignal);

      console.log(
        'TOOL CALL:',
        call.function?.name,
        'args:',
        call.function?.arguments,
        '| propertyCards returned:',
        result.propertyCards?.length ?? 0
      );

      if (call.function?.name === 'search_content') {
        usedSearchContent = true;
        const chunks = Array.isArray(result.modelPayload?.chunks) ? result.modelPayload.chunks : [];
        if (chunks.length) {
          lastContentChunks = chunks;
          searchContentHits += 1;
        }
      }
      if (call.function?.name === 'search_properties') usedSearchProperties = true;

      if (result.propertyCards?.length) propertyCards.push(...result.propertyCards);
      if (result.sources?.length) sources.push(...result.sources);
      if (result.leadCaptured) leadCaptured = true;
      if (result.profilePatch) profile = mergeProfile(profile, result.profilePatch);

      if (call.function?.name === 'search_properties') {
        lastSearchPagination = {
          hasMore: !!result.hasMore,
          total: result.total ?? result.modelPayload?.total ?? 0,
          returnedCount: result.returnedCount ?? (result.propertyCards || []).length,
          remaining: result.remaining ?? result.modelPayload?.remaining ?? 0,
          nextCursor: result.hasMore ? result.nextCursor || 'shownPropertyIds' : null,
        };
        const returnedCards = result.propertyCards?.length ?? 0;
        const needsSlot =
          result.needsPurpose ||
          result.needsBedrooms ||
          result.needsPropertyType ||
          result.needsLocation ||
          result.needsBudget ||
          result.modelPayload?.needsPurpose ||
          result.modelPayload?.needsBedrooms ||
          result.modelPayload?.needsPropertyType ||
          result.modelPayload?.needsLocation ||
          result.modelPayload?.needsBudget;
        if (needsSlot) {
          lastSearchNeedsSlot = true;
          slotClarifyReply = result.clarificationReply || purposeClarificationReply();
          clarificationOptions = result.options || PURPOSE_OPTIONS;
          clarificationInputType = result.inputType || null;
          clarificationQuickReplies = result.quickReplies || null;
          if (result.effectiveFilters) {
            const nextFilters = copySearchFilters(result.effectiveFilters);
            if (!nextFilters.purpose && profile.lastSearchFilters?.purpose) {
              nextFilters.purpose = profile.lastSearchFilters.purpose;
            }
            profile = mergeProfile(profile, {
              lastSearchFilters: nextFilters,
              slotFlow: result.profilePatch?.slotFlow || { awaiting: 'purpose' },
            });
          }
        }
        if (result.modelPayload?.skipped) {
          lastSearchNeedsSlot = false;
          lastSearchNeedsEmptyResults = false;
        } else if (result.needsEmptyResults || result.modelPayload?.needsEmptyResults) {
          lastSearchNeedsEmptyResults = true;
          emptyClarifyReply = result.clarificationReply || emptyResultsReply(result.effectiveFilters || {});
          const hasAltOpts = Array.isArray(result.options) && result.options.length > 0;
          emptyClarifyOptions = hasAltOpts ? result.options : emptyResultOptions(result.effectiveFilters || {});
          presentation = result.presentation || presentation;
          if (result.effectiveFilters) {
            const emptySlotFlow = result.profilePatch?.slotFlow || { awaiting: 'emptyResults' };
            profile = mergeProfile(profile, {
              lastSearchFilters: result.effectiveFilters,
              slotFlow: emptySlotFlow,
            });
          }
        }
        if (returnedCards > 0) {
          lastSearchNeedsSlot = false;
          lastSearchNeedsEmptyResults = false;
          viewAllMatching = result.viewAllMatching || null;
          presentation = result.presentation || presentation;
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

    if (lastSearchNeedsSlot && propertyCards.length === 0) {
      return {
        reply: slotClarifyReply || purposeClarificationReply(),
        propertyCards: uniqueBy(propertyCards, (c) => c.id),
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching: null,
        requiresClarification: true,
        options: clarificationOptions || PURPOSE_OPTIONS,
        inputType: clarificationInputType,
        quickReplies: clarificationQuickReplies,
        select: PURPOSE_SELECT,
        hasMore: false,
        nextCursor: null,
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
        presentation,
        requiresClarification: true,
        options: emptyClarifyOptions || emptyResultOptions(profile.lastSearchFilters || {}),
        select: PURPOSE_SELECT,
        ...(lastSearchPagination || { hasMore: false, nextCursor: null }),
      };
    }
  }

  // Max rounds exhausted — still return useful content if we have it
  const fallbackReply =
    synthesizeContentReply(lastContentChunks, sources) ||
    (usedSearchContent
      ? FRIENDLY_CHAT_ERROR
      : 'Sorry, I could not finish that just now. Please try again.');

  return {
    reply: fallbackReply,
    propertyCards: uniqueBy(propertyCards, (c) => c.id),
    sources: uniqueBy(sources, (s) => s.url || s.title),
    leadCaptured,
    profile,
    viewAllMatching,
    presentation,
    ...(lastSearchPagination || {}),
  };
}

const chat = async (req, res) => {
  try {
    const {
      sessionId,
      message,
      intent: bodyIntent,
      action,
      propertyRefNo,
      propertyId,
      propertyTitle,
    } = req.body;
    const conversation = await loadConversation(sessionId);
    let profile = conversation.userProfile || {};
    const previousSearch = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const pageBound = isCurrentListingReference(message);
    const applyPageContext =
      pageBound ||
      isPurposeChipReply(message) ||
      isExplicitIntentStarter(message) ||
      !hasInProgressListingSearch(profile);
    const requestTypes = filtersFromRequestBody(req.body);
    if (requestTypes.length && applyPageContext) {
      const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
      applyTypesToFilters(last, mergePropertyTypes(typesFromFilters(last), requestTypes, message));
      profile = mergeProfile(profile, { lastSearchFilters: last });
    }
    const slotResult = resolvePendingSlots(
      message,
      profile,
      conversation.messages || [],
      applyPageContext ? bodyIntent : null,
      { action, propertyRefNo, propertyId, propertyTitle }
    );

    if (slotResult?.type === 'submit_viewing') {
      const captured = await maybeCaptureViewingLead(sessionId, slotResult.profile);
      const finalized = finalizeViewingCapture(
        captured.profile.viewingRequest,
        captured.result
      );
      const profileForResponse = mergeProfile(captured.profile, {
        viewingRequest: finalized.viewingRequest,
        slotFlow: { awaiting: null, alternatives: null },
      });
      return clarificationResponse(res, {
        reply: finalized.reply,
        profile: profileForResponse,
        conversation,
        message,
        options: finalized.options,
        leadCaptured: finalized.leadCaptured,
      });
    }

    if (slotResult?.type === 'clarify') {
      let profileForResponse = slotResult.profile;
      let leadCaptured = false;
      if (shouldCaptureServiceLead(profileForResponse.serviceInquiry || {})) {
        const captured = await maybeCaptureServiceLead(sessionId, profileForResponse);
        profileForResponse = captured.profile;
        leadCaptured = captured.leadCaptured;
      } else {
        const captured = await maybeCaptureSellLead(sessionId, profileForResponse, message);
        profileForResponse = captured.profile;
        leadCaptured = captured.leadCaptured;
      }
      return clarificationResponse(res, {
        reply: slotResult.reply,
        profile: profileForResponse,
        conversation,
        message,
        options: slotResult.options,
        inputType: slotResult.inputType,
        quickReplies: slotResult.quickReplies,
        leadCaptured,
      });
    }

    if (slotResult?.profile) {
      profile = slotResult.profile;
    }

    if (!isShowMoreRequest(message)) {
      const bedroomGate = bedroomClarifyIfNeeded(message, profile);
      if (bedroomGate) {
        return clarificationResponse(res, {
          reply: bedroomGate.reply,
          profile: bedroomGate.profile,
          conversation,
          message,
          options: bedroomGate.options,
          inputType: bedroomGate.inputType,
          quickReplies: bedroomGate.quickReplies,
        });
      }
    }

    const last = profile.lastSearchFilters || emptySearchFilters();
    const listingReady =
      isListingIntent(profile.intent) ||
      !!(parsePurposeFromMessage(message) || last.purpose || profile.purpose);
    const listingContinuation =
      isShowMoreRequest(message) &&
      (isListingIntent(profile.intent) || !!(profile.purpose || last.purpose));
    const canSearchNow =
      ((slotResult?.type === 'continue' && listingReady) || listingContinuation) &&
      profile.intent !== CONVERSATION_INTENTS.SELL_PROPERTY &&
      profile.intent !== CONVERSATION_INTENTS.PROPERTY_MANAGEMENT;

    if (canSearchNow) {
      const forced = await runForcedPropertySearch({
        sessionId,
        profile,
        userMessage: message,
        previousSearch,
      });
      const forcedReply = String(forced.reply || '').trim() || FRIENDLY_CHAT_ERROR;
      conversation.messages.push({ role: 'user', content: message, createdAt: new Date() });
      conversation.messages.push({ role: 'assistant', content: forcedReply, createdAt: new Date() });
      conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
      conversation.userProfile = forced.profile;
      await conversation.save();

      const payload = {
        reply: forcedReply,
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
        presentation: forced.presentation || null,
        intent: forced.intent || null,
        searchState: forced.searchState || null,
        resultCount: forced.resultCount ?? forced.total ?? 0,
        marketStats: forced.marketStats || null,
        overallMarketStats: forced.overallMarketStats || null,
        marketStatsScope: forced.marketStatsScope || null,
        suggestedActions: forced.suggestedActions || forced.options || null,
        alternativeInventory: forced.alternativeInventory || null,
        inventoryCounts: forced.inventoryCounts || null,
      };
      if (forced.options) {
        payload.requiresClarification = true;
        payload.options = forced.options;
        payload.select = forced.select || PURPOSE_SELECT;
      }
      if (forced.inputType) payload.inputType = forced.inputType;
      if (Array.isArray(forced.quickReplies) && forced.quickReplies.length) {
        payload.quickReplies = forced.quickReplies;
      }
      attachPropertySearchMeta(payload, forced);
      return res.status(200).json(payload);
    }

    // Path C — LLM / tool loop. Path A/B never stream (§1, §10).
    const history = toOpenAIHistory(conversation.messages || []);
    const useSse = shouldUseSse(req);
    const abortController = new AbortController();
    const sse = useSse ? createSseSession(res, abortController.signal) : null;
    let settled = false;
    const onClose = () => {
      // §8 — ignore close after a successful persist (req "close" also fires on normal end).
      if (!settled) abortController.abort();
    };
    req.on('close', onClose);

    try {
      const result = await runModelLoop({
        sessionId,
        userProfile: profile,
        history,
        userMessage: message,
        turnIndex: conversation.messages.length,
        sse,
      });

      throwIfAborted(abortController.signal);

      const reply = String(result.reply || '').trim() || FRIENDLY_CHAT_ERROR;
      const suggestedCta = result.options
        ? null
        : pickSuggestedCta({
            propertyCards: result.propertyCards,
            sources: result.sources,
            leadCaptured: result.leadCaptured || result.profile.leadCaptured,
            turnIndex: conversation.messages.length,
          });

      await persistChatTurn(conversation, {
        message,
        reply,
        profile: result.profile,
      });
      settled = true;

      const payload = buildPathCPayload(result, reply, suggestedCta);

      if (!useSse) {
        return res.status(200).json(payload);
      }

      // Zero-token Path C (in-loop clarification, exhaustion, synthesizeContentReply):
      // emit no token events; full string lives on done.reply (§1, §4.2).
      sse.begin({
        propertyCards: payload.propertyCards,
        sources: payload.sources,
        viewAllMatching: payload.viewAllMatching,
        presentation: payload.presentation || null,
      });
      sse.done(payload);
      if (isResponseOpen(res)) res.end();
      return;
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        // §8 — no persist, no write on a closed connection.
        return;
      }
      if (sse?.started()) {
        // §6 — point of no return: cannot send an HTTP status.
        console.error('POST /api/chat SSE error:', error);
        sse.error({ message: FRIENDLY_CHAT_ERROR, code: 'internal' });
        if (isResponseOpen(res)) res.end();
        return;
      }
      throw error;
    } finally {
      req.off('close', onClose);
    }
  } catch (error) {
    if (isAbortError(error)) return;
    console.error('POST /api/chat error:', error);
    if (res.headersSent) {
      if (isResponseOpen(res)) res.end();
      return;
    }
    const isValidation =
      /validation failed|Path `content` is required/i.test(String(error?.message || ''));
    return res.status(isValidation ? 200 : 500).json({
      success: !isValidation,
      reply: FRIENDLY_CHAT_ERROR,
      message: FRIENDLY_CHAT_ERROR,
      propertyCards: [],
      sources: [],
    });
  }
};

module.exports = { chat };
