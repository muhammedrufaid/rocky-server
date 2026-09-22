/**
 * Single AI chatbot test file.
 * Run: node --test src/ai/chat.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSellIntent,
  parsePurposeFromMessage,
  parseSellListingDetails,
  sellClarificationReply,
  shouldSkipPropertySearch,
  isListingFollowUp,
  isAmbiguousListingQuery,
  advanceSellListing,
  emptySellListing,
  isAlreadySharedDetails,
  isSellCta,
  hasSellContact,
  shouldCaptureSellLead,
  sellFlowOptions,
  SELL_SERVICE_LOCATION_OPTIONS,
  isSellServiceTransitionQuery,
  isMultiPropertyServiceQuery,
  parseSellServiceLocationChoice,
  sellServiceLocationReply,
  isGeneralKnowledgeQuery,
  isServiceInquiryMessage,
  serviceContactPromptBlock,
  serviceContactReply,
  seedServiceInquiry,
  hasServiceContact,
  parseServiceContactDetails,
  parseLocationFromMessage,
  parseLocationReply,
  wantsDifferentLocation,
  isUnrestrictedLocationPhrase,
  hasLocationConstraint,
  parseDesiredPropertyType,
  parsePropertyTypeChange,
  rankRelatedContentSources,
  isHomepageUrl,
  emptyResultsReply,
  foundListingsReply,
  locationEmptyNearbyReply,
  CONVERSATION_INTENTS,
  parseConversationIntent,
  isExplicitIntentStarter,
  startFreshIntent,
  shouldResetOnListingIntent,
  hasInProgressListingSearch,
  listingStartReply,
  pmNeedReply,
  PM_NEED_OPTIONS,
  parsePmNeedChoice,
  needsListingIntake,
  applyMessageToSearchFilters,
  extractSearchPatch,
  isExplicitSearchReset,
  buildListingSearchUrl,
  isCurrentListingReference,
  buildSearchAcknowledgement,
  parsePropertyTypesFromMessage,
  parseOtherCustomType,
  mergePropertyTypes,
  typesFromFilters,
  applyTypesToFilters,
  isShowMoreRequest,
  hasActiveListingSearch,
  filtersFromRequestBody,
  uniqueIdList,
  listingQueryOpts,
  resolveEffectiveFilters,
  copySearchFilters,
  emptySearchFilters,
  applyBedroomChoice,
  executeTool,
  isPropertyUiAction,
  SEARCH_OUTCOME,
  formatAed,
  parseBedroomChoice,
  parseBudgetFromMessage,
  isBedroomsResolved,
  purposeClarificationReply,
  bedroomsClarificationReply,
  qualifyListingSearch,
  nextMissingListingSlot,
  isBudgetProvided,
  BUY_BUDGET_OPTIONS,
  RENT_BUDGET_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  moreMatchesOptions,
  exactResultsExhaustedOptions,
  noAdditionalSegmentOptions,
  noAdditionalSegmentReply,
  noInventoryReply,
  noInventoryOptions,
  toPropertyCard,
  viewAllCtaLabel,
  stripExposedUrlsFromReply,
  isResidentialPropertyType,
  isCommercialPropertyType,
  requiresBedroomsForSearch,
  normalizeSearchProfileAfterPatch,
  getRequiredSearchFields,
  getMissingSearchFields,
  purposeOptionsForFilters,
  COMMERCIAL_PURPOSE_OPTIONS,
  applyViewingRequestFlow,
  finalizeViewingCapture,
  parseContactDetails,
  parseViewingContactDetails,
  viewingMissingContactFields,
  isListingSearchOverride,
  viewingFailureReply,
  viewingCloseReply,
  emptyViewingRequest,
  VIEWING_NEUTRAL_OPTIONS,
  VIEWING_WEEKEND_OPTIONS,
} = require('./chat.tools');
const { Lead } = require('./chat.models');
const propertyDbService = require('../services/propertyDbService');

function runSellTurns(messages) {
  let listing = emptySellListing();
  let reply = '';
  const history = [];
  for (const content of messages) {
    listing = advanceSellListing(content, listing, history);
    reply = sellClarificationReply(listing, content);
    history.push({ role: 'user', content });
  }
  return { listing, reply };
}

// --- Intent / search routing ---

test('sell is not treated as buy search', () => {
  assert.equal(parseSellIntent('I need to sell my property'), true);
  assert.equal(parsePurposeFromMessage('I need to sell my property'), null);
  assert.equal(shouldSkipPropertySearch('I need to sell my property'), true);
  assert.equal(parsePurposeFromMessage('Buy'), 'Buy');
});

test('content questions skip property search (flexi rent, summer, golden visa)', () => {
  for (const phrase of [
    'golden visa eligibility',
    'flexi rent',
    'how can we manage our property in summer',
    'is summer the best option to invest in dubai?',
    "What's the latest blog post about Dubai real estate?",
    "What's it like living in JVC?",
    'What services does Rocky Real Estate offer?',
    'Do you help with property management?',
    'Who founded Rocky Real Estate?',
  ]) {
    assert.equal(isGeneralKnowledgeQuery(phrase), true, phrase);
    assert.equal(shouldSkipPropertySearch(phrase), true, phrase);
    assert.equal(isListingFollowUp(phrase), false, phrase);
    assert.equal(isServiceInquiryMessage(phrase), false, phrase);
  }
});

test('listing follow-ups still search', () => {
  for (const phrase of [
    'See similar properties',
    'show me villas there',
    'find another villa in Dubai South',
    'Try 1 BR',
    'Show me more',
    'show me more properties',
  ]) {
    assert.equal(isListingFollowUp(phrase), true, phrase);
    assert.equal(shouldSkipPropertySearch(phrase), false, phrase);
  }
});

test('Buy purpose phrases match Rent coverage', () => {
  const buyCases = [
    "I'm looking to buy an apartment in Business Bay",
    'Show me 2 bedroom apartments in Dubai Marina for sale',
    'Buy villas in Arabian Ranches under 5 million',
    'I want to buy a villa',
    'looking to buy an apartment',
    'want to purchase a townhouse',
  ];
  for (const phrase of buyCases) {
    assert.equal(parsePurposeFromMessage(phrase), 'Buy', phrase);
  }
  const rentCases = [
    'I want to rent an apartment in JVC',
    'Looking to rent a villa in The Springs',
    "I'm looking to rent an apartment in JVC",
    'I need a 2 bed for rent',
    "I'm looking for an apartment to rent in Marina",
    'Rent a Property',
    'i need rent',
    'I need rent',
    'need rent',
  ];
  for (const phrase of rentCases) {
    assert.equal(parsePurposeFromMessage(phrase), 'Rent', phrase);
  }
  // Content FAQ must not become Buy just because it contains "buy"
  assert.equal(parsePurposeFromMessage('Can foreigners buy property in Dubai?'), null);
});

// --- Location ---

test('summer is not a location; real areas still parse', () => {
  assert.equal(parseLocationFromMessage('how can we manage our property in summer'), null);
  assert.equal(parseLocationFromMessage('Show me villas in Dubai Hills'), 'Dubai Hills');
  assert.equal(wantsDifferentLocation('show me villas in another area'), true);
  assert.equal(parseLocationFromMessage('show me villas in another area'), null);
  assert.equal(parseLocationReply('Dubai South'), 'Dubai South');
  assert.equal(parseLocationReply('Buy'), null);
});

test('property type change prefers the intended type', () => {
  assert.equal(parsePropertyTypeChange('but this is apartment i need villa in another locations'), 'Villa');
  assert.equal(parseDesiredPropertyType('show me villas in another area'), 'Villa');
});

// --- Related buttons (CMS embeddings only — no hardcoded blog URLs) ---

test('empty-result copy avoids flat negatives', () => {
  const reply = emptyResultsReply({ location: 'Dubai Marina', type: 'Apartment', bedrooms: 2 });
  assert.match(reply, /Looking for/i);
  assert.equal(/i don't have|i couldn't find|no matches/i.test(reply), false);
  const nearby = locationEmptyNearbyReply({ location: 'Arabian Ranches' }, [
    'Dubai Hills',
    'Mudon',
  ]);
  assert.match(nearby, /near Arabian Ranches/i);
  assert.match(nearby, /Dubai Hills/);
  assert.equal(/i don't have|i couldn't find/i.test(nearby), false);
});

test('sell FAQ is content, not sell-listing intent', () => {
  const faq = 'Can I sell my off-plan property before completion?';
  assert.equal(parseSellIntent(faq), false);
  assert.equal(isGeneralKnowledgeQuery(faq), true);
  assert.equal(shouldSkipPropertySearch(faq), true);
});

test('fresh sell does not inherit search or content locations', () => {
  const listing = advanceSellListing(
    'I need to sell my property',
    {},
    [{ role: 'user', content: 'tell me about Dubai Marina' }],
    { location: 'Dubai Marina', type: 'Apartment', purpose: 'Buy' }
  );
  assert.equal(listing.intent, 'sell');
  assert.equal(listing.location, null);
  assert.equal(listing.type, null);
  assert.match(
    sellClarificationReply(listing, 'I need to sell my property'),
    /What type of property are you looking to sell/i
  );
});

test('sell accepts bare area names including Sheikh Zayed Road', () => {
  let listing = advanceSellListing('type is office', { intent: 'sell' }, []);
  assert.equal(listing.type, 'Office');
  assert.equal(listing.location, null);
  listing = advanceSellListing('sheikh zayed road', listing, []);
  assert.equal(listing.location, 'Sheikh Zayed Road');
  assert.match(sellClarificationReply(listing, 'sheikh zayed road'), /office.*Sheikh Zayed Road|Sheikh Zayed Road.*office/i);
});

test('off-plan financing and articles are content, not Off-plan purpose', () => {
  assert.equal(parsePurposeFromMessage('Off-plan financing options in Dubai'), null);
  assert.equal(isGeneralKnowledgeQuery('Off-plan financing options in Dubai'), true);
  assert.equal(parsePurposeFromMessage('Do you have any articles on off-plan investment?'), null);
  assert.equal(shouldSkipPropertySearch('Do you have any articles on off-plan investment?'), true);
});

test('portfolio what-services is content, not PM lead capture', () => {
  const msg = 'I have 20 properties, what services do you provide?';
  assert.equal(isMultiPropertyServiceQuery(msg), true);
  assert.equal(isServiceInquiryMessage(msg), false);
  assert.equal(isGeneralKnowledgeQuery(msg), true);
});

test('service contact accepts short bare phone numbers', () => {
  const parsed = parseServiceContactDetails('1234567', { name: 'Test' });
  assert.equal(parsed.whatsapp, '1234567');
  assert.equal(parsed.phone, '1234567');
});

test('vague yes on sell CTA asks short clarification', () => {
  const listing = {
    intent: 'sell',
    type: 'Villa',
    location: 'Al Barsha',
    name: 'A',
    phone: '0501234567',
    email: 'a@test.com',
  };
  assert.match(sellClarificationReply(listing, 'yes'), /Just to confirm/i);
});

test('vague yes before sell contact asks next missing selling detail', () => {
  const listing = { intent: 'sell', type: 'Apartment', location: 'Dubai Hills' };
  assert.match(sellClarificationReply(listing, 'yes'), /how many bedrooms/i);
  assert.deepEqual(sellFlowOptions(listing, 'yes'), ['Studio', '1 BR', '2 BR', '3 BR', '4+ BR', 'Any']);
});

test('related buttons come only from embedding hits', () => {
  assert.deepEqual(rankRelatedContentSources([]), []);
  const ranked = rankRelatedContentSources([
    { title: 'Home', url: 'https://www.rockyrealestate.com/' },
    {
      title: 'Summer-Proof Your Home',
      url: 'https://www.rockyrealestate.com/blogs/summer-proof-home-dubai',
      sourceType: 'blog',
    },
    {
      title: 'Property Management',
      url: 'https://www.rockyrealestate.com/services/property-management',
      sourceType: 'service',
    },
  ]);
  assert.equal(ranked[0].url, 'https://www.rockyrealestate.com/blogs/summer-proof-home-dubai');
  assert.equal(ranked[1].url, 'https://www.rockyrealestate.com/services/property-management');
  assert.equal(ranked.every((s) => !isHomepageUrl(s.url)), true);
});

// --- Sell flow ---

test('sell parses type and Al Barsha', () => {
  const details = parseSellListingDetails('villa, Barsha, amount we can discuss in call', {});
  assert.equal(details.type, 'Villa');
  assert.equal(details.location, 'Al Barsha');
});

test('sell CTA reuses contact and does not repeat chips', () => {
  const contact = 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890';
  const { listing, reply } = runSellTurns([
    'Sell My Property',
    'al barsha, villa',
    contact,
    'Talk to an agent',
  ]);
  assert.match(listing.name, /test ruf/i);
  assert.match(reply, /I'll connect you with a listing agent/i);
  assert.equal(sellFlowOptions(listing, 'Talk to an agent'), null);
  assert.equal(shouldCaptureSellLead('Talk to an agent', listing), true);
  assert.equal(hasSellContact(listing), true);
});

test('sell recovers contact from history on CTA', () => {
  const history = [
    { role: 'user', content: 'al barsha, villa' },
    { role: 'user', content: 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890' },
  ];
  const listing = advanceSellListing(
    'Talk to an agent',
    { intent: 'sell', type: 'Villa', location: 'Al Barsha' },
    history
  );
  assert.match(listing.name, /test ruf/i);
  assert.match(sellClarificationReply(listing, 'Talk to an agent'), /I have your details/i);
});

test('missing phone asks only for phone; already-shared keeps state', () => {
  let listing = advanceSellListing('al barsha, villa', { intent: 'sell' });
  listing = advanceSellListing('my name is Ahmed, ahmed@test.com', listing);
  assert.match(sellClarificationReply(listing, 'Get a valuation'), /phone/i);

  const done = runSellTurns([
    'I need to sell my property',
    'al barsha, villa',
    'Ahmed Ali, ahmed@test.com, 0501234567',
    'i already shared',
  ]);
  assert.ok(done.listing.email);
  assert.match(done.reply, /I have your details/i);
  assert.equal(isAlreadySharedDetails('i already shared'), true);
  assert.equal(isSellCta('Get a valuation'), true);
});

// --- Property management after sell ---

test('PM after sell asks same vs different location', () => {
  const listing = { type: 'Villa', location: 'Al Barsha' };
  assert.equal(isSellServiceTransitionQuery('Property Management'), true);
  assert.match(sellServiceLocationReply(listing, { propertyNote: '20 properties' }), /Al Barsha/i);
  assert.equal(parseSellServiceLocationChoice('Same property'), 'same');
  assert.deepEqual(SELL_SERVICE_LOCATION_OPTIONS, ['Same property', 'Different location']);
});

test('multi-property manage request is still PM lead', () => {
  const msg = 'i have 20 properties i need property management';
  assert.equal(isServiceInquiryMessage(msg), true);
  assert.equal(isMultiPropertyServiceQuery(msg), true);
  assert.equal(isGeneralKnowledgeQuery(msg), false);
});

test('PM contact reuses phone as whatsapp on "same number"', () => {
  assert.match(serviceContactPromptBlock(), /whatsapp:/i);
  const inquiry = seedServiceInquiry(
    {},
    { name: 'test ruf', email: 'test@test.com', phone: '0501234567', location: 'Al Barsha' },
    [],
    'Property Management'
  );
  inquiry.locationScope = 'same';
  assert.equal(serviceContactReply(inquiry), 'Can you provide your WhatsApp number?');
  const reused = parseServiceContactDetails('same number', {
    name: 'test ruf',
    phone: '0501234567',
    whatsapp: null,
  });
  assert.equal(reused.whatsapp, '0501234567');
  assert.equal(hasServiceContact(reused), true);
});

test('natural language maps to the five conversation intents', () => {
  assert.equal(parseConversationIntent('I want to buy a 2 bedroom apartment.'), CONVERSATION_INTENTS.BUY);
  assert.equal(parseConversationIntent('I need a 2 bed for rent.'), CONVERSATION_INTENTS.RENT);
  assert.equal(parseConversationIntent("I'm looking for an apartment to rent in Marina."), CONVERSATION_INTENTS.RENT);
  assert.equal(parseConversationIntent('I want something off plan.'), CONVERSATION_INTENTS.OFF_PLAN);
  assert.equal(parseConversationIntent('I have an apartment I want to sell.'), CONVERSATION_INTENTS.SELL_PROPERTY);
  assert.equal(parseConversationIntent('I need someone to manage my property.'), CONVERSATION_INTENTS.PROPERTY_MANAGEMENT);
  assert.equal(parsePurposeFromMessage('I want something off plan.'), 'Off-plan');
});

test('menu starters reset previous listing state', () => {
  const buyProfile = startFreshIntent(
    CONVERSATION_INTENTS.BUY,
    '2 bedroom apartment in Dubai Marina',
    {}
  );
  assert.equal(buyProfile.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(buyProfile.lastSearchFilters.purpose, 'Buy');
  assert.equal(buyProfile.lastSearchFilters.bedrooms, 2);
  assert.equal(buyProfile.lastSearchFilters.type, 'Apartment');
  assert.equal(buyProfile.lastSearchFilters.location, 'Dubai Marina');

  const afterReset = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', buyProfile);
  assert.equal(afterReset.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(afterReset.lastSearchFilters.purpose, 'Rent');
  assert.equal(afterReset.lastSearchFilters.bedrooms, null);
  assert.equal(afterReset.lastSearchFilters.type, null);
  assert.equal(afterReset.lastSearchFilters.location, null);
  assert.equal(afterReset.sellListing.intent, null);
  assert.match(listingStartReply(CONVERSATION_INTENTS.RENT, afterReset, 'Rent a Property'), /type of property/i);
  assert.equal(isExplicitIntentStarter('Rent a Property'), true);
  assert.equal(isExplicitIntentStarter('Buy a Property'), true);
  assert.equal(isExplicitIntentStarter('Off-Plan'), true);
  assert.equal(isExplicitIntentStarter('Sell My Property'), true);
  assert.equal(isExplicitIntentStarter('Property Management'), true);
});

test('switching buy to off-plan establishes a fresh off-plan intent', () => {
  const buyProfile = startFreshIntent(CONVERSATION_INTENTS.BUY, 'Buy a Property', {});
  const offPlan = startFreshIntent(CONVERSATION_INTENTS.OFF_PLAN, 'Off-Plan', buyProfile);
  assert.equal(offPlan.intent, CONVERSATION_INTENTS.OFF_PLAN);
  assert.equal(offPlan.lastSearchFilters.purpose, 'Off-plan');
  assert.equal(offPlan.lastSearchFilters.location, null);
  assert.match(listingStartReply(CONVERSATION_INTENTS.OFF_PLAN, offPlan, 'Off-Plan'), /type of property/i);
});

test('sell flow asks for a clear property type first, then area', () => {
  const { listing, reply } = runSellTurns(['Sell My Property']);
  assert.match(reply, /What type of property are you looking to sell/i);
  assert.equal(listing.location, null);
  const next = runSellTurns(['Sell My Property', 'apartment']);
  assert.equal(next.listing.type, 'Apartment');
  assert.match(next.reply, /area or community/i);
  const marina = runSellTurns(['Sell My Property', 'apartment', 'Dubai Marina']);
  assert.equal(marina.listing.location, 'Dubai Marina');
  assert.match(marina.reply, /bedrooms/i);
});

test('sell understands a combined natural listing description', () => {
  const { listing, reply } = runSellTurns(['I have a 2 bedroom apartment in Dubai Marina.']);
  assert.equal(listing.type, 'Apartment');
  assert.equal(listing.location, 'Dubai Marina');
  assert.equal(listing.bedrooms, 2);
  assert.match(reply, /expected selling price|valuation/i);
});

test('property management starts with a service question, not a contact form', () => {
  const profile = startFreshIntent(CONVERSATION_INTENTS.PROPERTY_MANAGEMENT, 'Property Management', {});
  assert.equal(profile.intent, CONVERSATION_INTENTS.PROPERTY_MANAGEMENT);
  assert.equal(profile.slotFlow.awaiting, 'pmNeed');
  const reply = listingStartReply(CONVERSATION_INTENTS.PROPERTY_MANAGEMENT, profile, 'Property Management');
  assert.match(reply, /full property management/i);
  assert.match(reply, /tenant management|rent collection|maintenance|inspections/i);
  assert.equal(/name:|whatsapp:|email:/i.test(reply), false);
  assert.deepEqual(PM_NEED_OPTIONS.length > 0, true);
  assert.equal(parsePmNeedChoice('Full property management'), 'full');
  assert.equal(parsePmNeedChoice('Rent collection'), 'rent_collection');
});

test('listing intake is required until type or area is known', () => {
  const profile = startFreshIntent(CONVERSATION_INTENTS.BUY, 'Buy a Property', {});
  assert.equal(needsListingIntake(profile.lastSearchFilters), true);
  assert.equal(nextMissingListingSlot(profile.lastSearchFilters), 'propertyType');
  assert.equal(profile.slotFlow.awaiting, 'propertyType');
  const withType = startFreshIntent(CONVERSATION_INTENTS.BUY, 'I want to buy a villa in Arabian Ranches', {});
  assert.equal(needsListingIntake(withType.lastSearchFilters), false);
  assert.equal(withType.lastSearchFilters.type, 'Villa');
  assert.equal(withType.lastSearchFilters.location, 'Arabian Ranches');
  assert.equal(nextMissingListingSlot(withType.lastSearchFilters), 'bedrooms');
});

test('Buy then 2 bedroom keeps BUY filters; Rent restart does not', () => {
  const buy = startFreshIntent(CONVERSATION_INTENTS.BUY, 'Buy a Property', {});
  const afterBeds = applyMessageToSearchFilters(buy.lastSearchFilters, '2 bedroom');
  afterBeds.purpose = buy.lastSearchFilters.purpose;
  assert.equal(afterBeds.purpose, 'Buy');
  assert.equal(afterBeds.bedrooms, 2);
  assert.equal(afterBeds.bedroomsResolved, true);

  const rent = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', {
    ...buy,
    lastSearchFilters: afterBeds,
  });
  assert.equal(rent.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(rent.lastSearchFilters.purpose, 'Rent');
  assert.equal(rent.lastSearchFilters.bedrooms, null);
  assert.equal(rent.lastSearchFilters.bedroomsResolved, false);
});

test('multiple property types are parsed together', () => {
  assert.deepEqual(parsePropertyTypesFromMessage('Apartment and Villa'), ['Apartment', 'Villa']);
  assert.deepEqual(parsePropertyTypesFromMessage('apartment + townhouse'), ['Apartment', 'Townhouse']);
  assert.deepEqual(parsePropertyTypesFromMessage('Villa and Townhouse'), ['Villa', 'Townhouse']);
  assert.deepEqual(parsePropertyTypesFromMessage('Apartment, Villa and Townhouse'), [
    'Apartment',
    'Villa',
    'Townhouse',
  ]);
  assert.equal(parseOtherCustomType('Other: Penthouse'), 'Penthouse');
  assert.deepEqual(parsePropertyTypesFromMessage('Other: Penthouse'), ['Penthouse']);
});

test('Other property type uses the custom value, not the word Other', () => {
  assert.deepEqual(filtersFromRequestBody({ property_type: 'Other' }), []);
  assert.deepEqual(
    filtersFromRequestBody({ property_type: 'Other', custom_property_type: 'Penthouse' }),
    ['Penthouse']
  );
  assert.deepEqual(filtersFromRequestBody({ property_types: ['Apartment', 'Villa'] }), [
    'Apartment',
    'Villa',
  ]);
});

test('show me more is pagination; tell me more is not', () => {
  assert.equal(isShowMoreRequest('Show me more'), true);
  assert.equal(isShowMoreRequest('show me more properties'), true);
  assert.equal(isShowMoreRequest('see more'), true);
  assert.equal(isShowMoreRequest('See similar properties'), true);
  assert.equal(isShowMoreRequest('more listings'), true);
  assert.equal(isShowMoreRequest('more properties'), true);
  assert.equal(isShowMoreRequest('tell me more'), false);
  assert.equal(isShowMoreRequest('more details'), false);
  assert.equal(isShowMoreRequest('the first one'), false);
  assert.equal(isPropertyUiAction('See similar properties'), false);
  assert.equal(isPropertyUiAction('View listing'), true);
});

test('adding a property type preserves bedrooms, budget, area, and rent purpose', () => {
  const rent = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', {});
  let filters = applyMessageToSearchFilters(
    rent.lastSearchFilters,
    '2 bedroom apartment in Dubai Hills under AED 100000'
  );
  assert.equal(filters.purpose, 'Rent');
  assert.equal(filters.location, 'Dubai Hills');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.budgetMax, 100000);
  assert.deepEqual(typesFromFilters(filters), ['Apartment']);

  filters = applyMessageToSearchFilters(filters, 'Apartment and Villa');
  assert.equal(filters.purpose, 'Rent');
  assert.equal(filters.location, 'Dubai Hills');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.budgetMax, 100000);
  assert.deepEqual(typesFromFilters(filters), ['Apartment', 'Villa']);
});

test('search query uses propertyType IN list and excludes shown listing IDs', () => {
  const filters = emptySearchFilters();
  filters.purpose = 'Rent';
  applyTypesToFilters(filters, ['Apartment', 'Villa']);
  applyBedroomChoice(filters, { exact: 2 });
  filters.budgetMax = 100000;
  filters.excludeRefNos = ['RO-R-1', 'RO-R-1', 'RO-R-2'];
  const opts = listingQueryOpts(filters, 'Dubai Hills');
  assert.equal(opts.page, 1);
  assert.equal(opts.limit, 6);
  assert.equal(opts.search, 'Dubai Hills');
  assert.deepEqual(opts.filters.propertyType, ['Apartment', 'Villa']);
  assert.equal(opts.filters.bedrooms, 2);
  assert.equal(opts.filters.priceMax, 100000);
  assert.deepEqual(opts.filters.excludeRefNos, ['RO-R-1', 'RO-R-2']);
});

test('effective filters keep last types, beds, budget, and Rent purpose', () => {
  const last = copySearchFilters({
    purpose: 'Rent',
    location: 'Dubai Hills',
    types: ['Apartment', 'Villa'],
    bedrooms: 2,
    bedroomsResolved: true,
    budgetMax: 100000,
  });
  const merged = resolveEffectiveFilters({ type: 'Apartment' }, last);
  assert.equal(merged.purpose, 'Rent');
  assert.equal(merged.location, 'Dubai Hills');
  assert.equal(merged.bedrooms, 2);
  assert.equal(merged.budgetMax, 100000);
  assert.deepEqual(typesFromFilters(merged), ['Apartment', 'Villa']);
});

test('shown listing IDs are unique and a new intent clears them', () => {
  assert.deepEqual(uniqueIdList(['RO-R-1', 'RO-R-1', 'RO-R-2', '']), ['RO-R-1', 'RO-R-2']);
  const withShown = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', {
    shownPropertyIds: ['RO-R-1'],
    lastSearchFilters: { purpose: 'Buy', type: 'Apartment', bedrooms: 2 },
  });
  assert.deepEqual(withShown.shownPropertyIds, []);
  assert.equal(withShown.lastSearchFilters.purpose, 'Rent');
  assert.equal(withShown.lastSearchFilters.bedrooms, null);
});

test('also villa merges onto the current type instead of replacing it', () => {
  const merged = mergePropertyTypes(['Apartment'], ['Villa'], 'also villa');
  assert.deepEqual(merged, ['Apartment', 'Villa']);
});

function sampleBuyApartment(overrides = {}) {
  return {
    propertyRefNo: 'RO-B-1',
    propertyTitle: '2BR apartment in Dubai South',
    price: '1200000',
    bedrooms: '2',
    bathrooms: '2',
    propertySize: '900',
    propertySizeUnit: 'sqft',
    propertyPurpose: 'Buy',
    images: ['https://example.com/a.jpg'],
    ...overrides,
  };
}

function profileFromQualify(result) {
  return {
    intent: result.profilePatch?.intent || null,
    purpose: result.profilePatch?.purpose || null,
    lastSearchFilters: result.profilePatch?.lastSearchFilters || emptySearchFilters(),
    slotFlow: result.profilePatch?.slotFlow || { awaiting: null },
  };
}

test('2 BHK apartment in Dubai South to buy acknowledges search and does not open with only budget', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [sampleBuyApartment(), sampleBuyApartment({ propertyRefNo: 'RO-B-2' }), sampleBuyApartment({ propertyRefNo: 'RO-B-3' })],
    total: 6,
  }));
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: 1_100_000,
    averagePrice: 1_680_000,
    totalAvailable: 6,
  }));

  const msg = 'I need a 2 BHK apartment in Dubai South to buy.';
  const result = qualifyListingSearch(msg, {});
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.type, 'continue');
  assert.notEqual(result.missing, 'budget');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(isBudgetProvided(filters), false);

  const ack = buildSearchAcknowledgement(filters, { previous: emptySearchFilters(), message: msg });
  assert.match(ack, /^(Perfect|Great|Got it|Sure|Absolutely) — you're looking for a 2-bedroom apartment to buy in Dubai South\.?$/i);
  assert.equal(/how can I assist/i.test(ack), false);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: msg,
      intent: CONVERSATION_INTENTS.BUY,
      previousSearch: emptySearchFilters(),
    }
  );
  assert.equal(search.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(search.needsBudget, undefined);
  assert.match(search.replyOverride, /you're looking for a 2-bedroom apartment to buy in Dubai South/i);
  assert.match(search.replyOverride, /I found 6 matching properties/i);
  assert.match(search.replyOverride, /Dubai South market snapshot/i);
  assert.match(search.replyOverride, /Prices start from AED 1\.1M/i);
  assert.match(search.replyOverride, /Average asking price is around AED 1\.68M/i);
  assert.match(search.replyOverride, /narrow these by budget/i);
  assert.equal(/View all |See all |Browse all /i.test(search.replyOverride), false);
  assert.equal(/https?:\/\//i.test(search.replyOverride), false);
  assert.equal(/A few options worth looking at/i.test(search.replyOverride), false);
  assert.equal(/See all properties/i.test(search.replyOverride), false);
  assert.equal(/median/i.test(search.replyOverride), false);
  assert.equal(/sqft/i.test(search.replyOverride), false);
  assert.equal(/^What is your budget( range)?\?$/i.test(String(search.replyOverride || '').trim()), false);
  assert.deepEqual(search.options, BUY_BUDGET_OPTIONS);
  assert.equal(search.presentation.resultSummary, 'I found 6 matching properties.');
  assert.equal(search.presentation.marketSnapshot.minPrice, 1_100_000);
  assert.equal(search.presentation.marketSnapshot.averagePrice, 1_680_000);
  assert.equal(search.presentation.viewAll.label, 'View all 2-bedroom apartments in Dubai South');
  assert.match(search.presentation.viewAll.url, /q=dubai%20south/);
  assert.match(search.presentation.viewAll.url, /[?&]type=apartment/);
  assert.match(search.presentation.viewAll.url, /[?&]beds=2/);
  assert.equal(/[?&]search=/i.test(search.presentation.viewAll.url), false);
  assert.equal(/[?&]bedrooms=/i.test(search.presentation.viewAll.url), false);
  assert.equal(search.presentation.refinementPrompt, 'Would you like to narrow these by budget?');
  assert.match(search.viewAllMatching.label, /View all 2-bedroom apartments in Dubai South/);
});

test('location change acknowledges the patch and does not re-ask known filters', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const second = qualifyListingSearch('Show me apartments in Dubai Marina.', profileFromQualify(first));
  const ack = buildSearchAcknowledgement(second.profilePatch.lastSearchFilters, {
    previous: first.profilePatch.lastSearchFilters,
    message: 'Show me apartments in Dubai Marina.',
  });
  assert.match(ack, /I'll keep your 2-bedroom purchase search and switch the location to Dubai Marina/i);
  assert.equal(/buy or rent|how many bedrooms|what type of property/i.test(ack), false);
});

test('budget chip acknowledges budget only and does not repeat the looking-for line', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const second = qualifyListingSearch('Below AED 2M', profileFromQualify(first));
  const ack = buildSearchAcknowledgement(second.profilePatch.lastSearchFilters, {
    previous: first.profilePatch.lastSearchFilters,
    message: 'Below AED 2M',
  });
  assert.match(ack, /I'll keep the search below AED 2M/i);
  assert.equal(/you're looking for/i.test(ack), false);
});

test('complete buy sentence with under AED 1.5M is ready to search', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [sampleBuyApartment()],
    total: 3,
  }));

  const msg = 'I need a 2 BHK apartment in Dubai South to buy under AED 1.5M';
  const result = qualifyListingSearch(msg, {});
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.type, 'continue');
  assert.equal(result.missing, null);
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(filters.budgetMax, 1500000);
  assert.equal(filters.budgetProvided, true);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: msg,
      intent: CONVERSATION_INTENTS.BUY,
    }
  );
  assert.equal(search.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(search.needsBudget, undefined);
  assert.equal((search.propertyCards || []).length > 0, true);
});

test('2 BHK apartment in Dubai South without intent asks Buy/Rent/Off-plan', () => {
  const result = qualifyListingSearch('I need a 2 BHK apartment in Dubai South', {});
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.type, 'clarify');
  assert.equal(result.missing, 'intent');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(filters.purpose, null);
  assert.match(result.reply, /buy, rent, or explore off-plan/i);
  assert.equal(/bedrooms/i.test(result.reply), false);
  assert.deepEqual(result.options, ['Buy', 'Rent', 'Off-plan']);
});

test('Buy follow-up preserves bedrooms/type/location and is ready to search', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South', {});
  const second = qualifyListingSearch('Buy', profileFromQualify(first));
  const filters = second.profilePatch.lastSearchFilters;
  assert.equal(second.type, 'continue');
  assert.notEqual(second.missing, 'budget');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(second.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(/how many bedrooms/i.test(second.reply || ''), false);
});

test('apartment in Dubai South to buy asks bedrooms first', () => {
  const result = qualifyListingSearch('I need an apartment in Dubai South to buy', {});
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.type, 'clarify');
  assert.equal(result.missing, 'bedrooms');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(isBedroomsResolved(filters), false);
  assert.match(result.reply, /bedrooms/i);
  assert.match(result.reply, /you're looking for an apartment to buy in Dubai South/i);
  assert.equal(/buy, rent/i.test(result.reply), false);
  assert.deepEqual(result.options, ['Studio', '1 BR', '2 BR', '3 BR', '4+ BR', 'Any']);
});

test('2 BR follow-up preserves buy/apartment/Dubai South and is ready to search', () => {
  const first = qualifyListingSearch('I need an apartment in Dubai South to buy', {});
  const second = qualifyListingSearch('2 BR', profileFromQualify(first));
  const filters = second.profilePatch.lastSearchFilters;
  assert.equal(second.type, 'continue');
  assert.notEqual(second.missing, 'budget');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
});

test('Any budget counts as answered and allows search', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [sampleBuyApartment()],
    total: 2,
  }));

  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  assert.notEqual(first.missing, 'budget');
  const second = qualifyListingSearch('Any budget', profileFromQualify(first));
  const filters = second.profilePatch.lastSearchFilters;
  assert.equal(second.type, 'continue');
  assert.equal(filters.budgetProvided, true);
  assert.equal(isBudgetProvided(filters), true);
  assert.equal(filters.budgetMin, null);
  assert.equal(filters.budgetMax, null);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: 'Any budget',
      intent: CONVERSATION_INTENTS.BUY,
      slotFlow: { awaiting: 'budget' },
    }
  );
  assert.equal(search.needsBudget, undefined);
  assert.equal(search.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal((search.propertyCards || []).length > 0, true);
});

test('buy budget chips are below/above ceilings, not ranges', () => {
  assert.deepEqual(BUY_BUDGET_OPTIONS, [
    'Below AED 1M',
    'Below AED 1.5M',
    'Below AED 2M',
    'Below AED 3M',
    'Above AED 3M',
    'Any budget',
  ]);
  assert.equal(BUY_BUDGET_OPTIONS.some((option) => / - /.test(option)), false);

  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  assert.notEqual(first.missing, 'budget');

  const expected = [
    ['Below AED 1M', { budgetMin: null, budgetMax: 1000000 }],
    ['Below AED 1.5M', { budgetMin: null, budgetMax: 1500000 }],
    ['Below AED 2M', { budgetMin: null, budgetMax: 2000000 }],
    ['Below AED 3M', { budgetMin: null, budgetMax: 3000000 }],
    ['Above AED 3M', { budgetMin: 3000000, budgetMax: null }],
    ['Any budget', { budgetMin: null, budgetMax: null }],
  ];
  for (const [label, bounds] of expected) {
    const parsed = parseBudgetFromMessage(label);
    if (label === 'Any budget') {
      assert.equal(parsed.any, true, label);
    } else if (bounds.budgetMax != null) {
      assert.equal(parsed.budgetMax, bounds.budgetMax, label);
      assert.equal(parsed.budgetMin, undefined, label);
    } else {
      assert.equal(parsed.budgetMin, bounds.budgetMin, label);
      assert.equal(parsed.budgetMax, undefined, label);
    }
    const applied = qualifyListingSearch(label, profileFromQualify(first));
    const filters = applied.profilePatch.lastSearchFilters;
    assert.equal(applied.type, 'continue', label);
    assert.equal(filters.budgetProvided, true, label);
    assert.equal(filters.budgetMin, bounds.budgetMin, label);
    assert.equal(filters.budgetMax, bounds.budgetMax, label);
  }

  assert.equal(parseBudgetFromMessage('below 1m').budgetMax, 1000000);
  assert.equal(parseBudgetFromMessage('under 1m').budgetMax, 1000000);
  assert.equal(parseBudgetFromMessage('up to 1m').budgetMax, 1000000);
  assert.equal(parseBudgetFromMessage('max 1m').budgetMax, 1000000);
  assert.equal(parseBudgetFromMessage('below 1.5m').budgetMax, 1500000);
  assert.equal(parseBudgetFromMessage('under 1.5m').budgetMax, 1500000);
  assert.equal(parseBudgetFromMessage('above 3m').budgetMin, 3000000);
  assert.equal(parseBudgetFromMessage('over 3m').budgetMin, 3000000);
  assert.equal(parseBudgetFromMessage('3m+').budgetMin, 3000000);
});

test('AED 1M - 1.5M stores min and max and marks budget provided', () => {
  const parsed = parseBudgetFromMessage('AED 1M - 1.5M');
  assert.equal(parsed.budgetMin, 1000000);
  assert.equal(parsed.budgetMax, 1500000);
  const plus = parseBudgetFromMessage('AED 3M+');
  assert.equal(plus.budgetMin, 3000000);
  assert.equal(plus.budgetMax, undefined);

  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const second = qualifyListingSearch('AED 1M - 1.5M', profileFromQualify(first));
  const filters = second.profilePatch.lastSearchFilters;
  assert.equal(second.type, 'continue');
  assert.equal(filters.budgetProvided, true);
  assert.equal(filters.budgetMin, 1000000);
  assert.equal(filters.budgetMax, 1500000);
});

test('try Dubai Marina changes only location then 1 bedroom changes only beds', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const withBudget = qualifyListingSearch('Under 1.5M', profileFromQualify(first));
  assert.equal(withBudget.type, 'continue');
  const marina = qualifyListingSearch('Try Dubai Marina', profileFromQualify(withBudget));
  const marinaFilters = marina.profilePatch.lastSearchFilters;
  assert.equal(marina.type, 'continue');
  assert.equal(marinaFilters.location, 'Dubai Marina');
  assert.equal(marinaFilters.purpose, 'Buy');
  assert.equal(marinaFilters.bedrooms, 2);
  assert.equal(marinaFilters.type, 'Apartment');
  assert.equal(marinaFilters.budgetMax, 1500000);
  assert.equal(marinaFilters.budgetProvided, true);

  const beds = qualifyListingSearch('Try 1 bedroom', profileFromQualify(marina));
  const bedFilters = beds.profilePatch.lastSearchFilters;
  assert.equal(beds.type, 'continue');
  assert.equal(bedFilters.bedrooms, 1);
  assert.equal(bedFilters.location, 'Dubai Marina');
  assert.equal(bedFilters.purpose, 'Buy');
  assert.equal(bedFilters.type, 'Apartment');
  assert.equal(bedFilters.budgetMax, 1500000);
});

test('missing property type asks supported types then is ready to search', () => {
  const first = qualifyListingSearch('I need a 2 BHK in Dubai South to buy', {});
  assert.equal(first.missing, 'propertyType');
  assert.match(first.reply, /type of property/i);
  assert.deepEqual(first.options, PROPERTY_TYPE_OPTIONS);
  const second = qualifyListingSearch('Apartment', profileFromQualify(first));
  assert.equal(second.type, 'continue');
  assert.notEqual(second.missing, 'budget');
  assert.equal(second.profilePatch.lastSearchFilters.type, 'Apartment');
  assert.equal(second.profilePatch.lastSearchFilters.bedrooms, 2);
});

test('missing location asks area then is ready to search', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment to buy', {});
  assert.equal(first.missing, 'location');
  assert.match(first.reply, /area or community/i);
  const second = qualifyListingSearch('Dubai South', profileFromQualify(first));
  assert.notEqual(second.missing, 'budget');
  assert.equal(second.type, 'continue');
  assert.equal(second.profilePatch.lastSearchFilters.location, 'Dubai South');
});

test('rent budget chips are yearly below/above ceilings, not ranges', () => {
  assert.deepEqual(RENT_BUDGET_OPTIONS, [
    'Below AED 60K/year',
    'Below AED 100K/year',
    'Below AED 150K/year',
    'Below AED 250K/year',
    'Above AED 250K/year',
    'Any budget',
  ]);
  assert.equal(RENT_BUDGET_OPTIONS.some((option) => / - /.test(option)), false);
  assert.equal(RENT_BUDGET_OPTIONS.includes('AED 60K - 100K/year'), false);
  assert.equal(RENT_BUDGET_OPTIONS.includes('AED 100K - 150K/year'), false);
  assert.equal(RENT_BUDGET_OPTIONS.includes('AED 150K - 250K/year'), false);

  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to rent', {});
  assert.notEqual(first.missing, 'budget');
  assert.deepEqual(BUY_BUDGET_OPTIONS, [
    'Below AED 1M',
    'Below AED 1.5M',
    'Below AED 2M',
    'Below AED 3M',
    'Above AED 3M',
    'Any budget',
  ]);

  const expected = [
    ['Below AED 60K/year', { budgetMin: null, budgetMax: 60000 }],
    ['Below AED 100K/year', { budgetMin: null, budgetMax: 100000 }],
    ['Below AED 150K/year', { budgetMin: null, budgetMax: 150000 }],
    ['Below AED 250K/year', { budgetMin: null, budgetMax: 250000 }],
    ['Above AED 250K/year', { budgetMin: 250000, budgetMax: null }],
    ['Any budget', { budgetMin: null, budgetMax: null }],
  ];
  for (const [label, bounds] of expected) {
    const parsed = parseBudgetFromMessage(label);
    if (label === 'Any budget') {
      assert.equal(parsed.any, true, label);
    } else if (bounds.budgetMax != null) {
      assert.equal(parsed.budgetMax, bounds.budgetMax, label);
      assert.equal(parsed.budgetMin, undefined, label);
    } else {
      assert.equal(parsed.budgetMin, bounds.budgetMin, label);
      assert.equal(parsed.budgetMax, undefined, label);
    }
    const applied = qualifyListingSearch(label, profileFromQualify(first));
    const filters = applied.profilePatch.lastSearchFilters;
    assert.equal(applied.type, 'continue', label);
    assert.equal(filters.budgetProvided, true, label);
    assert.equal(filters.budgetMin, bounds.budgetMin, label);
    assert.equal(filters.budgetMax, bounds.budgetMax, label);
  }

  assert.equal(parseBudgetFromMessage('below 60k').budgetMax, 60000);
  assert.equal(parseBudgetFromMessage('under 60k').budgetMax, 60000);
  assert.equal(parseBudgetFromMessage('up to 60k').budgetMax, 60000);
  assert.equal(parseBudgetFromMessage('max 60k').budgetMax, 60000);
  assert.equal(parseBudgetFromMessage('below 100k').budgetMax, 100000);
  assert.equal(parseBudgetFromMessage('under 100k').budgetMax, 100000);
  assert.equal(parseBudgetFromMessage('below 150k').budgetMax, 150000);
  assert.equal(parseBudgetFromMessage('below 250k').budgetMax, 250000);
  assert.equal(parseBudgetFromMessage('above 250k').budgetMin, 250000);
  assert.equal(parseBudgetFromMessage('over 250k').budgetMin, 250000);
  assert.equal(parseBudgetFromMessage('250k+').budgetMin, 250000);

  const typedRange = parseBudgetFromMessage('AED 100K - 150K/year');
  assert.equal(typedRange.budgetMin, 100000);
  assert.equal(typedRange.budgetMax, 150000);
});

test('extracts max budget from a full listing sentence', () => {
  const msg = 'I need a 2 BHK apartment in Dubai South to buy under AED 1.5M.';
  const filters = applyMessageToSearchFilters(emptySearchFilters(), msg);
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(filters.budgetMax, 1500000);
  assert.equal(filters.budgetProvided, true);
  assert.equal(parseBudgetFromMessage('AED 180k').budgetMax, 180000);
  assert.equal(parseBudgetFromMessage('1.2m').budgetMax, 1200000);
  assert.equal(parseBudgetFromMessage('AED 1.2 million').budgetMax, 1200000);
  assert.equal(parseBudgetFromMessage('180,000').budgetMax, 180000);
});

test('follow-up budget is merged onto the existing search profile', () => {
  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy.'
  );
  filters = applyMessageToSearchFilters(filters, 'My budget is 180K.');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(filters.budgetMax, 180000);
  assert.equal(filters.budgetProvided, true);
  assert.equal(parsePurposeFromMessage('My budget is 180K.'), null);
  assert.equal(parseBedroomChoice('My budget is 180K.'), null);
});

test('zero exact results below inventory min is budget-too-low with real stats', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({ properties: [], total: 0 }));
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: 1_100_000,
    averagePrice: 1_700_000,
    maximumPrice: 2_400_000,
    totalAvailable: 12,
  }));

  const last = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy.'
  );
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: last,
      userMessage: 'My budget is 180K.',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );

  assert.equal(result.needsPurpose, undefined);
  assert.equal(result.needsBedrooms, undefined);
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.BUDGET_TOO_LOW);
  assert.match(result.clarificationReply, /AED 180K/);
  assert.match(result.clarificationReply, /AED 1\.1M/);
  assert.match(result.clarificationReply, /AED 1\.7M/);
  assert.deepEqual(result.options, ['Increase budget', 'Any budget', 'Try 1 BR']);
  assert.equal(result.options.includes('Nearby areas'), false);
});

test('no segment inventory does not invent market prices', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({ properties: [], total: 0 }));
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: null,
    averagePrice: null,
    maximumPrice: null,
    totalAvailable: 0,
  }));

  const last = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 4 BHK apartment in Dubai South to buy.'
  );
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: last,
      userMessage: 'My budget is 180K.',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );

  assert.equal(result.searchOutcome, SEARCH_OUTCOME.NO_INVENTORY);
  assert.equal(/AED 1\.|minimum sale price|average sale price/i.test(result.clarificationReply), false);
  assert.match(result.clarificationReply, /couldn't find currently available/i);
  assert.deepEqual(result.options, ['Change bedrooms', 'Change budget', 'Property type']);
  assert.equal(result.options.includes('Nearby areas'), false);
});

test('missing budget still searches and then offers budget as a refinement', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [sampleBuyApartment()],
    total: 3,
  }));

  const last = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy.'
  );
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: last,
      userMessage: 'I need a 2 BHK apartment in Dubai South to buy.',
      intent: CONVERSATION_INTENTS.BUY,
      previousSearch: emptySearchFilters(),
    }
  );

  assert.equal(result.needsBudget, undefined);
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal((result.propertyCards || []).length > 0, true);
  assert.match(result.replyOverride, /you're looking for a 2-bedroom apartment to buy in Dubai South/i);
  assert.match(result.replyOverride, /narrow these by budget/i);
  assert.deepEqual(result.options, BUY_BUDGET_OPTIONS);
  assert.equal(propertyDbService.fetchBuyProperties.mock.calls.length > 0, true);
});

test('try Dubai Marina changes only location', () => {
  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy.'
  );
  filters = applyMessageToSearchFilters(filters, 'Under 1.5M.');
  filters = applyMessageToSearchFilters(filters, 'Try Dubai Marina.');
  assert.equal(filters.location, 'Dubai Marina');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.budgetMax, 1500000);

  filters = applyMessageToSearchFilters(filters, 'Try 1 bedroom.');
  assert.equal(filters.bedrooms, 1);
  assert.equal(filters.location, 'Dubai Marina');
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.budgetMax, 1500000);
});

function completeSouthBuyFilters() {
  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy'
  );
  return applyMessageToSearchFilters(filters, 'AED 1M - 1.5M');
}

function mockBuyInventory(t, listings) {
  const seenExcludes = [];
  t.mock.method(propertyDbService, 'fetchBuyProperties', async (opts) => {
    const exclude = [
      ...(opts.filters?.excludeRefNos || []),
      ...(opts.filters?.excludePropertyRefNos || []),
    ];
    seenExcludes.push(exclude);
    const properties = listings.filter((p) => !exclude.includes(p.propertyRefNo));
    return { properties, total: properties.length };
  });
  return seenExcludes;
}

function continuationProfile(shown = ['A']) {
  const lastSearchFilters = completeSouthBuyFilters();
  return {
    intent: CONVERSATION_INTENTS.BUY,
    purpose: 'Buy',
    lastSearchFilters,
    shownPropertyIds: shown,
    slotFlow: { awaiting: null },
  };
}

test('See similar properties reuses filters, excludes shown IDs, and does not skip to the LLM', async (t) => {
  const listings = [
    sampleBuyApartment({ propertyRefNo: 'A' }),
    sampleBuyApartment({ propertyRefNo: 'B' }),
    sampleBuyApartment({ propertyRefNo: 'C' }),
  ];
  const seenExcludes = mockBuyInventory(t, listings);
  const profile = continuationProfile(['A']);
  assert.equal(hasActiveListingSearch(profile), true);
  assert.equal(isShowMoreRequest('See similar properties'), true);
  assert.equal(isPropertyUiAction('See similar properties'), false);

  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: profile.lastSearchFilters,
      userMessage: 'See similar properties',
      intent: profile.intent,
      shownPropertyIds: profile.shownPropertyIds,
    }
  );

  assert.equal(result.modelPayload?.skipped, undefined);
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(seenExcludes.length > 0, true);
  assert.equal(seenExcludes.some((ids) => ids.includes('A')), true);
  assert.deepEqual((result.propertyCards || []).map((c) => c.id).sort(), ['B', 'C']);
  assert.equal((result.propertyCards || []).some((c) => c.id === 'A'), false);
  assert.match(result.replyOverride, /more 2-bedroom apartments in Dubai South/i);
  assert.equal(result.hasMore, false);
  assert.equal((result.options || []).includes('Show more'), false);
  assert.deepEqual(result.options, moreMatchesOptions(profile.lastSearchFilters, { hasMore: false }));
  assert.equal(result.effectiveFilters.purpose, 'Buy');
  assert.equal(result.effectiveFilters.bedrooms, 2);
  assert.equal(result.effectiveFilters.location, 'Dubai South');
  assert.equal(result.effectiveFilters.budgetMin, 1000000);
  assert.equal(result.effectiveFilters.budgetMax, 1500000);
  assert.deepEqual(result.profilePatch.shownPropertyIds.sort(), ['B', 'C']);
});

test('Show more uses the same continuation search as See similar properties', async (t) => {
  const listings = [
    sampleBuyApartment({ propertyRefNo: 'A' }),
    sampleBuyApartment({ propertyRefNo: 'B' }),
  ];
  const seenExcludes = mockBuyInventory(t, listings);
  const profile = continuationProfile(['A']);
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: profile.lastSearchFilters,
      userMessage: 'Show more',
      intent: profile.intent,
      shownPropertyIds: profile.shownPropertyIds,
    }
  );
  assert.equal(result.modelPayload?.skipped, undefined);
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(seenExcludes.some((ids) => ids.includes('A')), true);
  assert.deepEqual((result.propertyCards || []).map((c) => c.id), ['B']);
  assert.equal(result.hasMore, false);
  assert.equal((result.options || []).includes('Show more'), false);
  assert.deepEqual(result.options, moreMatchesOptions(profile.lastSearchFilters, { hasMore: false }));
});

test('no additional exact matches includes real market min/avg when segment inventory exists', async (t) => {
  const listings = [sampleBuyApartment({ propertyRefNo: 'A', price: '1200000' })];
  mockBuyInventory(t, listings);
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: 1_650_000,
    averagePrice: 1_900_000,
    maximumPrice: 2_100_000,
    totalAvailable: 4,
  }));
  const profile = continuationProfile(['A']);
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: profile.lastSearchFilters,
      userMessage: 'See similar properties',
      intent: profile.intent,
      shownPropertyIds: profile.shownPropertyIds,
    }
  );
  assert.equal(result.modelPayload?.skipped, undefined);
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.EXACT_RESULTS_EXHAUSTED);
  assert.equal((result.propertyCards || []).length, 0);
  assert.match(result.clarificationReply, /aren't any more 2-bedroom apartments in Dubai South/i);
  assert.match(result.clarificationReply, /AED 1M–1\.5M/);
  assert.match(result.clarificationReply, /AED 1\.65M/);
  assert.match(result.clarificationReply, /AED 1\.9M/);
  assert.equal(/already shown/i.test(result.clarificationReply), false);
  assert.deepEqual(result.options, exactResultsExhaustedOptions(profile.lastSearchFilters));
  assert.equal(result.options.includes('Increase budget'), true);
  assert.equal(result.options.includes('Try 1 BR'), true);
  assert.equal(result.options.includes('Any budget'), true);
  assert.equal(result.options.includes('Nearby areas'), true);
});

test('exhausted search with no remaining segment inventory does not invent prices', async (t) => {
  const listings = [sampleBuyApartment({ propertyRefNo: 'A' })];
  mockBuyInventory(t, listings);
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: null,
    averagePrice: null,
    maximumPrice: null,
    totalAvailable: 0,
  }));
  const profile = continuationProfile(['A']);
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: profile.lastSearchFilters,
      userMessage: 'See similar properties',
      intent: profile.intent,
      shownPropertyIds: profile.shownPropertyIds,
    }
  );
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.NO_SEGMENT_INVENTORY);
  assert.equal((result.propertyCards || []).length, 0);
  assert.equal(/AED 1\.|minimum|average asking/i.test(result.clarificationReply), false);
  assert.match(result.clarificationReply, /couldn't find any additional 2-bedroom apartments/i);
  assert.deepEqual(result.options, noAdditionalSegmentOptions(profile.lastSearchFilters));
  assert.equal(result.options.includes('Nearby areas'), true);
  assert.equal(result.options.includes('Try 1 BR'), true);
  assert.equal(result.options.includes('Change property type'), true);
});

test('1 BR continuation keeps buy apartment Dubai South budget and searches', async (t) => {
  mockBuyInventory(t, [sampleBuyApartment({ propertyRefNo: 'D', bedrooms: '1' })]);
  const profile = continuationProfile(['A']);
  const qualified = qualifyListingSearch('1 BR', profile);
  assert.equal(qualified.type, 'continue');
  assert.equal(qualified.profilePatch.lastSearchFilters.purpose, 'Buy');
  assert.equal(qualified.profilePatch.lastSearchFilters.type, 'Apartment');
  assert.equal(qualified.profilePatch.lastSearchFilters.location, 'Dubai South');
  assert.equal(qualified.profilePatch.lastSearchFilters.bedrooms, 1);
  assert.equal(qualified.profilePatch.lastSearchFilters.budgetMin, 1000000);
  assert.equal(qualified.profilePatch.lastSearchFilters.budgetMax, 1500000);

  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: qualified.profilePatch.lastSearchFilters,
      userMessage: '1 BR',
      intent: CONVERSATION_INTENTS.BUY,
      shownPropertyIds: ['A'],
    }
  );
  assert.equal(result.modelPayload?.skipped, undefined);
  assert.equal(result.needsBudget, undefined);
  assert.equal(result.effectiveFilters.bedrooms, 1);
  assert.equal(result.effectiveFilters.purpose, 'Buy');
  assert.equal(result.effectiveFilters.location, 'Dubai South');
  assert.equal(result.effectiveFilters.budgetMax, 1500000);
});

test('Change budget keeps listing criteria and asks budget without searching', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => {
    throw new Error('search must not run until a new budget is supplied');
  });
  const profile = continuationProfile(['A']);
  const result = qualifyListingSearch('Change budget', profile);
  assert.equal(result.type, 'clarify');
  assert.equal(result.missing, 'budget');
  assert.equal(result.profilePatch.lastSearchFilters.purpose, 'Buy');
  assert.equal(result.profilePatch.lastSearchFilters.bedrooms, 2);
  assert.equal(result.profilePatch.lastSearchFilters.type, 'Apartment');
  assert.equal(result.profilePatch.lastSearchFilters.location, 'Dubai South');
  assert.equal(result.profilePatch.lastSearchFilters.budgetProvided, false);
  assert.match(result.reply, /budget/i);
  assert.equal(/you're looking for/i.test(result.reply), false);
  assert.deepEqual(result.options, BUY_BUDGET_OPTIONS);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: result.profilePatch.lastSearchFilters,
      userMessage: 'Change budget',
      intent: CONVERSATION_INTENTS.BUY,
      slotFlow: result.profilePatch.slotFlow,
    }
  );
  assert.equal(search.needsBudget, true);
  assert.equal((search.propertyCards || []).length, 0);
  assert.equal(propertyDbService.fetchBuyProperties.mock.calls.length, 0);
});

test('Any budget from an active search clears min/max, stays answered, and searches', async (t) => {
  mockBuyInventory(t, [
    sampleBuyApartment({ propertyRefNo: 'A', price: '1200000' }),
    sampleBuyApartment({ propertyRefNo: 'E', price: '2100000' }),
  ]);
  const profile = continuationProfile(['A']);
  const qualified = qualifyListingSearch('Any budget', profile);
  assert.equal(qualified.type, 'continue');
  assert.equal(qualified.profilePatch.lastSearchFilters.budgetProvided, true);
  assert.equal(qualified.profilePatch.lastSearchFilters.budgetMin, null);
  assert.equal(qualified.profilePatch.lastSearchFilters.budgetMax, null);
  assert.equal(qualified.profilePatch.lastSearchFilters.purpose, 'Buy');
  assert.equal(qualified.profilePatch.lastSearchFilters.bedrooms, 2);
  assert.equal(qualified.profilePatch.lastSearchFilters.location, 'Dubai South');
  assert.equal(qualified.profilePatch.lastSearchFilters.type, 'Apartment');

  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: qualified.profilePatch.lastSearchFilters,
      userMessage: 'Any budget',
      intent: CONVERSATION_INTENTS.BUY,
      shownPropertyIds: ['A'],
      slotFlow: { awaiting: 'emptyResults' },
    }
  );
  assert.equal(result.modelPayload?.skipped, undefined);
  assert.equal(result.needsBudget, undefined);
  assert.equal(result.effectiveFilters.budgetProvided, true);
  assert.equal(result.effectiveFilters.budgetMin, null);
  assert.equal(result.effectiveFilters.budgetMax, null);
  assert.equal((result.propertyCards || []).some((c) => c.id === 'A'), false);
  assert.equal((result.propertyCards || []).map((c) => c.id).includes('E'), true);
});

test('subsequent show more never returns already shown listing IDs', async (t) => {
  const listings = [
    sampleBuyApartment({ propertyRefNo: 'A' }),
    sampleBuyApartment({ propertyRefNo: 'B' }),
    sampleBuyApartment({ propertyRefNo: 'C' }),
  ];
  const seenExcludes = mockBuyInventory(t, listings);
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: null,
    averagePrice: null,
    maximumPrice: null,
    totalAvailable: 0,
  }));
  const first = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: completeSouthBuyFilters(),
      userMessage: 'See similar properties',
      intent: CONVERSATION_INTENTS.BUY,
      shownPropertyIds: ['A'],
    }
  );
  const firstIds = (first.propertyCards || []).map((c) => c.id);
  assert.deepEqual(firstIds.sort(), ['B', 'C']);

  const shown = uniqueIdList(['A', ...firstIds]);
  const second = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: completeSouthBuyFilters(),
      userMessage: 'See more',
      intent: CONVERSATION_INTENTS.BUY,
      shownPropertyIds: shown,
    }
  );
  assert.equal((second.propertyCards || []).some((c) => shown.includes(c.id)), false);
  assert.equal(seenExcludes.some((ids) => ids.includes('A') && ids.includes('B') && ids.includes('C')), true);
  assert.equal(second.searchOutcome, SEARCH_OUTCOME.NO_SEGMENT_INVENTORY);
});

test('view listing UI actions do not restart property qualification', async () => {
  const msg = 'View listing';
  assert.equal(isPropertyUiAction(msg), true);
  assert.equal(isPropertyUiAction('Book a viewing'), true);
  assert.equal(isListingFollowUp(msg), false);
  assert.equal(parseConversationIntent(msg), null);
  assert.equal(isAmbiguousListingQuery(msg), false);

  const profile = startFreshIntent(
    CONVERSATION_INTENTS.BUY,
    'I need a 2 BHK apartment in Dubai South to buy.',
    {}
  );
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: profile.lastSearchFilters,
      userMessage: msg,
      intent: profile.intent,
    }
  );
  assert.equal(result.modelPayload?.skipped, true);
  assert.equal(result.needsPurpose, undefined);
  assert.equal(result.needsBedrooms, undefined);
});

test('AED formatter uses compact K/M values', () => {
  assert.equal(formatAed(180000), 'AED 180K');
  assert.equal(formatAed(950000), 'AED 950K');
  assert.equal(formatAed(1100000), 'AED 1.1M');
  assert.equal(formatAed(1249000), 'AED 1.25M');
  assert.equal(formatAed(1500000), 'AED 1.5M');
  assert.equal(formatAed(1650000), 'AED 1.65M');
  assert.equal(formatAed(1700000), 'AED 1.7M');
  assert.equal(formatAed(1800000), 'AED 1.8M');
  assert.equal(formatAed(2000000), 'AED 2M');
  assert.equal(formatAed(12500000), 'AED 12.5M');
});

function marinaStudioBuyFilters() {
  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a studio room apartment in Dubai Marina to buy'
  );
  return applyMessageToSearchFilters(filters, 'AED 1M - 1.5M');
}

function marinaStudioBuyProfile() {
  const lastSearchFilters = marinaStudioBuyFilters();
  return {
    intent: CONVERSATION_INTENTS.BUY,
    purpose: 'Buy',
    bedrooms: 0,
    lastSearchFilters,
    lastPropertyCards: [{ id: 'ABC123', propertyRefNo: 'ABC123', title: 'Studio in Dubai Marina' }],
    shownPropertyIds: ['ABC123'],
    slotFlow: { awaiting: null },
    viewingRequest: emptyViewingRequest(),
  };
}

test('commercial office search without buy/rent keeps BUY and drops bedrooms', async (t) => {
  assert.equal(isResidentialPropertyType('Apartment'), true);
  assert.equal(isCommercialPropertyType('Office'), true);
  const previous = marinaStudioBuyFilters();
  assert.equal(previous.bedrooms, 0);
  assert.equal(previous.type, 'Apartment');

  const profile = {
    ...marinaStudioBuyProfile(),
    lastSearchFilters: applyMessageToSearchFilters(
      applyMessageToSearchFilters(emptySearchFilters(), 'I need a 2 BHK apartment in Dubai Marina to buy'),
      'AED 1M - 1.5M'
    ),
    bedrooms: 2,
  };
  const qualified = qualifyListingSearch('Looking for an office in Business Bay.', profile);
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.type, 'Office');
  assert.equal(next.location, 'Business Bay');
  assert.equal(next.purpose, 'Buy');
  assert.equal(qualified.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(next.bedrooms, null);
  assert.equal(next.bedroomsResolved, false);
  assert.equal(qualified.missing, null);
  assert.equal(qualified.type, 'continue');
  assert.equal(/buy or rent|how many bedrooms|what type of property/i.test(qualified.reply || ''), false);
  assert.equal(getRequiredSearchFields(next).includes('bedrooms'), false);

  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [
      {
        propertyRefNo: 'OFF-1',
        propertyTitle: 'Office in Business Bay',
        price: '1200000',
        bedrooms: '',
        bathrooms: '1',
        propertySize: '800',
        propertySizeUnit: 'sqft',
        propertyPurpose: 'Buy',
        images: ['https://example.com/o.jpg'],
      },
    ],
    total: 1,
  }));
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: next,
      userMessage: 'Looking for an office in Business Bay.',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );
  assert.equal(result.needsPurpose, undefined);
  assert.equal(propertyDbService.fetchBuyProperties.mock.calls.length > 0, true);
  assert.equal(result.effectiveFilters.bedrooms, null);
  assert.equal(result.effectiveFilters.type, 'Office');
  assert.equal(result.effectiveFilters.purpose, 'Buy');
  assert.equal(/studio office/i.test(result.clarificationReply || ''), false);
});

test('residential to commercial without explicit intent keeps BUY and sale budget', () => {
  const previous = marinaStudioBuyFilters();
  const next = normalizeSearchProfileAfterPatch(previous, {
    ...previous,
    type: 'Office',
    types: ['Office'],
    location: 'Business Bay',
  });
  assert.equal(next.type, 'Office');
  assert.equal(next.bedrooms, null);
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.budgetProvided, true);
});

test('BUY to RENT clears purchase budget and does not reuse sale chips', () => {
  const profile = continuationProfile(['A']);
  const qualified = qualifyListingSearch('Rent instead', profile);
  assert.equal(qualified.type, 'continue');
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Rent');
  assert.equal(next.budgetProvided, false);
  assert.equal(next.budgetMin, null);
  assert.equal(next.budgetMax, null);
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.location, 'Dubai South');
  assert.notEqual(qualified.missing, 'intent');
});

function sampleRentApartment(overrides = {}) {
  return {
    propertyRefNo: 'RO-R-1',
    propertyTitle: '2BR rental in Dubai Marina',
    price: 'AED 89,000/year',
    bedrooms: '2',
    bathrooms: '2',
    propertySize: '900',
    propertySizeUnit: 'sqft',
    propertyPurpose: 'Rent',
    images: ['https://example.com/rent.jpg'],
    ...overrides,
  };
}

test('BUY search then i need rent then any searches rental listings only', async (t) => {
  const saleListing = sampleBuyApartment({
    propertyRefNo: 'SALE-1',
    price: 'AED 1,500,000',
    propertyTitle: '2BR for sale in Dubai Marina',
  });
  const rentalListing = sampleRentApartment();
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({
    properties: [saleListing],
    total: 1,
  }));
  let rentQuery;
  t.mock.method(propertyDbService, 'fetchRentProperties', async (opts) => {
    if (!rentQuery) rentQuery = opts;
    return { properties: [rentalListing], total: 10 };
  });

  const turn1 = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  assert.equal(turn1.type, 'continue');
  assert.equal(turn1.profilePatch.lastSearchFilters.purpose, 'Buy');

  const turn2 = qualifyListingSearch('Any budget', profileFromQualify(turn1));
  assert.equal(turn2.type, 'continue');
  assert.equal(turn2.profilePatch.lastSearchFilters.purpose, 'Buy');
  assert.equal(turn2.profilePatch.lastSearchFilters.budgetProvided, true);

  const turn3 = qualifyListingSearch('Show me apartments in Dubai Marina', profileFromQualify(turn2));
  assert.equal(turn3.type, 'continue');
  assert.equal(turn3.profilePatch.lastSearchFilters.purpose, 'Buy');
  assert.equal(turn3.profilePatch.lastSearchFilters.location, 'Dubai Marina');
  assert.equal(turn3.profilePatch.lastSearchFilters.budgetProvided, true);

  assert.equal(parsePurposeFromMessage('i need rent'), 'Rent');
  assert.equal(parseConversationIntent('i need rent'), CONVERSATION_INTENTS.RENT);
  assert.equal(isUnrestrictedLocationPhrase('any'), false);

  const turn4 = qualifyListingSearch('i need rent', profileFromQualify(turn3));
  assert.equal(turn4.type, 'continue');
  const afterRent = turn4.profilePatch.lastSearchFilters;
  assert.equal(turn4.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(afterRent.purpose, 'Rent');
  assert.equal(afterRent.budgetProvided, false);
  assert.equal(afterRent.budgetMin, null);
  assert.equal(afterRent.budgetMax, null);
  assert.equal(afterRent.type, 'Apartment');
  assert.equal(afterRent.bedrooms, 2);
  assert.equal(afterRent.location, 'Dubai Marina');
  assert.notEqual(turn4.missing, 'intent');
  assert.equal(turn4.profilePatch.resetShownPropertyIds, true);

  const turn5 = qualifyListingSearch('any', profileFromQualify(turn4));
  assert.equal(turn5.type, 'continue');
  const afterAny = turn5.profilePatch.lastSearchFilters;
  assert.equal(turn5.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(afterAny.purpose, 'Rent');
  assert.equal(afterAny.budgetProvided, true);
  assert.equal(afterAny.budgetMin, null);
  assert.equal(afterAny.budgetMax, null);
  assert.equal(afterAny.location, 'Dubai Marina');
  assert.equal(afterAny.type, 'Apartment');
  assert.equal(afterAny.bedrooms, 2);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: afterAny,
      userMessage: 'any',
      intent: CONVERSATION_INTENTS.RENT,
      slotFlow: turn5.profilePatch.slotFlow,
    }
  );
  assert.equal(search.effectiveFilters.purpose, 'Rent');
  assert.equal(search.effectiveFilters.bedrooms, 2);
  assert.equal(search.effectiveFilters.bedroomsAny, false);
  assert.equal(search.effectiveFilters.location, 'Dubai Marina');
  assert.equal(propertyDbService.fetchRentProperties.mock.calls.length > 0, true);
  assert.equal(propertyDbService.fetchBuyProperties.mock.calls.length, 0);
  assert.equal(rentQuery?.filters?.bedrooms, 2);
  assert.equal(rentQuery?.search, 'Dubai Marina');
  assert.equal((search.propertyCards || []).length, 1);
  assert.equal(search.propertyCards[0].id, 'RO-R-1');
  assert.equal(search.propertyCards[0].price, 'AED 89,000/year');
  assert.equal((search.propertyCards || []).some((card) => card.price === 'AED 1,500,000'), false);
  assert.match(search.replyOverride, /for rent/i);
  assert.equal(/for sale/i.test(search.replyOverride || ''), false);
  assert.match(search.replyOverride, /Dubai Marina/i);
});

test('RENT to BUY clears rental budget and does not reuse rent chips', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to rent', {});
  const withBudget = qualifyListingSearch('Any budget', profileFromQualify(first));
  assert.equal(withBudget.profilePatch.lastSearchFilters.purpose, 'Rent');
  assert.equal(withBudget.profilePatch.lastSearchFilters.budgetProvided, true);

  assert.equal(parsePurposeFromMessage('i need buy'), 'Buy');
  const toBuy = qualifyListingSearch('i need buy', profileFromQualify(withBudget));
  assert.equal(toBuy.type, 'continue');
  const next = toBuy.profilePatch.lastSearchFilters;
  assert.equal(toBuy.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.budgetProvided, false);
  assert.equal(next.budgetMin, null);
  assert.equal(next.budgetMax, null);
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.location, 'Dubai Marina');
  assert.notEqual(toBuy.missing, 'intent');
});

test('Book a viewing starts a deterministic viewing request', () => {
  const profile = marinaStudioBuyProfile();
  const flow = applyViewingRequestFlow('Book a viewing', profile, []);
  assert.equal(flow.type, 'clarify');
  assert.equal(flow.profilePatch.viewingRequest.active, true);
  assert.equal(flow.profilePatch.viewingRequest.propertyRefNo, 'ABC123');
  assert.equal(flow.profilePatch.viewingRequest.submitted, false);
  assert.match(flow.reply, /name/i);
  assert.match(flow.reply, /phone|email/i);
  assert.equal(flow.profilePatch.slotFlow.awaiting, 'viewingContact');
});

test('multi-field viewing contact is extracted in one message', () => {
  const profile = marinaStudioBuyProfile();
  const started = applyViewingRequestFlow('Book a viewing', profile, []);
  const withViewing = {
    ...profile,
    viewingRequest: started.profilePatch.viewingRequest,
    slotFlow: started.profilePatch.slotFlow,
  };
  const details = applyViewingRequestFlow(
    'Rufaid\nrufaid@example.com\n0501234567',
    withViewing,
    []
  );
  const vr = details.profilePatch.viewingRequest;
  assert.equal(vr.name, 'Rufaid');
  assert.equal(vr.email, 'rufaid@example.com');
  assert.equal(vr.phone.replace(/\s/g, ''), '0501234567');
  assert.equal(/name and either/i.test(details.reply || ''), false);
  assert.equal(/please share your name/i.test(details.reply || ''), false);
  assert.equal(/saturday|sunday|weekend/i.test(details.reply || ''), false);
  assert.deepEqual(details.options, VIEWING_NEUTRAL_OPTIONS);
});

function viewingSession(profile = marinaStudioBuyProfile()) {
  const started = applyViewingRequestFlow('Book a viewing', profile, []);
  return {
    ...profile,
    viewingRequest: started.profilePatch.viewingRequest,
    slotFlow: started.profilePatch.slotFlow,
  };
}

test('viewing contact asks only for name after email and phone', () => {
  const afterContact = applyViewingRequestFlow(
    'john@gmail.com\n0501234567',
    viewingSession(),
    []
  );
  const vr = afterContact.profilePatch.viewingRequest;
  assert.equal(vr.email, 'john@gmail.com');
  assert.equal(vr.phone.replace(/\s/g, ''), '0501234567');
  assert.equal(vr.name, null);
  assert.match(afterContact.reply, /please share your name as well/i);
  assert.equal(/phone number or email/i.test(afterContact.reply), false);

  const afterName = applyViewingRequestFlow(
    'John Smith',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: vr,
      slotFlow: afterContact.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(afterName.profilePatch.viewingRequest.name, 'John Smith');
  assert.equal(afterName.profilePatch.viewingRequest.email, 'john@gmail.com');
  assert.equal(afterName.profilePatch.viewingRequest.phone.replace(/\s/g, ''), '0501234567');
  assert.equal(/please share your name/i.test(afterName.reply || ''), false);
  assert.ok(
    afterName.type === 'submit_viewing' ||
      /preferred date or time|agent coordinate/i.test(afterName.reply || '')
  );
  assert.equal(/saturday|sunday|weekend/i.test(afterName.reply || ''), false);
});

test('labeled viewing name is extracted and not asked again', () => {
  const withReachable = applyViewingRequestFlow('john@gmail.com\n0501234567', viewingSession(), []);
  const afterName = applyViewingRequestFlow(
    'name : ruftest',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: withReachable.profilePatch.viewingRequest,
      slotFlow: withReachable.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(afterName.profilePatch.viewingRequest.name, 'ruftest');
  assert.equal(/please share your name/i.test(afterName.reply || ''), false);
});

test('prefixed viewing names are extracted', () => {
  const withReachable = applyViewingRequestFlow('john@gmail.com\n0501234567', viewingSession(), []);
  const afterName = applyViewingRequestFlow(
    'my name is Ali',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: withReachable.profilePatch.viewingRequest,
      slotFlow: withReachable.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(afterName.profilePatch.viewingRequest.name, 'Ali');
  assert.equal(/please share your name/i.test(afterName.reply || ''), false);
});

test('short standalone viewing names are accepted', () => {
  const withReachable = applyViewingRequestFlow('john@gmail.com\n0501234567', viewingSession(), []);
  for (const name of ['Ali', 'John', 'Rufd']) {
    const parsed = parseViewingContactDetails(name, withReachable.profilePatch.viewingRequest);
    assert.equal(parsed.name, name, name);
    assert.equal(parsed.email, 'john@gmail.com');
    assert.equal(parsed.phone.replace(/\s/g, ''), '0501234567');
  }
});

test('email-only viewing contact asks for name not phone', () => {
  const afterEmail = applyViewingRequestFlow('john@gmail.com', viewingSession(), []);
  assert.equal(afterEmail.profilePatch.viewingRequest.email, 'john@gmail.com');
  assert.match(afterEmail.reply, /please share your name as well/i);
  assert.equal(/phone number/i.test(afterEmail.reply), false);
  assert.deepEqual(viewingMissingContactFields(afterEmail.profilePatch.viewingRequest), [
    'name',
  ]);
});

test('labeled comma-separated viewing contact extracts all fields', () => {
  const details = applyViewingRequestFlow(
    'name: John Smith, email: john@gmail.com, phone: 0501234567',
    viewingSession(),
    []
  );
  const vr = details.profilePatch.viewingRequest;
  assert.equal(vr.name, 'John Smith');
  assert.equal(vr.email, 'john@gmail.com');
  assert.equal(vr.phone.replace(/\s/g, ''), '0501234567');
  assert.equal(/please share your name/i.test(details.reply || ''), false);
  assert.equal(/name and either/i.test(details.reply || ''), false);
});

test('generic parser does not treat a location reply as a name', () => {
  const parsed = parseContactDetails('Al Barsha', {});
  assert.equal(parsed.name, null);
});

test('extra messages after a submitted viewing do not resubmit', () => {
  const profile = {
    ...marinaStudioBuyProfile(),
    viewingRequest: {
      ...emptyViewingRequest(),
      active: false,
      submitted: true,
      propertyRefNo: 'ABC123',
      name: 'John Smith',
      email: 'john@gmail.com',
      phone: '0501234567',
      preferredTime: 'Agent can coordinate',
    },
    slotFlow: { awaiting: null },
  };
  assert.equal(applyViewingRequestFlow('thanks', profile, []), null);

  const stuck = applyViewingRequestFlow(
    'please book it again',
    {
      ...profile,
      viewingRequest: { ...profile.viewingRequest, active: true },
      slotFlow: { awaiting: 'viewingTime' },
    },
    []
  );
  assert.notEqual(stuck?.type, 'submit_viewing');
  assert.equal(stuck.profilePatch.viewingRequest.submitted, true);
  assert.equal(stuck.profilePatch.viewingRequest.active, false);
});

test('Agent can coordinate submits the viewing once after contact is complete', () => {
  const withContact = applyViewingRequestFlow(
    'John Smith\njohn@gmail.com\n0501234567',
    viewingSession(),
    []
  );
  const afterTime = applyViewingRequestFlow(
    'Agent can coordinate',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: withContact.profilePatch.viewingRequest,
      slotFlow: withContact.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(afterTime.type, 'submit_viewing');
  assert.equal(afterTime.profilePatch.viewingRequest.preferredTime, 'Agent can coordinate');
  assert.equal(afterTime.profilePatch.viewingRequest.schedulingMode, 'AGENT_COORDINATE');
  assert.equal(afterTime.profilePatch.viewingRequest.name, 'John Smith');
});

function twoPropertyProfile() {
  const base = marinaStudioBuyProfile();
  return {
    ...base,
    lastPropertyCards: [
      { id: 'RO-S-00001', propertyRefNo: 'RO-S-00001', title: 'Contemporary | Prime Community | Tenanted' },
      { id: 'RO-S-00002', propertyRefNo: 'RO-S-00002', title: 'Refined Comfort | Prime | Exclusive' },
    ],
  };
}

test('BOOK_VIEWING with property B ref does not select property A', () => {
  const flow = applyViewingRequestFlow(
    'Book a viewing',
    twoPropertyProfile(),
    [],
    { action: 'BOOK_VIEWING', propertyRefNo: 'RO-S-00002' }
  );
  assert.equal(flow.profilePatch.viewingRequest.propertyRefNo, 'RO-S-00002');
  assert.equal(flow.profilePatch.viewingRequest.propertyId, 'RO-S-00002');
  assert.match(flow.profilePatch.viewingRequest.propertyTitle, /Refined Comfort/i);
  assert.equal(flow.profilePatch.viewingRequest.propertyRefNo === 'RO-S-00001', false);
});

test('generic Book a viewing is ambiguous when multiple properties are shown', () => {
  const flow = applyViewingRequestFlow('Book a viewing', twoPropertyProfile(), []);
  assert.equal(flow.type, 'clarify');
  assert.match(flow.reply, /which property/i);
  assert.equal(flow.profilePatch.viewingRequest.propertyRefNo, null);
  assert.ok(flow.options.some((item) => /RO-S-00002/.test(item)));
  assert.ok(flow.options.some((item) => /RO-S-00001/.test(item)));
});

test('viewing contact extracts name email and phone in one message', () => {
  const details = applyViewingRequestFlow(
    'sha\nsha@gmail.com\n1234567842',
    viewingSession(),
    []
  );
  const vr = details.profilePatch.viewingRequest;
  assert.equal(vr.name, 'sha');
  assert.equal(vr.email, 'sha@gmail.com');
  assert.equal(vr.phone.replace(/\s/g, ''), '1234567842');
  assert.equal(/please share your name|phone number or email/i.test(details.reply || ''), false);
  assert.equal(/saturday|sunday|weekend/i.test(details.reply || ''), false);
  assert.match(details.reply, /preferred date or time/i);
  assert.deepEqual(details.options, VIEWING_NEUTRAL_OPTIONS);
});

test('viewing does not invent weekend options after contact', () => {
  const details = applyViewingRequestFlow(
    'sha\nsha@gmail.com\n1234567842',
    viewingSession(),
    []
  );
  assert.equal(/saturday|sunday|weekend/i.test(details.reply || ''), false);
  assert.equal((details.options || []).some((item) => /saturday|sunday/i.test(item)), false);
});

test('explicit weekend after contact shows weekend options', () => {
  const afterContact = applyViewingRequestFlow(
    'sha\nsha@gmail.com\n1234567842',
    viewingSession(),
    []
  );
  const weekend = applyViewingRequestFlow(
    'weekend',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: afterContact.profilePatch.viewingRequest,
      slotFlow: afterContact.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(weekend.type, 'clarify');
  assert.match(weekend.reply, /preferred weekend time/i);
  assert.deepEqual(weekend.options, VIEWING_WEEKEND_OPTIONS);
  assert.notEqual(weekend.type, 'submit_viewing');
});

test('Agent can coordinate completes scheduling and does not ask another time', () => {
  const afterContact = applyViewingRequestFlow(
    'sha\nsha@gmail.com\n1234567842',
    viewingSession(),
    []
  );
  const done = applyViewingRequestFlow(
    'Agent can coordinate',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: afterContact.profilePatch.viewingRequest,
      slotFlow: afterContact.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(done.type, 'submit_viewing');
  assert.equal(done.profilePatch.viewingRequest.schedulingMode, 'AGENT_COORDINATE');
  assert.equal(/preferred date or time|weekend time/i.test(done.reply || ''), false);
});

test('successful viewing lead closes viewingRequest', async (t) => {
  t.mock.method(Lead, 'create', async (doc) => ({ _id: 'lead-view-ok', ...doc }));
  const afterContact = applyViewingRequestFlow(
    'sha\nsha@gmail.com\n1234567842',
    viewingSession(),
    []
  );
  const afterTime = applyViewingRequestFlow(
    'Agent can coordinate',
    {
      ...marinaStudioBuyProfile(),
      viewingRequest: afterContact.profilePatch.viewingRequest,
      slotFlow: afterContact.profilePatch.slotFlow,
    },
    []
  );
  const captured = await executeTool(
    'capture_lead',
    {
      name: afterTime.profilePatch.viewingRequest.name,
      phone: afterTime.profilePatch.viewingRequest.phone,
      email: afterTime.profilePatch.viewingRequest.email,
      intent: 'property viewing — ref ABC123',
      emailOptional: true,
      phoneOptional: true,
    },
    { sessionId: 'view-ok' }
  );
  const finalized = finalizeViewingCapture(afterTime.profilePatch.viewingRequest, captured);
  assert.equal(captured.leadCaptured, true);
  assert.match(finalized.reply, /viewing request has been recorded/i);
  assert.equal(finalized.viewingRequest.active, false);
  assert.equal(finalized.viewingRequest.submitted, true);
});

test('new viewing for property B clears old schedule and stores B', () => {
  const completedA = {
    ...twoPropertyProfile(),
    viewingRequest: {
      ...emptyViewingRequest(),
      active: false,
      submitted: true,
      propertyRefNo: 'RO-S-00001',
      propertyId: 'RO-S-00001',
      propertyTitle: 'Contemporary | Prime Community | Tenanted',
      name: 'sha',
      email: 'sha@gmail.com',
      phone: '1234567842',
      preferredDate: 'Sunday',
      preferredTime: 'Sunday morning',
      schedulingMode: 'USER_PREFERENCE',
    },
  };
  const next = applyViewingRequestFlow(
    'Book a viewing',
    completedA,
    [],
    { action: 'BOOK_VIEWING', propertyRefNo: 'RO-S-00002' }
  );
  const vr = next.profilePatch.viewingRequest;
  assert.equal(vr.propertyRefNo, 'RO-S-00002');
  assert.equal(vr.submitted, false);
  assert.equal(vr.active, true);
  assert.equal(vr.preferredDate, null);
  assert.equal(vr.preferredTime, null);
  assert.equal(vr.schedulingMode, null);
  assert.equal(vr.name, 'sha');
  assert.equal(vr.email, 'sha@gmail.com');
});

test('property search after a completed viewing is not treated as a viewing note', () => {
  const profile = {
    ...marinaStudioBuyProfile(),
    viewingRequest: {
      ...emptyViewingRequest(),
      active: false,
      submitted: true,
      propertyRefNo: 'ABC123',
      name: 'sha',
      email: 'sha@gmail.com',
      phone: '1234567842',
      preferredTime: 'Agent can coordinate',
      schedulingMode: 'AGENT_COORDINATE',
    },
    slotFlow: { awaiting: null },
  };
  const query = 'Show me apartments in Dubai Marina.';
  assert.equal(isListingSearchOverride(query), true);
  assert.equal(applyViewingRequestFlow(query, profile, []), null);
});

test('preferred viewing time completes the flow after captureLead succeeds', async (t) => {
  t.mock.method(Lead, 'create', async (doc) => ({ _id: 'lead-view-1', ...doc }));
  const profile = marinaStudioBuyProfile();
  const started = applyViewingRequestFlow('Book a viewing', profile, []);
  const afterContact = applyViewingRequestFlow(
    'Rufaid\nrufaid@example.com\n0501234567',
    {
      ...profile,
      viewingRequest: started.profilePatch.viewingRequest,
      slotFlow: started.profilePatch.slotFlow,
    },
    []
  );
  const afterTime = applyViewingRequestFlow(
    'Sunday morning',
    {
      ...profile,
      viewingRequest: afterContact.profilePatch.viewingRequest,
      slotFlow: afterContact.profilePatch.slotFlow,
    },
    []
  );
  assert.equal(afterTime.type, 'submit_viewing');
  assert.equal(afterTime.profilePatch.viewingRequest.preferredTime, 'Sunday morning');
  assert.equal(/accessibility/i.test(afterTime.reply || ''), false);

  const captured = await executeTool(
    'capture_lead',
    {
      name: afterTime.profilePatch.viewingRequest.name,
      phone: afterTime.profilePatch.viewingRequest.phone,
      email: afterTime.profilePatch.viewingRequest.email,
      intent: 'Viewing request — ref ABC123',
      emailOptional: true,
    },
    { sessionId: 'view-1' }
  );
  const finalized = finalizeViewingCapture(afterTime.profilePatch.viewingRequest, captured);
  assert.equal(finalized.leadCaptured, true);
  assert.equal(finalized.viewingRequest.submitted, true);
  assert.equal(finalized.viewingRequest.active, false);
  assert.match(finalized.reply, /Sunday morning/);
  assert.equal(/accessibility/i.test(finalized.reply), false);
  assert.deepEqual(finalized.options, ['See similar properties', 'New property search']);
});

test('lead capture failure does not claim an agent will contact the visitor', async (t) => {
  t.mock.method(Lead, 'create', async () => {
    throw new Error('db unavailable');
  });
  const captured = await executeTool(
    'capture_lead',
    {
      name: 'Rufaid',
      phone: '0501234567',
      email: 'rufaid@example.com',
      intent: 'Viewing request — ref ABC123',
      emailOptional: true,
    },
    { sessionId: 'view-fail' }
  );
  assert.equal(captured.leadCaptured, false);
  assert.equal(captured.modelPayload.ok, false);
  const finalized = finalizeViewingCapture(
    {
      active: true,
      propertyRefNo: 'ABC123',
      name: 'Rufaid',
      email: 'rufaid@example.com',
      phone: '0501234567',
      preferredTime: 'Sunday morning',
    },
    captured
  );
  assert.equal(finalized.leadCaptured, false);
  assert.equal(finalized.viewingRequest.submitted, false);
  assert.equal(finalized.viewingRequest.active, true);
  assert.equal(finalized.reply, viewingFailureReply());
  assert.equal(/agent will contact/i.test(finalized.reply), false);
  assert.equal(/routed your request/i.test(finalized.reply), false);
});

test('nothing else after a completed viewing closes the sub-flow', () => {
  const profile = {
    ...marinaStudioBuyProfile(),
    viewingRequest: {
      ...emptyViewingRequest(),
      active: false,
      submitted: true,
      propertyRefNo: 'ABC123',
      name: 'Rufaid',
      email: 'rufaid@example.com',
      phone: '0501234567',
    },
  };
  const flow = applyViewingRequestFlow('nothing to share', profile, []);
  assert.equal(flow.type, 'clarify');
  assert.equal(flow.reply, viewingCloseReply());
  assert.equal(flow.profilePatch.viewingRequest.active, false);
  assert.equal(/preferred|accessibility|phone|email|weekend/i.test(flow.reply), false);
});

test('new search after viewing exits viewing mode and keeps compatible filters', () => {
  const profile = {
    ...marinaStudioBuyProfile(),
    lastSearchFilters: applyMessageToSearchFilters(
      applyMessageToSearchFilters(emptySearchFilters(), 'I need a 2 BHK apartment in Dubai South to buy'),
      'AED 1M - 1.5M'
    ),
    viewingRequest: {
      ...emptyViewingRequest(),
      active: true,
      submitted: true,
      name: 'Rufaid',
      phone: '0501234567',
    },
  };
  assert.equal(isListingSearchOverride('Show me apartments in Dubai Marina.'), true);
  const qualified = qualifyListingSearch('Show me apartments in Dubai Marina.', {
    ...profile,
    viewingRequest: { ...profile.viewingRequest, active: false },
  });
  assert.equal(qualified.type, 'continue');
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.location, 'Dubai Marina');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.budgetMin, 1000000);
  assert.equal(next.budgetMax, 1500000);
});

test('studio follow-up patches bedrooms only and keeps the apartment search', async (t) => {
  const profile = continuationProfile(['A']);
  profile.lastSearchFilters = applyMessageToSearchFilters(
    profile.lastSearchFilters,
    'Try Dubai Marina.'
  );
  const qualified = qualifyListingSearch('I need a studio room.', profile);
  assert.equal(qualified.type, 'continue');
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.bedrooms, 0);
  assert.equal(next.type, 'Apartment');
  assert.equal(next.location, 'Dubai Marina');
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.budgetMin, 1000000);
  assert.equal(next.budgetMax, 1500000);

  mockBuyInventory(t, [
    sampleBuyApartment({ propertyRefNo: 'ST-1', bedrooms: '0', propertyTitle: 'Studio apartment' }),
  ]);
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: next,
      userMessage: 'I need a studio room.',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );
  assert.equal(result.effectiveFilters.bedrooms, 0);
  assert.equal(result.effectiveFilters.type, 'Apartment');
});

test('studio room without intent asks buy/rent and keeps bedrooms 0', () => {
  assert.equal(parseBedroomChoice('i need a studio room').exact, 0);
  assert.deepEqual(parsePropertyTypesFromMessage('i need a studio room'), ['Apartment']);
  assert.equal(isBedroomsResolved({ bedrooms: 0 }), true);
  assert.equal(isBedroomsResolved({ bedrooms: null }), false);

  const turn1 = qualifyListingSearch('i need a studio room', {});
  assert.equal(turn1.type, 'clarify');
  assert.equal(turn1.missing, 'intent');
  const afterStudio = turn1.profilePatch.lastSearchFilters;
  assert.equal(afterStudio.type, 'Apartment');
  assert.equal(afterStudio.bedrooms, 0);
  assert.equal(afterStudio.bedroomsResolved, true);
  assert.equal(isBedroomsResolved(afterStudio), true);
  assert.match(turn1.reply, /buy, rent, or explore off-plan/i);
  assert.equal(/how many bedrooms/i.test(turn1.reply), false);
  assert.equal(/what type of property/i.test(turn1.reply), false);

  const turn2 = qualifyListingSearch('Rent', profileFromQualify(turn1));
  assert.equal(turn2.type, 'clarify');
  assert.equal(turn2.missing, 'location');
  assert.equal(turn2.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  const afterRent = turn2.profilePatch.lastSearchFilters;
  assert.equal(afterRent.purpose, 'Rent');
  assert.equal(afterRent.type, 'Apartment');
  assert.equal(afterRent.bedrooms, 0);
  assert.equal(isBedroomsResolved(afterRent), true);
  assert.equal(/how many bedrooms/i.test(turn2.reply || ''), false);
  assert.equal((turn2.options || []).includes('Studio'), false);
  assert.equal((turn2.options || []).includes('1 BR'), false);

  assert.equal(hasInProgressListingSearch(profileFromQualify(turn1)), true);
  assert.equal(shouldResetOnListingIntent('Rent', profileFromQualify(turn1), 'RENT'), false);
  assert.equal(shouldResetOnListingIntent('Rent a Property', profileFromQualify(turn1)), true);

  const persisted = {
    ...profileFromQualify(turn1),
    lastSearchFilters: {
      ...turn1.profilePatch.lastSearchFilters,
      bedroomsResolved: false,
    },
  };
  const afterPersist = qualifyListingSearch('Rent', persisted);
  assert.equal(afterPersist.missing, 'location');
  assert.equal(afterPersist.profilePatch.lastSearchFilters.bedrooms, 0);
  assert.equal(/how many bedrooms/i.test(afterPersist.reply || ''), false);
});

test('studio for rent in Dubai Marina is ready to search without blocking on budget', () => {
  const result = qualifyListingSearch('studio for rent in Dubai Marina', {});
  assert.equal(result.type, 'continue');
  assert.notEqual(result.missing, 'budget');
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(filters.purpose, 'Rent');
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.bedrooms, 0);
  assert.equal(filters.location, 'Dubai Marina');
  assert.equal(/how many bedrooms/i.test(result.reply || ''), false);
  assert.equal(/buy, rent/i.test(result.reply || ''), false);
});

test('buy a studio in Dubai South is ready to search without blocking on budget', () => {
  const result = qualifyListingSearch('buy a studio in Dubai South', {});
  assert.equal(result.type, 'continue');
  assert.notEqual(result.missing, 'budget');
  const filters = result.profilePatch.lastSearchFilters;
  assert.equal(result.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.bedrooms, 0);
  assert.equal(filters.location, 'Dubai South');
  assert.equal(/how many bedrooms/i.test(result.reply || ''), false);
});

test('make it a studio overwrites an existing bedroom count with 0', () => {
  const profile = continuationProfile(['A']);
  assert.equal(profile.lastSearchFilters.bedrooms, 2);
  const qualified = qualifyListingSearch('make it a studio', profile);
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.bedrooms, 0);
  assert.equal(next.type, 'Apartment');
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.location, 'Dubai South');
});

test('studio search query sends bedrooms 0 not 1 or missing', async (t) => {
  let rentQuery;
  t.mock.method(propertyDbService, 'fetchRentProperties', async (opts) => {
    rentQuery = opts;
    return {
      properties: [
        sampleBuyApartment({
          propertyRefNo: 'ST-RENT-1',
          propertyPurpose: 'Rent',
          bedrooms: '0',
          price: 'AED 89,000/year',
          propertyTitle: 'Studio in Dubai Marina',
        }),
      ],
      total: 1,
    };
  });
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => {
    throw new Error('studio rent search must not query buy inventory');
  });

  const first = qualifyListingSearch('studio for rent in Dubai Marina', {});
  const ready = qualifyListingSearch('Any budget', profileFromQualify(first));
  assert.equal(ready.type, 'continue');
  assert.equal(ready.profilePatch.lastSearchFilters.bedrooms, 0);

  const search = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: ready.profilePatch.lastSearchFilters,
      userMessage: 'Any budget',
      intent: CONVERSATION_INTENTS.RENT,
      slotFlow: ready.profilePatch.slotFlow,
    }
  );
  assert.equal(search.effectiveFilters.bedrooms, 0);
  assert.equal(search.effectiveFilters.bedroomsAny, false);
  assert.equal(rentQuery?.filters?.bedrooms, 0);
  assert.equal(rentQuery?.filters?.bedrooms === undefined, false);
  assert.equal(rentQuery?.filters?.bedrooms === null, false);
  assert.equal(rentQuery?.filters?.bedrooms === 1, false);
  assert.equal(search.propertyCards[0].beds, '0');
});

test('office after studio clears bedrooms and never searches studio offices', () => {
  const previous = marinaStudioBuyFilters();
  const afterStudio = applyMessageToSearchFilters(previous, 'I need a studio room.');
  assert.equal(afterStudio.bedrooms, 0);
  const afterOffice = applyMessageToSearchFilters(afterStudio, 'Looking for an office in Business Bay.');
  assert.equal(afterOffice.type, 'Office');
  assert.equal(afterOffice.location, 'Business Bay');
  assert.equal(afterOffice.bedrooms, null);
  assert.equal(afterOffice.purpose, 'Buy');
  const qualified = qualifyListingSearch('Looking for an office in Business Bay.', {
    intent: CONVERSATION_INTENTS.BUY,
    purpose: 'Buy',
    lastSearchFilters: afterStudio,
    slotFlow: { awaiting: null },
  });
  const reply = `${qualified.reply || ''} ${describeSearchSafe(qualified)}`;
  assert.equal(/studio office/i.test(reply), false);
});

function describeSearchSafe(qualified) {
  const filters = qualified.profilePatch?.lastSearchFilters || {};
  return `${filters.bedrooms} ${filters.type} ${filters.location}`;
}

test('zero results with a restrictive budget mention the budget and real stats', async (t) => {
  t.mock.method(propertyDbService, 'fetchBuyProperties', async () => ({ properties: [], total: 0 }));
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: 2_100_000,
    averagePrice: 2_800_000,
    maximumPrice: 3_400_000,
    totalAvailable: 9,
  }));
  const last = applyMessageToSearchFilters(
    applyMessageToSearchFilters(emptySearchFilters(), 'I need a 2 BHK apartment in Dubai Marina to buy'),
    'AED 1M - 1.5M'
  );
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: last,
      userMessage: 'Show me apartments in Dubai Marina.',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.BUDGET_TOO_LOW);
  assert.match(result.clarificationReply, /AED 1M–1\.5M/);
  assert.match(result.clarificationReply, /AED 2\.1M/);
  assert.match(result.clarificationReply, /AED 2\.8M/);
  assert.deepEqual(result.options, ['Increase budget', 'Any budget', 'Try 1 BR']);
  assert.equal(result.options.includes('Nearby areas'), false);
});

test('explicit buy office keeps BUY and does not re-ask intent', () => {
  const profile = {
    intent: CONVERSATION_INTENTS.BUY,
    purpose: 'Buy',
    lastSearchFilters: applyMessageToSearchFilters(
      emptySearchFilters(),
      'I need a 2 BHK apartment in Dubai Marina to buy'
    ),
    slotFlow: { awaiting: null },
  };
  const qualified = qualifyListingSearch('I want to buy an office in Business Bay.', profile);
  assert.equal(qualified.type, 'continue');
  const next = qualified.profilePatch.lastSearchFilters;
  assert.equal(next.type, 'Office');
  assert.equal(next.purpose, 'Buy');
  assert.equal(qualified.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(next.location, 'Business Bay');
  assert.equal(next.bedrooms, null);
  assert.equal(/buy or rent/i.test(qualified.reply || ''), false);
});

test('explicit rent office keeps RENT and does not re-ask intent', () => {
  const profile = marinaStudioBuyProfile();
  const qualified = qualifyListingSearch('I want to rent an office in Business Bay.', profile);
  assert.equal(qualified.profilePatch.lastSearchFilters.purpose, 'Rent');
  assert.equal(qualified.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(qualified.profilePatch.lastSearchFilters.type, 'Office');
  assert.equal(qualified.profilePatch.lastSearchFilters.location, 'Business Bay');
  assert.notEqual(qualified.missing, 'intent');
  assert.equal(/buy or rent/i.test(qualified.reply || ''), false);
});

test('change property type to Office keeps BUY and drops bedrooms', () => {
  const profile = continuationProfile(['A']);
  const askType = qualifyListingSearch('Change property type', profile);
  assert.equal(askType.type, 'clarify');
  assert.equal(askType.missing, 'propertyType');
  assert.match(askType.reply, /what type of property would you like instead/i);

  const afterOffice = qualifyListingSearch('Office', {
    ...profile,
    lastSearchFilters: askType.profilePatch.lastSearchFilters,
    slotFlow: askType.profilePatch.slotFlow,
  });
  const next = afterOffice.profilePatch.lastSearchFilters;
  assert.equal(next.type, 'Office');
  assert.equal(next.purpose, 'Buy');
  assert.equal(afterOffice.profilePatch.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(next.bedrooms, null);
  assert.notEqual(afterOffice.missing, 'intent');
  assert.equal(/buy or rent|how many bedrooms/i.test(afterOffice.reply || ''), false);
});

test('Rent after commercial type change does not reuse sale budget', () => {
  const profile = continuationProfile(['A']);
  const afterOffice = qualifyListingSearch('Office', profile);
  const afterRent = qualifyListingSearch('Rent', {
    intent: null,
    purpose: null,
    lastSearchFilters: afterOffice.profilePatch.lastSearchFilters,
    slotFlow: afterOffice.profilePatch.slotFlow,
  });
  assert.equal(afterRent.type, 'continue');
  const next = afterRent.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Rent');
  assert.equal(afterRent.profilePatch.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(next.budgetProvided, false);
  assert.equal(next.budgetMin, null);
  assert.equal(next.budgetMax, null);
  assert.notEqual(afterRent.missing, 'intent');
});

test('commercial intent options are Buy and Rent only', () => {
  const officeFilters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'Looking for an office in Business Bay.'
  );
  assert.deepEqual(purposeOptionsForFilters(officeFilters), COMMERCIAL_PURPOSE_OPTIONS);
  assert.deepEqual(purposeOptionsForFilters(officeFilters), ['Buy', 'Rent']);
  assert.equal(purposeOptionsForFilters(officeFilters).includes('Off-plan'), false);
  const apartmentFilters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai Marina to buy'
  );
  assert.deepEqual(purposeOptionsForFilters(apartmentFilters), ['Buy', 'Rent', 'Off-plan']);
});

test('any-location language clears the area filter and is not searched as a place', () => {
  const phrases = [
    'I need a studio apartment for sale anywhere in Dubai.',
    'studio anywhere',
    'I need a studio room in any locations',
    'Any area is fine.',
    'any location',
    'all locations',
    'location does not matter',
  ];
  for (const phrase of phrases) {
    assert.equal(isUnrestrictedLocationPhrase(phrase), true, phrase);
    assert.equal(parseLocationFromMessage(phrase), null, phrase);
  }
  assert.equal(parseLocationFromMessage('I need a 2 BHK apartment in Dubai South to buy'), 'Dubai South');
  assert.equal(isUnrestrictedLocationPhrase('I need a 2 BHK apartment in Dubai South to buy'), false);

  const filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a studio apartment for sale anywhere in Dubai.'
  );
  assert.equal(filters.bedrooms, 0);
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.location, null);
  assert.equal(filters.locationAny, true);
  assert.equal(hasLocationConstraint(filters), false);
  assert.equal(nextMissingListingSlot(filters) === 'location', false);
  const opts = listingQueryOpts(filters, hasLocationConstraint(filters) ? filters.location : '');
  assert.equal(opts.search, '');
  const reply = foundListingsReply(filters, 3);
  assert.equal(/in any(where| locations?)|in anywhere/i.test(reply), false);
  assert.equal(emptyResultsReply(filters).toLowerCase().includes('any locations'), false);
  assert.equal(noInventoryReply(filters).toLowerCase().includes('any locations'), false);
});

test('any location after JVC clears only the area and keeps the rest of the search', () => {
  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a studio apartment in JVC to buy'
  );
  filters = applyMessageToSearchFilters(filters, 'AED 1M - 1.5M');
  assert.equal(filters.location, 'JVC');
  assert.equal(filters.bedrooms, 0);
  assert.equal(filters.purpose, 'Buy');

  const next = qualifyListingSearch('Any area is fine.', {
    intent: CONVERSATION_INTENTS.BUY,
    purpose: 'Buy',
    lastSearchFilters: filters,
  });
  assert.equal(next.type, 'continue');
  const updated = next.profilePatch.lastSearchFilters;
  assert.equal(updated.location, null);
  assert.equal(updated.locationAny, true);
  assert.equal(updated.bedrooms, 0);
  assert.equal(updated.purpose, 'Buy');
  assert.equal(updated.budgetProvided, true);
  assert.equal(updated.budgetMin, 1000000);
  assert.equal(updated.budgetMax, 1500000);
  assert.equal(hasLocationConstraint(updated), false);
});

test('commercial office fallbacks do not mention bedrooms', () => {
  const office = applyMessageToSearchFilters(
    applyMessageToSearchFilters(emptySearchFilters(), 'Looking for an office in Business Bay to rent'),
    'Any budget'
  );
  assert.equal(office.type, 'Office');
  assert.equal(office.purpose, 'Rent');
  assert.equal(office.bedrooms, null);
  assert.equal(requiresBedroomsForSearch(office), false);

  const noMore = noAdditionalSegmentReply(office);
  assert.equal(/bedroom configuration|change bedrooms|studio|1br|2br/i.test(noMore), false);
  const noMoreOpts = noAdditionalSegmentOptions(office);
  assert.equal(noMoreOpts.includes('Change bedrooms'), false);
  assert.equal(noMoreOpts.some((opt) => /br|studio/i.test(opt)), false);
  assert.equal(noMoreOpts.includes('Nearby areas'), true);
  assert.equal(noMoreOpts.includes('Change property type'), true);

  const emptyOpts = noInventoryOptions(office);
  assert.equal(emptyOpts.includes('Change bedrooms'), false);
  assert.equal(emptyOpts.some((opt) => /br|studio/i.test(opt)), false);
  assert.equal(/bedroom configuration/i.test(noInventoryReply(office)), false);

  const residential = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai South to buy'
  );
  assert.equal(noAdditionalSegmentOptions(residential).includes('Try 1 BR'), true);
  assert.equal(noInventoryOptions(residential).includes('Change bedrooms'), true);
});

test('pagination metadata is false after all matching offices have been returned', async (t) => {
  const listings = Array.from({ length: 8 }, (_, i) => ({
    propertyRefNo: `OFF-${i + 1}`,
    propertyTitle: `Office ${i + 1}`,
    price: '120000',
    bedrooms: '',
    bathrooms: '1',
    propertySize: '800',
    propertySizeUnit: 'sqft',
    propertyPurpose: 'Rent',
    propertyType: 'Office',
    images: ['https://example.com/o.jpg'],
  }));
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: null,
    averagePrice: null,
    maximumPrice: null,
    totalAvailable: 0,
  }));
  t.mock.method(propertyDbService, 'fetchRentProperties', async (opts) => {
    const exclude = opts.filters?.excludeRefNos || [];
    const remaining = listings.filter((p) => !exclude.includes(p.propertyRefNo));
    const limit = Number(opts.limit) || remaining.length;
    return { properties: remaining.slice(0, limit), total: remaining.length };
  });

  let filters = applyMessageToSearchFilters(
    emptySearchFilters(),
    'Looking for an office in Business Bay to rent'
  );
  filters = applyMessageToSearchFilters(filters, 'Any budget');

  const first = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: 'Any budget',
      intent: CONVERSATION_INTENTS.RENT,
    }
  );
  assert.equal(first.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(first.total, 8);
  assert.equal(first.returnedCount, 6);
  assert.equal(first.hasMore, true);
  assert.equal((first.propertyCards || []).length, 6);
  const firstIds = (first.propertyCards || []).map((c) => c.id);

  const second = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: 'See similar properties',
      intent: CONVERSATION_INTENTS.RENT,
      shownPropertyIds: firstIds,
    }
  );
  assert.equal(second.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(second.hasMore, false);
  assert.equal((second.options || []).includes('Show more'), false);
  const secondIds = (second.propertyCards || []).map((c) => c.id);
  assert.equal(secondIds.some((id) => firstIds.includes(id)), false);
  assert.equal(second.returnedCount, 2);

  const shown = uniqueIdList([...firstIds, ...secondIds]);
  const third = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: 'Show more',
      intent: CONVERSATION_INTENTS.RENT,
      shownPropertyIds: shown,
    }
  );
  assert.equal((third.propertyCards || []).length, 0);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  assert.equal((third.options || []).includes('Show more'), false);
  assert.equal((third.options || []).includes('Change bedrooms'), false);
  assert.equal(/bedroom configuration/i.test(third.clarificationReply || ''), false);
});

function assertKnownFieldsNotReasked(result) {
  assert.notEqual(result.missing, 'intent');
  assert.notEqual(result.missing, 'bedrooms');
  assert.notEqual(result.missing, 'propertyType');
  assert.equal(/are you looking to buy or rent|how many bedrooms|what type of property/i.test(result.reply || ''), false);
}

test('search memory TEST 1 location-only change preserves BUY apartment 2BR', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const initial = first.profilePatch.lastSearchFilters;
  assert.equal(initial.purpose, 'Buy');
  assert.equal(initial.type, 'Apartment');
  assert.equal(initial.bedrooms, 2);
  assert.equal(initial.location, 'Dubai South');

  const patch = extractSearchPatch('Show me apartments in Dubai Marina', initial);
  assert.equal(patch.location, 'Dubai Marina');
  assert.equal(patch.bedrooms, undefined);
  assert.equal(patch.purpose, undefined);

  const second = qualifyListingSearch('Show me apartments in Dubai Marina', profileFromQualify(first));
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.location, 'Dubai Marina');
  assertKnownFieldsNotReasked(second);
  assert.deepEqual(getMissingSearchFields(next), []);
});

test('search memory TEST 2 bedroom-only change preserves the rest', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to buy', {});
  const withBudget = qualifyListingSearch('Any budget', profileFromQualify(first));
  const second = qualifyListingSearch('Try 1 BR', profileFromQualify(withBudget));
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 1);
  assert.equal(next.location, 'Dubai Marina');
  assertKnownFieldsNotReasked(second);
  assert.equal(second.missing, null);
});

test('search memory TEST 3 studio instead is bedrooms 0 and not missing', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to buy', {});
  const withBudget = qualifyListingSearch('Any budget', profileFromQualify(first));
  const second = qualifyListingSearch('studio instead', profileFromQualify(withBudget));
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 0);
  assert.equal(isBedroomsResolved(next), true);
  assert.equal(next.location, 'Dubai Marina');
  assert.equal(getMissingSearchFields(next).includes('bedrooms'), false);
  assertKnownFieldsNotReasked(second);
});

test('search memory TEST 4 rent instead clears BUY budget only', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to buy', {});
  const withBudget = qualifyListingSearch('Below 2 million', profileFromQualify(first));
  assert.equal(withBudget.profilePatch.lastSearchFilters.budgetMax, 2000000);
  const second = qualifyListingSearch('rent instead', profileFromQualify(withBudget));
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Rent');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.location, 'Dubai Marina');
  assert.equal(next.budgetMax, null);
  assert.equal(next.budgetProvided, false);
  assert.notEqual(second.missing, 'budget');
  assert.notEqual(second.missing, 'intent');
  assert.notEqual(second.missing, 'bedrooms');
  assert.notEqual(second.missing, 'propertyType');
});

test('search memory TEST 5 villa instead keeps bedrooms and BUY', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to buy', {});
  const withBudget = qualifyListingSearch('Any budget', profileFromQualify(first));
  const second = qualifyListingSearch('villa instead', profileFromQualify(withBudget));
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Villa');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.location, 'Dubai Marina');
  assertKnownFieldsNotReasked(second);
});

test('search memory TEST 6 commercial transition clears bedrooms and keeps BUY', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai Marina to buy', {});
  const second = qualifyListingSearch(
    'actually I need an office in Business Bay',
    profileFromQualify(first)
  );
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Office');
  assert.equal(next.location, 'Business Bay');
  assert.equal(next.bedrooms, null);
  assert.notEqual(second.missing, 'intent');
  assert.notEqual(second.missing, 'bedrooms');
  assert.notEqual(second.missing, 'propertyType');
  assert.equal(getMissingSearchFields(next).includes('bedrooms'), false);
});

test('search memory TEST 7 multiple changes in one message', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const withBudget = qualifyListingSearch('Below 2 million', profileFromQualify(first));
  const second = qualifyListingSearch(
    'I want a 1 bedroom in Dubai Marina below 1.5M instead.',
    profileFromQualify(withBudget)
  );
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Buy');
  assert.equal(next.type, 'Apartment');
  assert.equal(next.bedrooms, 1);
  assert.equal(next.location, 'Dubai Marina');
  assert.equal(next.budgetMax, 1500000);
  assertKnownFieldsNotReasked(second);
});

test('search memory TEST 8 full override rent villa JVC', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const second = qualifyListingSearch(
    'I want to rent a villa in JVC instead.',
    profileFromQualify(first)
  );
  const next = second.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, 'Rent');
  assert.equal(next.type, 'Villa');
  assert.equal(next.location, 'JVC');
  assert.notEqual(next.purpose, 'Buy');
  assert.notEqual(next.type, 'Apartment');
  assert.notEqual(next.location, 'Dubai South');
  assert.equal(next.bedrooms, 2);
  assert.equal(next.budgetProvided, false);
  assert.notEqual(second.missing, 'intent');
  assert.notEqual(second.missing, 'propertyType');
});

test('explicit new search resets property search criteria', () => {
  const first = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  assert.equal(isExplicitSearchReset('Start a new search'), true);
  const reset = qualifyListingSearch('Start a new search', profileFromQualify(first));
  const next = reset.profilePatch.lastSearchFilters;
  assert.equal(next.purpose, null);
  assert.equal(next.type, null);
  assert.equal(next.bedrooms, null);
  assert.equal(next.location, null);
  assert.equal(reset.missing, 'intent');
});

test('page listing references are detected without treating every page as search state', () => {
  assert.equal(isCurrentListingReference('book this unit'), true);
  assert.equal(isCurrentListingReference('similar to this property'), true);
  assert.equal(isCurrentListingReference('Show me apartments in Dubai Marina.'), false);
  assert.equal(isCurrentListingReference('I need a studio room.'), false);
});

test('view-all CTA labels are semantic and URLs stay off the reply', () => {
  assert.equal(
    viewAllCtaLabel({ purpose: 'Buy', type: 'Apartment', types: ['Apartment'], bedrooms: 2, location: 'Dubai South' }),
    'View all 2-bedroom apartments in Dubai South →'
  );
  assert.equal(
    viewAllCtaLabel({ purpose: 'Rent', type: 'Apartment', types: ['Apartment'], bedrooms: 0, location: 'Dubai Marina' }),
    'View all studio apartments for rent in Dubai Marina →'
  );
  assert.equal(
    viewAllCtaLabel({ purpose: 'Buy', type: 'Office', types: ['Office'], location: 'Business Bay' }),
    'View all offices for sale in Business Bay →'
  );
  assert.equal(
    viewAllCtaLabel({ purpose: 'Rent', type: 'Villa', types: ['Villa'], location: 'Arabian Ranches' }),
    'View all villas for rent in Arabian Ranches →'
  );
  const stripped = stripExposedUrlsFromReply(
    'I found 2 matching properties.\n\nView all 2-bedroom apartments in Dubai South →\n\nWould you like to narrow these by budget?'
  );
  assert.equal(/View all /i.test(stripped), false);
  assert.match(stripped, /I found 2 matching properties/);
  assert.match(stripped, /narrow these by budget/);
});

test('property cards omit raw boolean values such as No', () => {
  const card = toPropertyCard({
    propertyRefNo: 'RO-BOOL-1',
    propertyTitle: '2BR apartment in Dubai South',
    price: 'AED 1,249,000, No',
    bedrooms: '2',
    bathrooms: '2',
    propertySize: '1135',
    propertySizeUnit: 'sqft',
    locality: 'Dubai South',
    towerName: 'South Tower',
    furnished: 'No',
    offPlan: 'No',
    features: ['No', 'Yes', 'Pool'],
    images: ['https://example.com/a.jpg'],
  });
  assert.equal(card.price, 'AED 1,249,000');
  assert.equal(card.furnished, '');
  assert.equal(card.completionStatus, null);
  assert.deepEqual(card.features, ['Pool']);
  assert.equal(/,\s*No\b/i.test(card.price), false);
  assert.equal(
    Object.values(card).some(
      (v) => v != null && typeof v !== 'object' && /^(yes|no|true|false|null|undefined)$/i.test(String(v).trim())
    ),
    false
  );
});

test('listing search URLs use q, type, and beds with URLSearchParams encoding', () => {
  const buyUrl = buildListingSearchUrl({
    purpose: 'Buy',
    type: 'Apartment',
    types: ['Apartment'],
    location: 'Dubai South',
    bedrooms: 2,
  });
  assert.match(buyUrl, /\/properties\/buy\/in-dubai\?/);
  assert.match(buyUrl, /q=dubai%20south/);
  assert.match(buyUrl, /[?&]type=apartment/);
  assert.match(buyUrl, /[?&]beds=2/);
  assert.equal(/[?&]search=/i.test(buyUrl), false);
  assert.equal(/[?&]bedrooms=/i.test(buyUrl), false);
  assert.equal(/dubai-south/i.test(buyUrl), false);
  assert.equal(/bayut/i.test(buyUrl), false);

  const rentUrl = buildListingSearchUrl({
    purpose: 'Rent',
    type: 'Apartment',
    types: ['Apartment'],
    location: 'Dubai Marina',
    bedrooms: 1,
  });
  assert.match(rentUrl, /\/properties\/rent\/in-dubai\?/);
  assert.match(rentUrl, /q=dubai%20marina/);
  assert.match(rentUrl, /[?&]type=apartment/);
  assert.match(rentUrl, /[?&]beds=1/);

  const officeUrl = buildListingSearchUrl({
    purpose: 'Buy',
    type: 'Office',
    types: ['Office'],
    location: 'Business Bay',
    bedrooms: 2,
  });
  assert.match(officeUrl, /\/properties\/buy\/in-dubai\?/);
  assert.match(officeUrl, /q=business%20bay/);
  assert.match(officeUrl, /[?&]type=office/);
  assert.equal(/[?&]beds=/i.test(officeUrl), false);
  assert.equal(/[?&]bedrooms=/i.test(officeUrl), false);

  const studioUrl = buildListingSearchUrl({
    purpose: 'Rent',
    type: 'Apartment',
    types: ['Apartment'],
    location: 'Dubai Marina',
    bedrooms: 0,
  });
  assert.match(studioUrl, /\/properties\/rent\/in-dubai\?/);
  assert.match(studioUrl, /q=dubai%20marina/);
  assert.match(studioUrl, /[?&]beds=0/);
  assert.equal(/[?&]bedrooms=/i.test(studioUrl), false);
});

test('location then studio patches keep BUY apartment Dubai Marina', () => {
  const turn1 = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const afterBudget = qualifyListingSearch('Any budget', profileFromQualify(turn1));
  const turn2 = qualifyListingSearch('Show me apartments in Dubai Marina', profileFromQualify(afterBudget));
  const marina = turn2.profilePatch.lastSearchFilters;
  assert.equal(marina.purpose, 'Buy');
  assert.equal(marina.type, 'Apartment');
  assert.equal(marina.bedrooms, 2);
  assert.equal(marina.location, 'Dubai Marina');
  assert.notEqual(turn2.missing, 'intent');
  assert.notEqual(turn2.missing, 'bedrooms');
  assert.notEqual(turn2.missing, 'propertyType');

  const turn3 = qualifyListingSearch('I need a studio room', profileFromQualify(turn2));
  const studio = turn3.profilePatch.lastSearchFilters;
  assert.equal(studio.purpose, 'Buy');
  assert.equal(studio.type, 'Apartment');
  assert.equal(studio.bedrooms, 0);
  assert.equal(studio.location, 'Dubai Marina');
  assert.notEqual(studio.location, 'Dubai South');
  assert.equal(isBedroomsResolved(studio), true);
  assert.notEqual(turn3.missing, 'intent');
  assert.notEqual(turn3.missing, 'propertyType');
});

test('studio search after Marina location change queries BUY studios in Dubai Marina only', async (t) => {
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: 550000,
    averagePrice: 720000,
    maximumPrice: 900000,
    totalAvailable: 4,
  }));
  const seen = [];
  t.mock.method(propertyDbService, 'fetchBuyProperties', async (opts) => {
    seen.push(opts);
    return {
      properties: [
        sampleBuyApartment({
          propertyRefNo: 'ST-MARINA-1',
          bedrooms: '0',
          propertyTitle: 'Studio in Dubai Marina',
          locality: 'Dubai Marina',
        }),
      ],
      total: 4,
    };
  });
  t.mock.method(propertyDbService, 'fetchRentProperties', async () => {
    throw new Error('must not search RENT');
  });

  const turn1 = qualifyListingSearch('I need a 2 BHK apartment in Dubai South to buy', {});
  const afterBudget = qualifyListingSearch('Any budget', profileFromQualify(turn1));
  const turn2 = qualifyListingSearch('Show me apartments in Dubai Marina', profileFromQualify(afterBudget));
  const turn3 = qualifyListingSearch('I need a studio room', profileFromQualify(turn2));
  const filters = turn3.profilePatch.lastSearchFilters;
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: filters,
      userMessage: 'I need a studio room',
      intent: CONVERSATION_INTENTS.BUY,
      previousSearch: turn2.profilePatch.lastSearchFilters,
    }
  );

  assert.equal(result.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(result.effectiveFilters.purpose, 'Buy');
  assert.equal(result.effectiveFilters.bedrooms, 0);
  assert.equal(result.effectiveFilters.location, 'Dubai Marina');
  assert.notEqual(result.effectiveFilters.location, 'Dubai South');
  assert.equal(propertyDbService.fetchRentProperties.mock.calls.length, 0);
  const query = seen.find((opts) => opts.filters?.bedrooms === 0) || seen[seen.length - 1];
  assert.equal(query.search === 'Dubai Marina' || /marina/i.test(query.search || ''), true);
  assert.equal(query.filters.bedrooms, 0);
  assert.equal(result.viewAllMatching.label, 'View all studio apartments in Dubai Marina →');
  assert.match(result.viewAllMatching.url, /[?&]beds=0/);
  assert.match(result.viewAllMatching.url, /q=dubai%20marina/);
  assert.equal(/[?&]bedrooms=/i.test(result.viewAllMatching.url), false);
  assert.equal(/[?&]search=/i.test(result.viewAllMatching.url), false);
  assert.equal(/https?:\/\//i.test(result.replyOverride), false);
  assert.equal(/View all |See all |Browse all /i.test(result.replyOverride), false);
  assert.equal(/See all properties/i.test(result.replyOverride), false);
  assert.equal(/A few options worth looking at/i.test(result.replyOverride), false);
  assert.match(result.replyOverride, /studio/i);
  assert.match(result.replyOverride, /Dubai Marina/i);
  assert.match(result.replyOverride, /switch this to studio apartments/i);
  assert.equal(/Dubai South/i.test(result.replyOverride), false);
  assert.equal(result.responseContext.searchState.bedrooms, 0);
  assert.equal(result.responseContext.searchState.location, 'Dubai Marina');
  assert.equal(result.responseContext.exactMatchCount, 4);
});

test('no exact match includes same-area bedroom counts from the database', async (t) => {
  t.mock.method(propertyDbService, 'getPropertyMarketStats', async () => ({
    minimumPrice: null,
    averagePrice: null,
    maximumPrice: null,
    totalAvailable: 0,
  }));
  t.mock.method(propertyDbService, 'fetchBuyProperties', async (opts) => {
    const beds = opts.filters?.bedrooms;
    const loc = String(opts.search || '');
    if (/jlt/i.test(loc) && beds === 2) {
      return { properties: [sampleBuyApartment({ propertyRefNo: 'JLT-2' })], total: 7 };
    }
    if (/jbr/i.test(loc) && beds === 2) {
      return { properties: [sampleBuyApartment({ propertyRefNo: 'JBR-2' })], total: 4 };
    }
    if (/harbour/i.test(loc) && beds === 2) {
      return { properties: [sampleBuyApartment({ propertyRefNo: 'HAR-2' })], total: 3 };
    }
    if (beds === 2) return { properties: [], total: 0 };
    if (beds === 1) {
      return { properties: [sampleBuyApartment({ propertyRefNo: '1BR', bedrooms: '1' })], total: 6 };
    }
    if (beds === 0) {
      return { properties: [sampleBuyApartment({ propertyRefNo: 'ST', bedrooms: '0' })], total: 5 };
    }
    if (beds === 3) {
      return { properties: [sampleBuyApartment({ propertyRefNo: '3BR', bedrooms: '3' })], total: 3 };
    }
    if (opts.filters?.bedroomsAny || beds == null) {
      return { properties: [sampleBuyApartment({ propertyRefNo: 'ANY' })], total: 14 };
    }
    return { properties: [], total: 0 };
  });

  const last = applyMessageToSearchFilters(
    emptySearchFilters(),
    'I need a 2 BHK apartment in Dubai Marina to buy'
  );
  last.budgetProvided = true;
  const result = await executeTool(
    'search_properties',
    {},
    {
      lastSearchFilters: last,
      userMessage: 'Any budget',
      intent: CONVERSATION_INTENTS.BUY,
    }
  );
  assert.equal(result.searchOutcome, SEARCH_OUTCOME.NO_INVENTORY);
  const alts = result.responseContext.sameAreaAlternatives;
  assert.equal(alts.totalInArea, 14);
  assert.equal(alts.byBedrooms.some((row) => row.bedrooms === 1 && row.count === 6), true);
  assert.match(result.clarificationReply, /14/);
  assert.match(result.clarificationReply, /one-bedroom/i);
  assert.equal(/I can broaden the search/i.test(result.clarificationReply), false);
  const nearby = result.responseContext.nearbyInventory || [];
  assert.equal(nearby.some((row) => row.name === 'JLT' && row.count === 7), true);
  assert.equal(nearby.some((row) => row.name === 'JBR' && row.count === 4), true);
  assert.match(result.clarificationReply, /JLT/);
  assert.equal((result.options || []).includes('Nearby areas') || nearby.length > 0, true);
});


