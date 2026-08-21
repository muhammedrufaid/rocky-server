const OpenAI = require('openai');
const { Conversation } = require('./chat.models');
const { getSystemPrompt } = require('./chat.prompt');
const { TOOL_DEFINITIONS, executeTool, PURPOSE_OPTIONS, PURPOSE_SELECT, BEDROOM_OPTIONS, SELL_OPTIONS, SELL_SERVICE_LOCATION_OPTIONS, parseSellIntent, isSellCta, isAlreadySharedDetails, parseSellListingDetails, sellClarificationReply, sellFlowOptions, isSellServiceTransitionQuery, isMultiPropertyServiceQuery, parseSellServiceLocationChoice, sellServiceLocationReply, advanceSellListing, emptySellListing, copySellListing, shouldCaptureSellLead, buildSellLeadIntent, hasSellContact, hasServiceContact, emptyServiceInquiry, copyServiceInquiry, seedServiceInquiry, parseServiceContactDetails, parseContactDetails, serviceContactReply, buildServiceLeadIntent, shouldCaptureServiceLead, isServiceInquiryMessage, parsePurposeFromMessage, parseBedroomChoice, applyBedroomChoice, applyBudgetChoice, isBedroomsResolved, isAmbiguousListingQuery, isListingFollowUp, isGeneralKnowledgeQuery, shouldSkipPropertySearch, isVagueConfirm, normalizePropertyType, parseLocationFromMessage, parseLocationReply, wantsDifferentLocation, locationClarificationReply, parseDesiredPropertyType, parsePropertyTypeChange, parseAlternativeChip, parseBudgetFromMessage, parseEmptyResultChoice, emptyResultOptions, emptyResultsReply, nearbyAreaOptions, matchesNamedOption, foundListingsReply, purposeClarificationReply, bedroomsClarificationReply } = require('./chat.tools');

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
      alternatives: current.slotFlow?.alternatives || null,
    },
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
  if (Array.isArray(patch.lastPropertyCards)) {
    next.lastPropertyCards = toStoredPropertyCards(patch.lastPropertyCards);
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
        lastPropertyCards: [],
        lastSearchFilters: emptySearchFilters(),
        slotFlow: { awaiting: null },
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

function leaveSearchSlotForGeneralQuestion(profile) {
  return {
    type: 'delegate',
    profile: mergeProfile(profile, {
      slotFlow: { awaiting: null, alternatives: null },
    }),
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
    };
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
    // Allow type/location corrections mid contact-collection (e.g. "Actually a villa in Arabian Ranches")
    const typeChange = parsePropertyTypeChange(message) || normalizePropertyType(message);
    const locChange = parseLocationFromMessage(message) || parseSellListingDetails(message, {}).location;
    const correctionBits = [];
    let nextPrior = { ...prior };
    if (typeChange) {
      nextPrior.propertyNote = [prior.propertyNote, typeChange].filter(Boolean).join(' — ');
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

  if (!isServiceInquiryMessage(message)) return null;

  const inquiry = seedServiceInquiry(profile.serviceInquiry || {}, sellListing, history, message);
  const hasReferenceLocation = !!(inquiry.referenceLocation || sellListing.location);

  if (hasReferenceLocation && !inquiry.locationScope) {
    return {
      type: 'clarify',
      profile: mergeProfile(profile, {
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

  return {
    type: 'clarify',
    profile: mergeProfile(profile, {
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
    profile.slotFlow?.awaiting === 'serviceContact'
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
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        lastSearchFilters: emptySearchFilters(),
        sellListing: emptySellListing(),
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
      lastSearchFilters: filters,
      sellListing: listing,
      // Keep sellListing.intent locked; clear awaiting only after a completed CTA.
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

  const newType = parsePropertyTypeChange(message) || parseDesiredPropertyType(message);
  const previousLocation = last.location;
  last.location = null;
  if (newType) last.type = newType;
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
  const newType = parsePropertyTypeChange(message);
  if (!newType) return null;

  const last = copySearchFilters(profile.lastSearchFilters || emptySearchFilters());
  // Only treat it as a type change if we already have at least purpose or location in context
  if (!last.purpose && !last.location && !profile.purpose) return null;
  // Do not override if the type is already the same
  if (last.type && last.type.toLowerCase() === newType.toLowerCase() && last.location) return null;

  // If the message mentions a DIFFERENT named location, this is a new-location search, not a
  // type-only refinement. Let it fall through so applyNewLocationSearch can handle it.
  const mentionedLocation = parseLocationFromMessage(message);
  if (mentionedLocation && last.location) {
    const locDiffers = mentionedLocation.trim().toLowerCase() !== last.location.trim().toLowerCase();
    if (locDiffers) return null;
  }

  // Carry purpose from top-level profile into lastSearchFilters so trustedPurpose can read it
  const resolvedPurpose = last.purpose || profile.purpose || null;
  last.type = newType;
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

function resolvePendingSlots(message, profile, history = []) {
  const awaiting = profile.slotFlow?.awaiting;

  const serviceFlow = applyServiceInquiryFlow(message, profile, history);
  if (serviceFlow) return serviceFlow;

  const sellFlow = applySellFlow(message, profile, history);
  if (sellFlow) return sellFlow;

  // "villa in another location" — reset location and keep type/bedrooms/purpose
  const relocation = applyRelocationIntent(message, profile);
  if (relocation) return relocation;

  // Property-type change takes priority over any pending clarification state
  const typeChange = applyPropertyTypeChange(message, profile);
  if (typeChange) return typeChange;

  // New-location search: explicit different location in message → reset and proceed
  const newLocSearch = applyNewLocationSearch(message, profile);
  if (newLocSearch) return newLocSearch;

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
    return {
      type: 'continue',
      profile: mergeProfile(profile, {
        preferredAreas: [named],
        lastSearchFilters: last,
        slotFlow: { awaiting: null, alternatives: null },
      }),
    };
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
  const mentionedLocation = parseLocationFromMessage(message);
  const mentionedType = parseDesiredPropertyType(message) || normalizePropertyType(message);
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
  const typeDiffers =
    !!(mentionedType && last.type) &&
    mentionedType.trim().toLowerCase() !== last.type.trim().toLowerCase();

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

  const newFilters = {
    location: resolvedLocation,
    type: mentionedType || (locDiffers ? null : last.type) || null,
    bedrooms: null,
    bedroomsMin: null,
    bedroomsAny: bedsFromMsg?.any === true,
    bedroomsResolved: !!(bedsFromMsg && !bedsFromMsg.any) || bedsFromMsg?.any === true,
    budgetMin: null,
    budgetMax: null,
    purpose: resolvedPurpose,
  };

  if (bedsFromMsg && !bedsFromMsg.any) {
    if (bedsFromMsg.exact != null) newFilters.bedrooms = bedsFromMsg.exact;
    if (bedsFromMsg.min != null) newFilters.bedroomsMin = bedsFromMsg.min;
  }
  if (budget) {
    if (budget.budgetMin != null) newFilters.budgetMin = budget.budgetMin;
    if (budget.budgetMax != null) newFilters.budgetMax = budget.budgetMax;
  }

  const patch = {
    lastSearchFilters: newFilters,
    slotFlow: { awaiting: null, alternatives: null },
  };
  if (resolvedPurpose) patch.purpose = resolvedPurpose;
  if (resolvedLocation) patch.preferredAreas = [resolvedLocation];

  return {
    type: 'continue',
    profile: mergeProfile(profile, patch),
  };
}

function bedroomClarifyIfNeeded(message, profile) {
  if (parseSellIntent(message) || profile.slotFlow?.awaiting === 'sell' || profile.sellListing?.intent === 'sell') {
    return null;
  }
  if (shouldSkipPropertySearch(message) || isGeneralKnowledgeQuery(message)) return null;
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

async function clarificationResponse(res, { reply, profile, conversation, message, options, leadCaptured = false }) {
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
      reply: result.clarificationReply || emptyResultsReply(filters),
      profile: mergeProfile(nextProfile, { slotFlow: resultSlotFlow }),
      propertyCards: [],
      sources: [],
      suggestedCta: null,
      viewAllMatching: null,
      requiresClarification: true,
      options: responseOpts,
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
  let usedSearchContent = false;
  let usedSearchProperties = false;
  let lastContentChunks = [];
  let searchContentHits = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const hasToolResults = messages.some((m) => m.role === 'tool');
    const contentOnlyReply =
      hasToolResults && usedSearchContent && !usedSearchProperties && propertyCards.length === 0;
    // After a successful content search, force a text answer — models otherwise re-call
    // search_content until MAX_TOOL_ROUNDS and the user sees "could not finish".
    const forceContentAnswer = contentOnlyReply && searchContentHits > 0;
    const completion = await openai.chat.completions.create({
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
      return {
        reply,
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
          emptyClarifyReply = result.clarificationReply || emptyResultsReply(result.effectiveFilters || {});
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
    const { sessionId, message } = req.body;
    const conversation = await loadConversation(sessionId);
    let profile = conversation.userProfile || {};
    const slotResult = resolvePendingSlots(message, profile, conversation.messages || []);

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
    // canSearchNow: fire runForcedPropertySearch whenever a slot was resolved (type-change,
    // new-location, or bedroom/budget choice). runForcedPropertySearch handles the case where
    // bedrooms are still unknown by returning bedroom chips.
    const canSearchNow =
      slotResult?.type === 'continue' &&
      !!(parsePurposeFromMessage(message) || last.purpose || profile.purpose);

    if (canSearchNow) {
      const forced = await runForcedPropertySearch({ sessionId, profile, userMessage: message });
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
