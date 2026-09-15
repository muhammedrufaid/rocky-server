const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt } = require('./chat.prompt');
const {
  emptySlots,
  copySlots,
  hydrateSlots,
  syncSlotsWithFilters,
  deriveSlots,
  nextQuestion,
  shouldBlockQualification,
  applySlotsToSearchFilters,
  appendOptionalFollowUp,
} = require('./chat.qualify');
const { TOOL_DEFINITIONS, executeTool, PURPOSE_OPTIONS, PURPOSE_SELECT, BEDROOM_OPTIONS, SELL_OPTIONS, SELL_SERVICE_LOCATION_OPTIONS, PM_NEED_OPTIONS, CONVERSATION_INTENTS, emptySearchFilters, copySearchFilters, parseSellIntent, isSellCta, isAlreadySharedDetails, parseSellListingDetails, sellClarificationReply, sellFlowOptions, isSellServiceTransitionQuery, isMultiPropertyServiceQuery, parseSellServiceLocationChoice, sellServiceLocationReply, advanceSellListing, emptySellListing, copySellListing, shouldCaptureSellLead, buildSellLeadIntent, hasSellContact, hasServiceContact, emptyServiceInquiry, copyServiceInquiry, seedServiceInquiry, parseServiceContactDetails, parseContactDetails, serviceContactReply, buildServiceLeadIntent, shouldCaptureServiceLead, isServiceInquiryMessage, parsePmNeedChoice, pmNeedReply, pmPropertyReply, hasPmPropertyContext, applyPmPropertyDetails, parseConversationIntent, currentConversationIntent, isExplicitIntentStarter, isPurposeChipReply, isListingIntent, intentToPurpose, purposeToIntent, normalizeIntentValue, startFreshIntent, listingStartReply, listingStartOptions, listingIntakeReply, needsListingIntake, applyMessageToSearchFilters, parsePropertyTypesFromMessage, mergePropertyTypes, typesFromFilters, applyTypesToFilters, isShowMoreRequest, isSimilarPropertyRequest, isSearchContinuation, isPropertyDetailRequest, searchSignatureFromFilters, hasExecutedListingSearch, classifyListingSearchTurn, SEARCH_TURN, exhaustedResultsReply, bedroomChoiceMatches, filtersFromRequestBody, uniqueIdList, parsePurposeFromMessage, parseBedroomChoice, applyBedroomChoice, applyBudgetChoice, isBedroomsResolved, isAmbiguousListingQuery, isListingFollowUp, isGeneralKnowledgeQuery, isContentKnowledgeTopic, shouldSkipPropertySearch, isVagueConfirm, normalizePropertyType, parseLocationFromMessage, parseLocationReply, wantsDifferentLocation, locationClarificationReply, parseDesiredPropertyType, parsePropertyTypeChange, parseAlternativeChip, parseBudgetFromMessage, parseEmptyResultChoice, emptyResultOptions, emptyResultsReply, nearbyAreaOptions, matchesNamedOption, foundListingsReply, purposeClarificationReply, bedroomsClarificationReply } = require('./chat.tools');

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
    location: card.location ?? null,
    purpose: card.purpose ?? null,
    furnished: card.furnished ?? null,
    propertyType: card.propertyType ?? null,
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
    searchAlreadyExecuted: !!current.searchAlreadyExecuted,
    lastSearchSignature: current.lastSearchSignature || null,
    exploredAreas: uniqueIdList(current.exploredAreas),
    lastSearchFilters: copySearchFilters(current.lastSearchFilters || emptySearchFilters()),
    slotFlow: {
      awaiting: current.slotFlow?.awaiting || null,
      alternatives: current.slotFlow?.alternatives || null,
    },
    qualificationSlots: copySlots(current.qualificationSlots || emptySlots()),
    sellListing: copySellListing(current.sellListing || {}),
    serviceInquiry: copyServiceInquiry(current.serviceInquiry || {}),
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
  if (patch.intent) next.intent = patch.intent;
  if (Array.isArray(patch.lastPropertyCards)) {
    next.lastPropertyCards = toStoredPropertyCards(patch.lastPropertyCards);
  }
  if (patch.resetShownPropertyIds) {
    next.shownPropertyIds = [];
  }
  if (Array.isArray(patch.shownPropertyIds)) {
    next.shownPropertyIds = uniqueIdList([...(next.shownPropertyIds || []), ...patch.shownPropertyIds]);
  }
  if (patch.searchAlreadyExecuted === true) next.searchAlreadyExecuted = true;
  if (patch.searchAlreadyExecuted === false) next.searchAlreadyExecuted = false;
  if (patch.lastSearchSignature !== undefined) next.lastSearchSignature = patch.lastSearchSignature || null;
  if (Array.isArray(patch.exploredAreas)) {
    next.exploredAreas = uniqueIdList([...(next.exploredAreas || []), ...patch.exploredAreas]).slice(-20);
  }
  if (patch.resetExploredAreas) next.exploredAreas = [];
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
  if (patch.leadCaptured) next.leadCaptured = true;
  if (patch.qualificationSlots) next.qualificationSlots = copySlots(patch.qualificationSlots);

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
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        exploredAreas: [],
        lastSearchFilters: emptySearchFilters(),
        slotFlow: { awaiting: null },
        qualificationSlots: emptySlots(),
        sellListing: emptySellListing(),
        serviceInquiry: emptyServiceInquiry(),
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
  const resolvedPurpose = purpose || last.purpose || profile.purpose;
  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
      purpose: resolvedPurpose,
      intent: purposeToIntent(resolvedPurpose) || profile.intent,
      lastSearchFilters: last,
      slotFlow: { awaiting: 'bedrooms' },
    }),
    reply: bedroomsClarificationReply(),
    options: BEDROOM_OPTIONS,
  };
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
    const resolvedPurpose = last.purpose || profile.purpose || null;
    if (resolvedPurpose) last.purpose = resolvedPurpose;
    if (mentionedLocation && !last.location) last.location = mentionedLocation;
    const beds = parseBedroomChoice(message);
    if (beds) applyBedroomChoice(last, beds);
    const budget = parseBudgetFromMessage(message);
    if (budget) applyBudgetChoice(last, budget);
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        purpose: resolvedPurpose || profile.purpose,
        preferredAreas: last.location ? [last.location] : undefined,
        lastSearchFilters: last,
        slotFlow: { awaiting: null, alternatives: null },
      }),
    };
  }

  const newType = parsePropertyTypeChange(message) || (incoming.length === 1 ? incoming[0] : null);
  if (!newType) return null;

  const currentTypes = typesFromFilters(last);
  if (currentTypes.length === 1 && currentTypes[0].toLowerCase() === newType.toLowerCase() && last.location) {
    return null;
  }

  const resolvedPurpose = last.purpose || profile.purpose || null;
  applyTypesToFilters(last, mergePropertyTypes(currentTypes, [newType], message));
  last.purpose = resolvedPurpose;

  // Named area while location is empty (e.g. after "somewhere else"): keep bedrooms and search
  if (mentionedLocation && !last.location) {
    last.location = mentionedLocation;
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        preferredAreas: [mentionedLocation],
        lastSearchFilters: last,
        slotFlow: { awaiting: null, alternatives: null },
      }),
    };
  }

  // Type change with no current location: ask for area, do not search
  if (!last.location) {
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

  return {
    type: 'continue',
    profile: mergeProfile(profile, {
      lastSearchFilters: last,
      slotFlow: { awaiting: null },
    }),
  };
}

function applyShowMore(message, profile) {
  if (isPropertyDetailRequest(message)) return null;
  if (!hasExecutedListingSearch(profile)) return null;
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  const turnKind = classifyListingSearchTurn({
    userMessage: message,
    lastSearchFilters: last,
    searchAlreadyExecuted: profile.searchAlreadyExecuted,
    lastSearchSignature: profile.lastSearchSignature,
    shownPropertyIds: profile.shownPropertyIds,
    lastPropertyCards: profile.lastPropertyCards,
  });
  if (
    turnKind === SEARCH_TURN.PROPERTY_DETAILS ||
    turnKind === SEARCH_TURN.FILTER_UPDATE ||
    turnKind === SEARCH_TURN.NEW_AREA ||
    turnKind === SEARCH_TURN.SIMILAR
  ) {
    return null;
  }
  const loc = parseLocationFromMessage(message);
  if (loc && last.location && loc.trim().toLowerCase() !== last.location.trim().toLowerCase()) {
    return null;
  }
  if (
    !isShowMoreRequest(message) &&
    !isSearchContinuation(message, last, { searchAlreadyExecuted: true })
  ) {
    return null;
  }
  const intent = profile.intent || purposeToIntent(profile.purpose || last.purpose);
  if (!isListingIntent(intent) && !last.purpose && !profile.purpose) {
    return null;
  }
  return {
    type: 'continue',
    profile: mergeProfile(profile, {
      slotFlow: { awaiting: null, alternatives: null },
    }),
  };
}

function applyPropertyDetailRequest(message, profile) {
  if (!isPropertyDetailRequest(message)) return null;
  if (!(profile.lastPropertyCards || []).length && !profile.searchAlreadyExecuted) return null;
  return {
    type: 'details',
    profile,
  };
}

function applySimilarProperties(message, profile) {
  if (!isSimilarPropertyRequest(message)) return null;
  if (!hasExecutedListingSearch(profile)) return null;
  return {
    type: 'continue',
    profile: mergeProfile(profile, {
      slotFlow: { awaiting: null, alternatives: null },
    }),
  };
}

function applyCtaFilterChoice(message, profile) {
  if (!hasExecutedListingSearch(profile)) return null;
  const choice = parseEmptyResultChoice(message);
  if (!choice) return null;
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (choice.nearby) {
    const options = nearbyAreaOptions(last.location, [
      ...(profile.exploredAreas || []),
      last.location,
    ]);
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        lastSearchFilters: last,
        exploredAreas: last.location ? [last.location] : [],
        slotFlow: { awaiting: 'nearbyArea', alternatives: null },
      }),
      reply: options.length
        ? 'Which nearby area should I try?'
        : 'I have already tried the nearby areas. Would you like to try a different bedroom count or adjust the budget?',
      options: options.length ? options : emptyResultOptions(last, [...(profile.exploredAreas || []), last.location]),
    };
  }
  if (choice.budget) {
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
        lastSearchFilters: last,
        slotFlow: { awaiting: 'budget', alternatives: null },
      }),
      reply: 'What is your maximum budget in AED?',
    };
  }
  if (choice.bedrooms) {
    applyBedroomChoice(last, choice.bedrooms);
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        lastSearchFilters: last,
        resetShownPropertyIds: true,
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        lastPropertyCards: [],
        slotFlow: { awaiting: null, alternatives: null },
      }),
    };
  }
  return null;
}

function applyListingFilterUpdate(message, profile) {
  if (isPropertyDetailRequest(message) || isShowMoreRequest(message) || isSimilarPropertyRequest(message)) {
    return null;
  }
  // Content questions that happen to contain "in Dubai" must not become a new-area listing search.
  if (shouldSkipPropertySearch(message) || isGeneralKnowledgeQuery(message)) return null;
  if (!hasExecutedListingSearch(profile)) return null;
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (!last.purpose && !last.location && !typesFromFilters(last).length && !isListingIntent(profile.intent)) {
    return null;
  }
  const turnKind = classifyListingSearchTurn({
    userMessage: message,
    lastSearchFilters: last,
    searchAlreadyExecuted: profile.searchAlreadyExecuted,
    lastSearchSignature: profile.lastSearchSignature,
    shownPropertyIds: profile.shownPropertyIds,
    lastPropertyCards: profile.lastPropertyCards,
  });
  if (turnKind !== SEARCH_TURN.FILTER_UPDATE && turnKind !== SEARCH_TURN.NEW_AREA) return null;

  const beds = parseBedroomChoice(message);
  const loc = parseLocationFromMessage(message) || parseLocationReply(message);
  const types = parsePropertyTypesFromMessage(message);
  const emptyChoice = parseEmptyResultChoice(message);
  const budget = parseBudgetFromMessage(message);
  const furnished = parseFurnishedFromMessage(message);
  const next = copySearchFilters(last);
  let changed = false;

  // A furnishing answer is a refinement of the current search, not a new topic.
  if (furnished && String(furnished).toLowerCase() !== String(last.furnished || '').toLowerCase()) {
    next.furnished = furnished;
    changed = true;
  }

  if (emptyChoice?.bedrooms && !bedroomChoiceMatches(last, emptyChoice.bedrooms)) {
    applyBedroomChoice(next, emptyChoice.bedrooms);
    changed = true;
  } else if (beds && !bedroomChoiceMatches(last, beds)) {
    applyBedroomChoice(next, beds);
    changed = true;
  }
  if (loc && (!last.location || loc.trim().toLowerCase() !== last.location.trim().toLowerCase())) {
    next.location = loc;
    changed = true;
  }
  if (types.length) {
    const lastTypes = typesFromFilters(last);
    if (types.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase()) {
      applyTypesToFilters(next, types);
      changed = true;
    }
  }
  if (
    budget &&
    (budget.any ||
      (budget.budgetMax != null && Number(budget.budgetMax) !== Number(last.budgetMax)) ||
      (budget.budgetMin != null && Number(budget.budgetMin) !== Number(last.budgetMin)))
  ) {
    applyBudgetChoice(next, budget);
    changed = true;
  }
  if (!changed) return null;

  const resolvedPurpose = next.purpose || profile.purpose || intentToPurpose(profile.intent);
  if (resolvedPurpose) next.purpose = resolvedPurpose;

  const patch = {
    lastSearchFilters: next,
    slotFlow: { awaiting: null, alternatives: null },
    resetShownPropertyIds: true,
    searchAlreadyExecuted: false,
    lastSearchSignature: null,
    lastPropertyCards: [],
    exploredAreas: last.location ? [last.location] : [],
  };
  if (resolvedPurpose) {
    patch.purpose = resolvedPurpose;
    patch.intent = purposeToIntent(resolvedPurpose);
  }
  if (next.location) patch.preferredAreas = [next.location];
  if (next.bedrooms != null) patch.bedrooms = next.bedrooms;
  else if (next.bedroomsMin != null) patch.bedrooms = next.bedroomsMin;

  return {
    type: 'continue',
    profile: mergeProfile(profile, patch),
  };
}

function applyConversationIntent(message, profile, explicitIntent = null) {
  const requestedIntent = normalizeIntentValue(explicitIntent);
  const detected = requestedIntent || parseConversationIntent(message);
  if (!detected) return null;

  const current = currentConversationIntent(profile);
  const starter = isExplicitIntentStarter(message);
  const awaitingPurpose = profile.slotFlow?.awaiting === 'purpose';

  if (awaitingPurpose && isPurposeChipReply(message) && isListingIntent(detected) && !starter) {
    return null;
  }

  const switching = !!(current && detected !== current);
  const restart = starter;
  if (!switching && !restart && current === detected) return null;

  const nextProfile = startFreshIntent(detected, message, profile);
  const reply = listingStartReply(detected, nextProfile, message);
  const options = listingStartOptions(detected, nextProfile, message);

  if (isListingIntent(detected)) {
    nextProfile.slotFlow = { awaiting: null, alternatives: null };
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

function resolvePendingSlots(message, profile, history = [], explicitIntent = null) {
  const intentGate = applyConversationIntent(message, profile, explicitIntent);
  if (intentGate) return intentGate;

  const awaiting = profile.slotFlow?.awaiting;

  const serviceFlow = applyServiceInquiryFlow(message, profile, history);
  if (serviceFlow) return serviceFlow;

  const sellFlow = applySellFlow(message, profile, history);
  if (sellFlow) return sellFlow;

  const propertyDetail = applyPropertyDetailRequest(message, profile);
  if (propertyDetail) return propertyDetail;

  const similar = applySimilarProperties(message, profile);
  if (similar) return similar;

  const ctaChoice = applyCtaFilterChoice(message, profile);
  if (ctaChoice) return ctaChoice;

  const showMore = applyShowMore(message, profile);
  if (showMore) return showMore;

  // "villa in another location" — reset location and keep type/bedrooms/purpose
  const relocation = applyRelocationIntent(message, profile);
  if (relocation) return relocation;

  // Property-type change takes priority over any pending clarification state
  const typeChange = applyPropertyTypeChange(message, profile);
  if (typeChange) return typeChange;

  // New-location search: explicit different location in message → reset and proceed
  const newLocSearch = applyNewLocationSearch(message, profile);
  if (newLocSearch) return newLocSearch;

  const filterUpdate = applyListingFilterUpdate(message, profile);
  if (filterUpdate) return filterUpdate;

  if (!awaiting) return null;

  if (awaiting === 'listingIntake') {
    const last = applyMessageToSearchFilters(
      copySearchFilters(profile.lastSearchFilters || emptySearchFilters()),
      message
    );
    const purpose = last.purpose || profile.purpose || intentToPurpose(profile.intent);
    if (purpose) last.purpose = purpose;
    const hasAnchor = !!(last.location || typesFromFilters(last).length || isBedroomsResolved(last));
    if (!hasAnchor) {
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          purpose,
          lastSearchFilters: last,
          slotFlow: { awaiting: 'listingIntake', alternatives: null },
        }),
        reply: listingIntakeReply(profile.intent, last),
      };
    }
    const nextProfile = mergeProfile(profile, {
      purpose,
      intent: profile.intent || purposeToIntent(purpose),
      preferredAreas: last.location ? [last.location] : undefined,
      bedrooms: last.bedrooms ?? last.bedroomsMin ?? profile.bedrooms,
      lastSearchFilters: last,
      slotFlow: { awaiting: null, alternatives: null },
    });
    if (!isBedroomsResolved(last) && (last.location || typesFromFilters(last).length)) {
      return bedroomClarifyPayload(nextProfile, purpose);
    }
    return { type: 'continue', profile: nextProfile };
  }

  if (awaiting === 'purpose') {
    const purpose = parsePurposeFromMessage(message);
    if (!purpose) return null;

    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    last.purpose = purpose;
    if (!isBedroomsResolved(last)) {
      return bedroomClarifyPayload(
        mergeProfile(profile, {
          purpose,
          intent: purposeToIntent(purpose),
          lastSearchFilters: last,
        }),
        purpose
      );
    }

    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        purpose,
        intent: purposeToIntent(purpose),
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
      }),
    };
  }

  if (awaiting === 'bedrooms') {
    const choice = parseBedroomChoice(message);
    if (!choice) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
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
      const options = nearbyAreaOptions(last.location, [
        ...(profile.exploredAreas || []),
        last.location,
      ]);
      return {
        type: 'clarify',
        profile: mergeProfile(profile, {
          lastSearchFilters: last,
          exploredAreas: last.location ? [last.location] : [],
          slotFlow: { awaiting: 'nearbyArea' },
        }),
        reply: options.length
          ? 'Which nearby area should I try?'
          : 'I have already tried the nearby areas. Would you like to try a different bedroom count or adjust the budget?',
        options: options.length ? options : emptyResultOptions(last, [...(profile.exploredAreas || []), last.location]),
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
      const patch = {
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
        resetShownPropertyIds: true,
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        lastPropertyCards: [],
      };
      if (emptyChoice.bedrooms.exact != null) patch.bedrooms = emptyChoice.bedrooms.exact;
      if (emptyChoice.bedrooms.min != null) patch.bedrooms = emptyChoice.bedrooms.min;
      return { type: 'continue', profile: mergeProfile(profile, patch) };
    }

    const typedBeds = parseBedroomChoice(message);
    if (typedBeds && !isVagueConfirm(message) && !bedroomChoiceMatches(last, typedBeds)) {
      applyBedroomChoice(last, typedBeds);
      const bedPatch = {
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
        resetShownPropertyIds: true,
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        lastPropertyCards: [],
      };
      return {
        type: 'continue',
        profile: mergeProfile(profile, bedPatch),
      };
    }

    if (!isVagueConfirm(message) && !isListingFollowUp(message) && !isSearchContinuation(message, last, { searchAlreadyExecuted: hasExecutedListingSearch(profile) })) {
      return leaveSearchSlotForGeneralQuestion(profile);
    }

    if (hasExecutedListingSearch(profile)) {
      return {
        type: 'clarify',
        profile,
        reply: exhaustedResultsReply(last, (profile.shownPropertyIds || []).length || (profile.lastPropertyCards || []).length),
        options: emptyResultOptions(last, [...(profile.exploredAreas || []), last.location]),
      };
    }

    return {
      type: 'clarify',
      profile,
      reply: emptyResultsReply(last),
      options: emptyResultOptions(last, [...(profile.exploredAreas || []), last.location]),
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
          : hasExecutedListingSearch(profile)
            ? exhaustedResultsReply(
                copySearchFilters(profile.lastSearchFilters || emptySearchFilters()),
                (profile.shownPropertyIds || []).length || (profile.lastPropertyCards || []).length
              )
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
    const previousLocation = last.location;
    const options = nearbyAreaOptions(last.location, [
      ...(profile.exploredAreas || []),
      last.location,
    ]);
    const named = matchesNamedOption(message, options) || parseLocationReply(message);
    if (!named || isVagueConfirm(message) || wantsDifferentLocation(message)) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
      return {
        type: 'clarify',
        profile,
        reply: locationClarificationReply(),
        options: options.length ? options : nearbyAreaOptions(last.location),
      };
    }
    last.location = named;
    const resolvedPurpose = last.purpose || profile.purpose || null;
    if (resolvedPurpose) last.purpose = resolvedPurpose;
    const areaChanged =
      !previousLocation || previousLocation.trim().toLowerCase() !== named.trim().toLowerCase();
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        preferredAreas: [named],
        lastSearchFilters: last,
        slotFlow: { awaiting: null, alternatives: null },
        ...(areaChanged && hasExecutedListingSearch(profile)
          ? {
              resetShownPropertyIds: true,
              searchAlreadyExecuted: false,
              lastSearchSignature: null,
              lastPropertyCards: [],
              exploredAreas: previousLocation ? [previousLocation, named] : [named],
            }
          : {}),
      }),
    };
  }

  if (awaiting === 'nearbyArea') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const previousLocation = last.location;
    const options = nearbyAreaOptions(previousLocation, [
      ...(profile.exploredAreas || []),
      previousLocation,
    ]);
    const named = matchesNamedOption(message, options) || parseLocationReply(message);
    if (!named || isVagueConfirm(message)) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
      return {
        type: 'clarify',
        profile,
        reply: options.length
          ? 'Which nearby area should I try?'
          : 'I have already tried the nearby areas. Would you like to try a different bedroom count or adjust the budget?',
        options: options.length ? options : emptyResultOptions(last, [...(profile.exploredAreas || []), previousLocation]),
      };
    }
    last.location = named;
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        preferredAreas: [named],
        lastSearchFilters: last,
        slotFlow: { awaiting: null },
        resetShownPropertyIds: true,
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        lastPropertyCards: [],
        exploredAreas: previousLocation ? [previousLocation, named] : [named],
      }),
    };
  }

  if (awaiting === 'budget') {
    const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
    const budget = parseBudgetFromMessage(message, { requireBudgetContext: true });
    if (!budget) {
      if (!isVagueConfirm(message) && !isListingFollowUp(message)) {
        return leaveSearchSlotForGeneralQuestion(profile);
      }
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
        resetShownPropertyIds: true,
        searchAlreadyExecuted: false,
        lastSearchSignature: null,
        lastPropertyCards: [],
      }),
    };
  }

  return null;
}

/**
 * Detects a new-location listing search ("Show me villas in Dubai Hills",
 * "Buy villas in Arabian Ranches under 5 million", etc.) when we already have
 * a prior location in context, and the message explicitly names a DIFFERENT
 * location — or when we are stuck in empty-results/alternatives and the user
 * issues a fresh listing search (including same area, different type).
 *
 * When matched, returns a `{ type: 'continue', profile }` result that:
 *   - Updates location and type from the message
 *   - Resets bedrooms (unknown → will trigger bedroom chips)
 *   - Resets budget unless stated in the message
 *   - Preserves purpose via the existing trustedPurpose rule
 *     (purpose from message if stated, else stored purpose)
 *
 * Returns null if the message isn't a new-location search.
 */
function applyNewLocationSearch(message, profile) {
  if (wantsDifferentLocation(message)) return null;
  if (isSimilarPropertyRequest(message) || isPropertyDetailRequest(message)) return null;
  if (shouldSkipPropertySearch(message) || isGeneralKnowledgeQuery(message)) return null;
  const lastForGate = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  if (
    hasExecutedListingSearch(profile) &&
    (isShowMoreRequest(message) ||
      isSearchContinuation(message, lastForGate, { searchAlreadyExecuted: true }))
  ) {
    return null;
  }
  const mentionedLocation = parseLocationFromMessage(message);
  const mentionedTypes = parsePropertyTypesFromMessage(message);
  const purposeFromMsg = parsePurposeFromMessage(message);
  const bedsFromMsg = parseBedroomChoice(message);
  const budget = parseBudgetFromMessage(message);

  // Must look like a listing search (type nouns include plurals; Buy/Rent verbs count too)
  const looksLikeListing =
    /\b(show|find|search|looking|buy|purchase|rent|lease|for\s+sale|apartments?|villas?|townhouses?|penthouses?|duplexes?|studios?|flats?|propert(?:y|ies)|homes?|listings?)\b/i.test(
      message
    );
  if (!looksLikeListing && !purposeFromMsg) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  const awaiting = profile.slotFlow?.awaiting;
  const inEmptySlot = awaiting === 'emptyResults' || awaiting === 'alternatives';

  // Only activate if we already have a prior location — avoids triggering on
  // the very first search message in a session — unless escaping empty results.
  if (!last.location && !inEmptySlot) return null;

  const locDiffers =
    !!(mentionedLocation && last.location) &&
    mentionedLocation.trim().toLowerCase() !== last.location.trim().toLowerCase();
  const mentionedType = mentionedTypes[0] || null;
  const lastTypes = typesFromFilters(last);
  const typeDiffers =
    mentionedTypes.length > 0 &&
    mentionedTypes.join('|').toLowerCase() !== lastTypes.join('|').toLowerCase();

  // Escape empty-results with a fresh listing statement even if location is unchanged.
  const freshEscape =
    inEmptySlot &&
    !!(mentionedLocation || last.location) &&
    !!(purposeFromMsg || mentionedType || bedsFromMsg || budget);

  if (!locDiffers && !typeDiffers && !freshEscape) return null;
  if (!mentionedLocation && !locDiffers && !(inEmptySlot && last.location && (typeDiffers || purposeFromMsg))) {
    return null;
  }

  const resolvedLocation = mentionedLocation || last.location;
  if (!resolvedLocation) return null;

  // Resolve purpose: explicit in message > stored purpose (existing rule: persist across location change)
  const resolvedPurpose = purposeFromMsg || last.purpose || profile.purpose || null;

  const newFilters = copySearchFilters(last);
  newFilters.location = resolvedLocation;
  newFilters.purpose = resolvedPurpose;
  if (mentionedTypes.length) applyTypesToFilters(newFilters, mentionedTypes);

  if (bedsFromMsg) {
    applyBedroomChoice(newFilters, bedsFromMsg);
  }
  if (budget) {
    applyBudgetChoice(newFilters, budget);
  }

  const patch = {
    lastSearchFilters: newFilters,
    slotFlow: { awaiting: null, alternatives: null },
    resetShownPropertyIds: locDiffers || typeDiffers,
    searchAlreadyExecuted: false,
    lastSearchSignature: null,
    lastPropertyCards: locDiffers || typeDiffers ? [] : undefined,
    exploredAreas: locDiffers && last.location ? [last.location, resolvedLocation] : undefined,
  };
  if (resolvedPurpose) {
    patch.purpose = resolvedPurpose;
    patch.intent = purposeToIntent(resolvedPurpose);
  }
  if (resolvedLocation) patch.preferredAreas = [resolvedLocation];

  return {
    type: 'continue',
    profile: mergeProfile(profile, patch),
  };
}

function bedroomClarifyIfNeeded(message, profile) {
  if (
    parseSellIntent(message) ||
    profile.slotFlow?.awaiting === 'sell' ||
    profile.slotFlow?.awaiting === 'listingIntake' ||
    profile.slotFlow?.awaiting === 'pmNeed' ||
    profile.slotFlow?.awaiting === 'pmProperty' ||
    profile.sellListing?.intent === 'sell' ||
    profile.intent === CONVERSATION_INTENTS.SELL_PROPERTY ||
    profile.intent === CONVERSATION_INTENTS.PROPERTY_MANAGEMENT
  ) {
    return null;
  }
  if (shouldSkipPropertySearch(message) || isGeneralKnowledgeQuery(message)) return null;
  if (parseBedroomChoice(message)) return null;
  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  const purpose =
    parsePurposeFromMessage(message) ||
    last.purpose ||
    profile.purpose ||
    intentToPurpose(profile.intent) ||
    null;
  if (!purpose) return null;
  if (isBedroomsResolved(last)) return null;
  if (!last.location && !typesFromFilters(last).length) return null;
  const listingLike =
    isAmbiguousListingQuery(message) ||
    !!parsePurposeFromMessage(message) ||
    profile.slotFlow?.awaiting === 'bedrooms' ||
    isListingIntent(profile.intent);
  if (!listingLike) return null;
  last.purpose = purpose;
  return bedroomClarifyPayload(
    mergeProfile(profile, {
      purpose,
      intent: purposeToIntent(purpose),
      lastSearchFilters: last,
    }),
    purpose
  );
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

async function clarificationResponse(res, { reply, profile, conversation, message, options, leadCaptured = false, qualification = null }) {
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
  if (qualification) body.qualification = qualification;
  return res.status(200).json(body);
}

async function runForcedPropertySearch({ sessionId, profile, userMessage }) {
  // Slots were already derived and persisted for this turn by chat().
  const slots = syncSlotsWithFilters(profile.qualificationSlots, profile.lastSearchFilters);
  const block = shouldBlockQualification(slots, profile, userMessage);
  if (block) {
    slots.askedCount = (Number(slots.askedCount) || 0) + 1;
    const question = nextQuestion(slots);
    const nextProfile = mergeProfile(profile, {
      qualificationSlots: slots,
      lastSearchFilters: applySlotsToSearchFilters(profile.lastSearchFilters, slots),
    });
    return {
      reply: question?.question || purposeClarificationReply(),
      profile: nextProfile,
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: question?.options || [],
      select: PURPOSE_SELECT,
      qualification: { slots, question },
    };
  }

  const preparedFilters = applySlotsToSearchFilters(profile.lastSearchFilters, slots, { unblocking: true });
  profile = mergeProfile(profile, {
    qualificationSlots: slots,
    lastSearchFilters: preparedFilters,
  });

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
      searchAlreadyExecuted: profile.searchAlreadyExecuted,
      lastSearchSignature: profile.lastSearchSignature,
      lastPropertyCards: profile.lastPropertyCards,
      exploredAreas: profile.exploredAreas,
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
  nextProfile = mergeProfile(nextProfile, { qualificationSlots: slots });

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
      qualification: { slots, question: null },
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
      qualification: { slots, question: null },
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
      qualification: { slots, question: null },
    };
  }

  if (result.needsEmptyResults || !(result.propertyCards || []).length) {
    const filters = result.effectiveFilters || nextProfile.lastSearchFilters || {};
    // Forward the slotFlow from the result (includes awaiting + alternatives JSON)
    const resultSlotFlow = result.profilePatch?.slotFlow || { awaiting: 'emptyResults' };
    const hasOpts = Array.isArray(result.options) && result.options.length > 0;
    const responseOpts = hasOpts ? result.options : emptyResultOptions(filters);
    return {
      reply:
        result.clarificationReply ||
        (hasExecutedListingSearch(nextProfile)
          ? exhaustedResultsReply(
              filters,
              (nextProfile.shownPropertyIds || []).length || (nextProfile.lastPropertyCards || []).length
            )
          : emptyResultsReply(filters)),
      profile: mergeProfile(nextProfile, { slotFlow: resultSlotFlow }),
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: responseOpts,
      select: PURPOSE_SELECT,
      qualification: { slots, question: null },
    };
  }

  const listingReply =
    result.replyOverride ||
    foundListingsReply(result.effectiveFilters || nextProfile.lastSearchFilters, result.modelPayload?.total);
  const follow = appendOptionalFollowUp(
    listingReply,
    syncSlotsWithFilters(slots, result.effectiveFilters || nextProfile.lastSearchFilters)
  );
  return {
    reply: follow.reply,
    profile: mergeProfile(nextProfile, {
      slotFlow: { awaiting: null },
      qualificationSlots: follow.slots,
    }),
    propertyCards: uniqueBy(result.propertyCards || [], (c) => c.id),
    sources: result.sources || [],
    suggestedCta: null,
    viewAllMatching: result.viewAllMatching || null,
    qualification: { slots: follow.slots, question: follow.question },
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
  let usedSearchContent = false;
  let usedSearchProperties = false;
  let lastContentChunks = [];
  let searchContentHits = 0;
  let pendingQualification = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const hasToolResults = messages.some((m) => m.role === 'tool');
    const contentOnlyReply =
      hasToolResults && usedSearchContent && !usedSearchProperties && propertyCards.length === 0;
    // After a successful content search, force a text answer — models otherwise re-call
    // search_content until MAX_TOOL_ROUNDS and the user sees "could not finish".
    const forceContentAnswer = contentOnlyReply && searchContentHits > 0;
    const forceContentSearch = !forceContentAnswer && round === 0 && isContentKnowledgeTopic(userMessage);
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: forceContentAnswer
        ? 'none'
        : forceContentSearch
          ? { type: 'function', function: { name: 'search_content' } }
          : 'auto',
      max_completion_tokens: contentOnlyReply
        ? CONTENT_REPLY_MAX_TOKENS
        : hasToolResults
          ? REPLY_MAX_TOKENS
          : TOOL_MAX_TOKENS,
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
      let reply = String(msg.content || '').trim();
      if (!reply && usedSearchContent) {
        reply = synthesizeContentReply(lastContentChunks, sources) || FRIENDLY_CHAT_ERROR;
      }
      if (!reply) {
        reply = FRIENDLY_CHAT_ERROR;
      }
      const cards = uniqueBy(propertyCards, (c) => c.id);
      const out = {
        reply,
        propertyCards: cards,
        sources: uniqueBy(sources, (s) => s.url || s.title),
        leadCaptured,
        profile,
        viewAllMatching,
      };
      if (pendingQualification) {
        out.qualification = pendingQualification;
        out.requiresClarification = true;
        out.options = pendingQualification.question?.options || [];
        out.select = PURPOSE_SELECT;
      } else if (cards.length) {
        const follow = appendOptionalFollowUp(
          reply,
          syncSlotsWithFilters(profile.qualificationSlots, profile.lastSearchFilters)
        );
        out.reply = follow.reply;
        profile = mergeProfile(profile, { qualificationSlots: follow.slots });
        out.profile = profile;
        out.qualification = { slots: follow.slots, question: follow.question };
      }
      return out;
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

      if (call.function?.name === 'search_properties') {
        const slots = syncSlotsWithFilters(
          hydrateSlots(profile.qualificationSlots, profile.lastSearchFilters),
          profile.lastSearchFilters
        );
        if (shouldBlockQualification(slots, profile, userMessage)) {
          slots.askedCount = (Number(slots.askedCount) || 0) + 1;
          const question = nextQuestion(slots);
          profile = mergeProfile(profile, {
            qualificationSlots: slots,
            lastSearchFilters: applySlotsToSearchFilters(profile.lastSearchFilters, slots),
          });
          pendingQualification = { slots, question };
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              count: 0,
              skipped: true,
              qualificationSlots: slots,
              question: question?.question,
              instruction: `Rephrase ONLY this question and nothing else: "${question?.question || ''}". Never invent a different question. Never ask about a slot that already has a value (including "any").`,
            }),
          });
          continue;
        }
        profile = mergeProfile(profile, {
          qualificationSlots: slots,
          lastSearchFilters: applySlotsToSearchFilters(profile.lastSearchFilters, slots, { unblocking: true }),
        });
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
          searchAlreadyExecuted: profile.searchAlreadyExecuted,
          lastSearchSignature: profile.lastSearchSignature,
          lastPropertyCards: profile.lastPropertyCards,
          exploredAreas: profile.exploredAreas,
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
        if (result.modelPayload?.skipped) {
          lastSearchNeedsPurpose = false;
          lastSearchNeedsBedrooms = false;
          lastSearchNeedsEmptyResults = false;
        } else if (result.needsEmptyResults || result.modelPayload?.needsEmptyResults) {
          lastSearchNeedsEmptyResults = true;
          emptyClarifyReply =
            result.clarificationReply ||
            (hasExecutedListingSearch(profile)
              ? exhaustedResultsReply(
                  result.effectiveFilters || profile.lastSearchFilters || {},
                  (profile.shownPropertyIds || []).length || (profile.lastPropertyCards || []).length
                )
              : emptyResultsReply(result.effectiveFilters || {}));
          const hasAltOpts = Array.isArray(result.options) && result.options.length > 0;
          emptyClarifyOptions = hasAltOpts ? result.options : emptyResultOptions(result.effectiveFilters || {});
          if (result.effectiveFilters) {
            const emptySlotFlow = result.profilePatch?.slotFlow || { awaiting: 'emptyResults' };
            profile = mergeProfile(profile, {
              lastSearchFilters: result.effectiveFilters,
              slotFlow: emptySlotFlow,
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
        reply:
          emptyClarifyReply ||
          (hasExecutedListingSearch(profile)
            ? exhaustedResultsReply(
                profile.lastSearchFilters || {},
                (profile.shownPropertyIds || []).length || (profile.lastPropertyCards || []).length
              )
            : emptyResultsReply(profile.lastSearchFilters || {})),
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
  };
}

const chat = async (req, res) => {
  try {
    const { sessionId, message, intent: bodyIntent } = req.body;
    const conversation = await loadConversation(sessionId);
    let profile = conversation.userProfile || {};
    const requestTypes = filtersFromRequestBody(req.body);
    if (requestTypes.length) {
      const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
      applyTypesToFilters(last, mergePropertyTypes(typesFromFilters(last), requestTypes, message));
      profile = mergeProfile(profile, { lastSearchFilters: last });
    }
    const slotResult = resolvePendingSlots(
      message,
      profile,
      conversation.messages || [],
      bodyIntent
    );

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
        leadCaptured,
      });
    }

    if (slotResult?.profile) {
      profile = slotResult.profile;
    }

    const last = profile.lastSearchFilters || emptySearchFilters();
    const listingReady =
      isListingIntent(profile.intent) ||
      !!(parsePurposeFromMessage(message) || last.purpose || profile.purpose);
    const listingQualify =
      listingReady &&
      !shouldSkipPropertySearch(message) &&
      profile.intent !== CONVERSATION_INTENTS.SELL_PROPERTY &&
      profile.intent !== CONVERSATION_INTENTS.PROPERTY_MANAGEMENT;

    if (!listingQualify) {
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
    }

    // One derive per turn, persisted immediately, so an answer is never asked for twice
    // even when this turn does not end in a search.
    if (listingQualify) {
      const derived = deriveSlots(
        [...(conversation.messages || []), { role: 'user', content: message }],
        hydrateSlots(profile.qualificationSlots, profile.lastSearchFilters)
      );
      profile = mergeProfile(profile, {
        qualificationSlots: syncSlotsWithFilters(derived, profile.lastSearchFilters),
      });
    }

    const canSearchNow =
      slotResult?.type === 'continue' && listingQualify;

    if (canSearchNow) {
      const forced = await runForcedPropertySearch({
        sessionId,
        profile,
        userMessage: message,
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
      };
      if (forced.qualification) payload.qualification = forced.qualification;
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

    const reply =
      String(result.reply || '').trim() ||
      FRIENDLY_CHAT_ERROR;
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
    if (result.qualification) payload.qualification = result.qualification;
    if (result.options) {
      payload.requiresClarification = true;
      payload.options = result.options;
      payload.select = result.select || PURPOSE_SELECT;
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error('POST /api/chat error:', error);
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
