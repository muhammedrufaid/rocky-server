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
  parseDesiredPropertyType,
  parsePropertyTypeChange,
  rankRelatedContentSources,
  isHomepageUrl,
  emptyResultsReply,
  locationEmptyNearbyReply,
  CONVERSATION_INTENTS,
  parseConversationIntent,
  isExplicitIntentStarter,
  startFreshIntent,
  listingStartReply,
  pmNeedReply,
  PM_NEED_OPTIONS,
  parsePmNeedChoice,
  needsListingIntake,
  applyMessageToSearchFilters,
  parsePropertyTypesFromMessage,
  parseOtherCustomType,
  mergePropertyTypes,
  typesFromFilters,
  applyTypesToFilters,
  isShowMoreRequest,
  isSimilarPropertyRequest,
  isSearchContinuation,
  isPropertyDetailRequest,
  searchSignatureFromFilters,
  foundListingsReply,
  hasExecutedListingSearch,
  classifyListingSearchTurn,
  buildSearchExecutionPlan,
  SEARCH_TURN,
  exhaustedResultsReply,
  replyForZeroHits,
  canUseInitialEmptyResults,
  filtersFromRequestBody,
  uniqueIdList,
  listingQueryOpts,
  resolveEffectiveFilters,
  copySearchFilters,
  emptySearchFilters,
  applyBedroomChoice,
  applyBudgetChoice,
  nearbyAreaOptions,
  newAreaEmptyReply,
  similarEmptyReply,
  widenSimilarSearchFilters,
  parseEmptyResultChoice,
  emptyResultOptions,
} = require('./chat.tools');

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
    'show me villas there',
    'find another villa in Dubai South',
    'Try 1 BR',
    'Show me more',
    'show me more properties',
    'i need more properties in dubai marina',
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
  assert.match(listingStartReply(CONVERSATION_INTENTS.RENT, afterReset, 'Rent a Property'), /rent/i);
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
  assert.match(listingStartReply(CONVERSATION_INTENTS.OFF_PLAN, offPlan, 'Off-Plan'), /off-plan/i);
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
  assert.equal(profile.slotFlow.awaiting, 'listingIntake');
  const withType = startFreshIntent(CONVERSATION_INTENTS.BUY, 'I want to buy a villa in Arabian Ranches', {});
  assert.equal(needsListingIntake(withType.lastSearchFilters), false);
  assert.equal(withType.lastSearchFilters.type, 'Villa');
  assert.equal(withType.lastSearchFilters.location, 'Arabian Ranches');
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
  assert.equal(isShowMoreRequest('i need more properties in dubai marina'), true);
  assert.equal(isShowMoreRequest('see more'), true);
  assert.equal(isShowMoreRequest('tell me more'), false);
  assert.equal(isShowMoreRequest('more details'), false);
  assert.equal(isShowMoreRequest('the first one'), false);
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

test('RENT search signature stays stable for the same filters', () => {
  const filters = applyMessageToSearchFilters(emptySearchFilters(), '2 bedroom apartment in Dubai Marina');
  filters.purpose = 'Rent';
  applyBedroomChoice(filters, { exact: 2 });
  const signature = searchSignatureFromFilters(filters);
  assert.match(signature, /Rent/i);
  assert.match(signature, /apartment/i);
  assert.match(signature, /dubai marina/i);
  assert.match(signature, /2 BR/);
  assert.equal(searchSignatureFromFilters(filters), signature);
});

test('RENT continuation is not a new search; location/bedroom changes are', () => {
  const filters = applyMessageToSearchFilters(emptySearchFilters(), '2 bedroom apartment in Dubai Marina');
  filters.purpose = 'Rent';
  applyBedroomChoice(filters, { exact: 2 });
  const executed = { searchAlreadyExecuted: true };

  assert.equal(isSearchContinuation('show me more', filters, executed), true);
  assert.equal(isSearchContinuation('i need more properties in dubai marina', filters, executed), true);
  assert.equal(isSearchContinuation("yes i'm looking 2 bedroom", filters, executed), true);
  assert.equal(isSearchContinuation('yes', filters, executed), true);

  assert.equal(isSearchContinuation('3 BR', filters, executed), false);
  assert.equal(isSearchContinuation('i need more properties in Downtown Dubai', filters, executed), false);
  assert.equal(isSearchContinuation('See similar properties', filters, executed), false);
  assert.equal(isSearchContinuation('Nearby areas', filters, executed), false);
  assert.equal(isSearchContinuation('Change budget', filters, executed), false);
  assert.equal(isPropertyDetailRequest('tell me more about this property'), true);
  assert.equal(shouldSkipPropertySearch('tell me more about this property'), true);
  assert.equal(isListingFollowUp('tell me more about this property'), false);
});

test('continuation replies are not the initial Looking for search-status', () => {
  const filters = {
    purpose: 'Rent',
    location: 'Dubai Marina',
    type: 'Apartment',
    types: ['Apartment'],
    bedrooms: 2,
  };
  const initialEmpty = emptyResultsReply(filters);
  assert.match(initialEmpty, /Looking for a 2-bedroom apartment in Dubai Marina/i);

  const continuation = foundListingsReply(filters, 12, { isShowMore: true, newCount: 3 });
  assert.equal(/Looking for/i.test(continuation), false);
  assert.match(continuation, /more matching/i);

  const firstHit = foundListingsReply(filters, 12, { isShowMore: false, newCount: 6 });
  assert.equal(/Looking for/i.test(firstHit), false);
  assert.match(firstHit, /I found 12/i);
});

test('Buy search purpose and restart behavior is unchanged', () => {
  assert.equal(parsePurposeFromMessage('Buy villas in Arabian Ranches under 5 million'), 'Buy');
  const buy = startFreshIntent(CONVERSATION_INTENTS.BUY, 'Buy a Property', {});
  assert.equal(buy.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(buy.lastSearchFilters.purpose, 'Buy');
  assert.equal(buy.searchAlreadyExecuted, false);
  const rent = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', buy);
  assert.equal(rent.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(rent.lastSearchFilters.purpose, 'Rent');
  assert.equal(parseConversationIntent('Buy a Property'), CONVERSATION_INTENTS.BUY);
});

function marinaRentFilters() {
  const filters = emptySearchFilters();
  filters.purpose = 'Rent';
  filters.location = 'Dubai Marina';
  applyTypesToFilters(filters, ['Apartment']);
  applyBedroomChoice(filters, { exact: 2 });
  return filters;
}

function marinaRentProfile(overrides = {}) {
  const lastSearchFilters = marinaRentFilters();
  return {
    intent: CONVERSATION_INTENTS.RENT,
    purpose: 'Rent',
    lastSearchFilters,
    searchAlreadyExecuted: true,
    lastSearchSignature: searchSignatureFromFilters(lastSearchFilters),
    shownPropertyIds: ['RO-R-1'],
    lastPropertyCards: [{ id: 'RO-R-1', title: 'Marina 2BR' }],
    ...overrides,
  };
}

function classifyFromProfile(message, profile) {
  return classifyListingSearchTurn({
    userMessage: message,
    lastSearchFilters: profile.lastSearchFilters,
    searchAlreadyExecuted: profile.searchAlreadyExecuted,
    lastSearchSignature: profile.lastSearchSignature,
    shownPropertyIds: profile.shownPropertyIds,
    lastPropertyCards: profile.lastPropertyCards,
  });
}

function planFromProfile(message, profile, effectiveFilters) {
  return buildSearchExecutionPlan({
    userMessage: message,
    lastSearchFilters: profile.lastSearchFilters,
    searchAlreadyExecuted: profile.searchAlreadyExecuted,
    lastSearchSignature: profile.lastSearchSignature,
    shownPropertyIds: profile.shownPropertyIds,
    lastPropertyCards: profile.lastPropertyCards,
    effectiveFilters: effectiveFilters || profile.lastSearchFilters,
  });
}

test('RENT screenshot flow: initial search status only on first search', () => {
  const intake = startFreshIntent(CONVERSATION_INTENTS.RENT, 'Rent a Property', {});
  assert.equal(intake.intent, CONVERSATION_INTENTS.RENT);
  assert.equal(intake.searchAlreadyExecuted, false);
  assert.deepEqual(intake.shownPropertyIds, []);

  const filters = marinaRentFilters();
  const beforeSearch = {
    intent: CONVERSATION_INTENTS.RENT,
    purpose: 'Rent',
    lastSearchFilters: filters,
    searchAlreadyExecuted: false,
    lastSearchSignature: null,
    shownPropertyIds: [],
    lastPropertyCards: [],
  };
  const kind = classifyFromProfile('2 BR', beforeSearch);
  assert.equal(kind, SEARCH_TURN.INITIAL);
  const initialStatus = replyForZeroHits(kind, filters, 0);
  assert.match(initialStatus, /Looking for a 2-bedroom apartment in Dubai Marina/i);
  assert.equal(hasExecutedListingSearch(beforeSearch), false);

  const afterFirstHit = marinaRentProfile();
  assert.equal(hasExecutedListingSearch(afterFirstHit), true);
  assert.equal(afterFirstHit.lastSearchSignature, searchSignatureFromFilters(filters));
});

test('RENT screenshot flow: more properties in Dubai Marina is continuation, not Looking for', () => {
  const profile = marinaRentProfile();
  const message = 'i need more properties in dubai marina';
  const kind = classifyFromProfile(message, profile);
  assert.equal(kind, SEARCH_TURN.CONTINUATION);
  const reply = replyForZeroHits(kind, profile.lastSearchFilters, profile.shownPropertyIds.length);
  assert.equal(/Looking for/i.test(reply), false);
  assert.match(reply, /already shown/i);
  assert.equal(reply, exhaustedResultsReply(profile.lastSearchFilters, 1));
});

test('RENT screenshot flow: restated 2 bedroom is continuation, not Looking for', () => {
  const profile = marinaRentProfile();
  const message = "yes i'm looking 2 bedroom";
  const kind = classifyFromProfile(message, profile);
  assert.equal(kind, SEARCH_TURN.CONTINUATION);
  assert.equal(isSearchContinuation(message, profile.lastSearchFilters, { searchAlreadyExecuted: true }), true);
  const reply = replyForZeroHits(kind, profile.lastSearchFilters, 1);
  assert.equal(/Looking for/i.test(reply), false);
  assert.equal(reply, exhaustedResultsReply(profile.lastSearchFilters, 1));
});

test('RENT screenshot flow: show me more excludes already shown listing IDs', () => {
  const profile = marinaRentProfile({ shownPropertyIds: ['RO-R-1', 'RO-R-2'] });
  const message = 'show me more';
  const kind = classifyFromProfile(message, profile);
  assert.equal(kind, SEARCH_TURN.CONTINUATION);
  const plan = planFromProfile(message, profile);
  assert.equal(plan.resetShown, false);
  assert.deepEqual(plan.excludeIds, ['RO-R-1', 'RO-R-2']);
  assert.equal(plan.sameSearch, true);
  const opts = listingQueryOpts(
    { ...profile.lastSearchFilters, excludeRefNos: plan.excludeIds },
    profile.lastSearchFilters.location
  );
  assert.deepEqual(opts.filters.excludeRefNos, ['RO-R-1', 'RO-R-2']);
});

test('RENT screenshot flow: exhausted inventory is not emptyResultsReply', () => {
  const profile = marinaRentProfile();
  const kind = classifyFromProfile('show me more', profile);
  const exhausted = replyForZeroHits(kind, profile.lastSearchFilters, 1);
  const initialEmpty = emptyResultsReply(profile.lastSearchFilters);
  assert.match(initialEmpty, /Looking for a 2-bedroom apartment in Dubai Marina/i);
  assert.notEqual(exhausted, initialEmpty);
  assert.equal(/Looking for/i.test(exhausted), false);
  assert.match(exhausted, /already shown/i);
});

test('RENT screenshot flow: repeating the same filters never repeats Looking for', () => {
  const profile = marinaRentProfile();
  const repeats = [
    'show me more',
    'i need more properties in dubai marina',
    "yes i'm looking 2 bedroom",
    'more properties',
    'show another property',
    'only 1 listing is available in dubai marina',
    '2 bedroom apartment in Dubai Marina',
  ];
  const initialEmpty = replyForZeroHits(SEARCH_TURN.INITIAL, profile.lastSearchFilters, 0);
  assert.equal(initialEmpty, emptyResultsReply(profile.lastSearchFilters));
  for (const message of repeats) {
    const kind = classifyFromProfile(message, profile);
    assert.equal(kind, SEARCH_TURN.CONTINUATION, message);
    const reply = replyForZeroHits(kind, profile.lastSearchFilters, 1);
    assert.equal(/Looking for/i.test(reply), false, message);
  }
});

test('RENT screenshot flow: 2 BR to 3 BR is a new search', () => {
  const profile = marinaRentProfile();
  const kind = classifyFromProfile('3 BR', profile);
  assert.equal(kind, SEARCH_TURN.FILTER_UPDATE);
  const nextFilters = copySearchFilters(profile.lastSearchFilters);
  applyBedroomChoice(nextFilters, { exact: 3 });
  const plan = planFromProfile('3 BR', profile, nextFilters);
  assert.equal(plan.turnKind, SEARCH_TURN.FILTER_UPDATE);
  assert.equal(plan.resetShown, true);
  assert.deepEqual(plan.excludeIds, []);
  assert.equal(plan.sameSearch, false);
  assert.notEqual(plan.signature, profile.lastSearchSignature);
  const newSearchReply = replyForZeroHits(kind, nextFilters, 0);
  assert.match(newSearchReply, /Looking for/i);
});

test('RENT screenshot flow: Dubai Marina to Downtown Dubai is a new area search', () => {
  const profile = marinaRentProfile();
  const message = 'i need more properties in Downtown Dubai';
  const kind = classifyFromProfile(message, profile);
  assert.equal(kind, SEARCH_TURN.NEW_AREA);
  assert.equal(isSearchContinuation(message, profile.lastSearchFilters, { searchAlreadyExecuted: true }), false);
  const nextFilters = copySearchFilters(profile.lastSearchFilters);
  nextFilters.location = 'Downtown Dubai';
  const plan = planFromProfile(message, profile, nextFilters);
  assert.equal(plan.turnKind, SEARCH_TURN.NEW_AREA);
  assert.equal(plan.resetShown, true);
  assert.deepEqual(plan.excludeIds, []);
  assert.notEqual(plan.signature, profile.lastSearchSignature);
});

test('RENT screenshot flow: property details do not search listings', () => {
  const profile = marinaRentProfile();
  const message = 'Tell me more about this property.';
  assert.equal(classifyFromProfile(message, profile), SEARCH_TURN.PROPERTY_DETAILS);
  assert.equal(isPropertyDetailRequest(message), true);
  assert.equal(shouldSkipPropertySearch(message), true);
  assert.equal(isSearchContinuation(message, profile.lastSearchFilters, { searchAlreadyExecuted: true }), false);
  assert.equal(isShowMoreRequest(message), false);
});

test('RENT screenshot flow: Rent to Buy resets search state and does not reuse Rent results', () => {
  const rent = marinaRentProfile();
  const buy = startFreshIntent(CONVERSATION_INTENTS.BUY, 'Buy a Property', rent);
  assert.equal(buy.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(buy.lastSearchFilters.purpose, 'Buy');
  assert.equal(buy.searchAlreadyExecuted, false);
  assert.equal(buy.lastSearchSignature, null);
  assert.deepEqual(buy.shownPropertyIds, []);
  assert.deepEqual(buy.lastPropertyCards, []);
  assert.notEqual(buy.lastSearchFilters.location, rent.lastSearchFilters.location);
});

test('RENT screenshot flow: missing signature after a listing still cannot use Looking for', () => {
  const profile = marinaRentProfile({
    searchAlreadyExecuted: false,
    lastSearchSignature: null,
  });
  assert.equal(hasExecutedListingSearch(profile), true);
  const message = 'i need more properties in dubai marina';
  const kind = classifyFromProfile(message, profile);
  assert.equal(kind, SEARCH_TURN.CONTINUATION);
  const plan = planFromProfile(message, profile);
  assert.equal(plan.executed, true);
  assert.equal(plan.sameSearch, true);
  assert.equal(plan.resetShown, false);
  assert.deepEqual(plan.excludeIds, ['RO-R-1']);
  assert.equal(
    canUseInitialEmptyResults({
      turnKind: plan.turnKind,
      sameSearch: plan.sameSearch,
      executed: plan.executed,
    }),
    false
  );
  const reply = replyForZeroHits(kind, profile.lastSearchFilters, 1, {
    sameSearch: plan.sameSearch,
    executed: plan.executed,
  });
  assert.equal(/Looking for/i.test(reply), false);
  assert.equal(reply, exhaustedResultsReply(profile.lastSearchFilters, 1));
});

test('emptyResultsReply is only allowed for an initial or filter-update search', () => {
  const filters = marinaRentFilters();
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.INITIAL, sameSearch: false, executed: false }),
    true
  );
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.FILTER_UPDATE, sameSearch: false, executed: true }),
    true
  );
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.CONTINUATION, sameSearch: true, executed: true }),
    false
  );
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.EXHAUSTED, sameSearch: true, executed: true }),
    false
  );
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.SIMILAR, sameSearch: false, executed: true }),
    false
  );
  assert.equal(
    canUseInitialEmptyResults({ turnKind: SEARCH_TURN.NEW_AREA, sameSearch: false, executed: true }),
    false
  );
  assert.match(replyForZeroHits(SEARCH_TURN.INITIAL, filters, 0), /Looking for/i);
  assert.equal(/Looking for/i.test(replyForZeroHits(SEARCH_TURN.CONTINUATION, filters, 1)), false);
  assert.equal(/already shown/i.test(replyForZeroHits(SEARCH_TURN.NEW_AREA, { ...filters, location: 'JBR' }, 0)), false);
  assert.equal(/already shown/i.test(replyForZeroHits(SEARCH_TURN.SIMILAR, filters, 1)), false);
});

test('property detail phrases do not search listings', () => {
  const profile = marinaRentProfile();
  for (const message of [
    'Tell me more about this property.',
    'what are the details?',
    'show property details',
  ]) {
    assert.equal(isPropertyDetailRequest(message), true, message);
    assert.equal(shouldSkipPropertySearch(message), true, message);
    assert.equal(classifyFromProfile(message, profile), SEARCH_TURN.PROPERTY_DETAILS, message);
  }
});

test('See similar properties is not an exact-search replay', () => {
  const profile = marinaRentProfile({ exploredAreas: ['Dubai Marina'] });
  const message = 'See similar properties';
  assert.equal(isSimilarPropertyRequest(message), true);
  assert.equal(isShowMoreRequest(message), false);
  assert.equal(isSearchContinuation(message, profile.lastSearchFilters, { searchAlreadyExecuted: true }), false);
  assert.equal(classifyFromProfile(message, profile), SEARCH_TURN.SIMILAR);

  const similarFilters = widenSimilarSearchFilters(profile.lastSearchFilters, profile.exploredAreas);
  assert.equal(similarFilters.purpose, 'Rent');
  assert.deepEqual(similarFilters.types, ['Apartment']);
  assert.equal(similarFilters.bedrooms, 2);
  assert.equal(similarFilters.budgetMax, null);
  assert.notEqual(String(similarFilters.location).toLowerCase(), 'dubai marina');
  assert.match(String(similarFilters.location), /JBR|JLT|Palm Jumeirah|Bluewaters/i);

  const plan = planFromProfile(message, profile, similarFilters);
  assert.equal(plan.turnKind, SEARCH_TURN.SIMILAR);
  assert.equal(plan.sameSearch, false);
  assert.equal(plan.resetShown, false);
  assert.deepEqual(plan.excludeIds, ['RO-R-1']);
  assert.equal(plan.signature, 'Rent|apartment|jbr|2 BR');
  assert.notEqual(plan.signature, profile.lastSearchSignature);

  const similarEmpty = replyForZeroHits(SEARCH_TURN.SIMILAR, similarFilters, 1);
  assert.equal(similarEmpty, similarEmptyReply(similarFilters));
  assert.equal(/already shown/i.test(similarEmpty), false);
  assert.equal(/Looking for/i.test(similarEmpty), false);
  assert.match(similarEmpty, /similar properties/i);
});

test('Marina nearby areas are geographically related, not a generic inland list', () => {
  const marina = nearbyAreaOptions('Dubai Marina', ['Dubai Marina']);
  assert.deepEqual(marina.slice(0, 4), ['JBR', 'JLT', 'Palm Jumeirah', 'Bluewaters Island']);
  for (const inland of ['Dubai Hills', 'Mudon', 'Town Square', 'Arabian Ranches']) {
    assert.equal(marina.includes(inland), false, inland);
  }
});

test('Marina to JBR is a new area search with a new signature', () => {
  const profile = marinaRentProfile({ exploredAreas: ['Dubai Marina'] });
  const message = 'JBR';
  assert.equal(classifyFromProfile(message, profile), SEARCH_TURN.NEW_AREA);
  assert.equal(parseLocationReply(message), 'JBR');

  const nextFilters = copySearchFilters(profile.lastSearchFilters);
  nextFilters.location = 'JBR';
  const plan = planFromProfile(message, profile, nextFilters);
  assert.equal(plan.turnKind, SEARCH_TURN.NEW_AREA);
  assert.equal(plan.sameSearch, false);
  assert.equal(plan.resetShown, true);
  assert.deepEqual(plan.excludeIds, []);
  assert.equal(plan.signature, 'Rent|apartment|jbr|2 BR');
  assert.notEqual(plan.signature, profile.lastSearchSignature);
  assert.notEqual(plan.signature, searchSignatureFromFilters(profile.lastSearchFilters));
});

test('JBR zero results uses new-area copy, not exact-search exhausted copy', () => {
  const jbrFilters = copySearchFilters(marinaRentFilters());
  jbrFilters.location = 'JBR';
  const reply = replyForZeroHits(SEARCH_TURN.NEW_AREA, jbrFilters, 0);
  assert.equal(reply, newAreaEmptyReply(jbrFilters));
  assert.match(reply, /couldn't find a matching 2-bedroom apartment in JBR/i);
  assert.equal(/already shown/i.test(reply), false);
  assert.equal(/Looking for/i.test(reply), false);
  assert.notEqual(reply, exhaustedResultsReply(jbrFilters, 1));
  assert.notEqual(reply, emptyResultsReply(jbrFilters));
});

test('JBR nearby areas stay in the Marina cluster and skip explored areas', () => {
  const options = nearbyAreaOptions('JBR', ['Dubai Marina', 'JBR']);
  assert.equal(options.includes('Dubai Marina'), false);
  assert.equal(options.includes('JBR'), false);
  for (const inland of ['Dubai Hills', 'Mudon', 'Town Square', 'Arabian Ranches']) {
    assert.equal(options.includes(inland), false, inland);
  }
  assert.ok(options.includes('JLT'));
  assert.ok(options.includes('Palm Jumeirah'));
  assert.ok(options.includes('Bluewaters Island'));

  const emptyNearby = nearbyAreaOptions('JBR', ['Dubai Marina', 'JBR', 'JLT', 'Palm Jumeirah', 'Bluewaters Island']);
  assert.deepEqual(emptyNearby, []);
  const ctas = emptyResultOptions({ ...marinaRentFilters(), location: 'JBR' }, [
    'Dubai Marina',
    'JBR',
    'JLT',
    'Palm Jumeirah',
    'Bluewaters Island',
  ]);
  assert.equal(ctas.includes('Nearby areas'), false);
  assert.ok(ctas.includes('Try 1 BR'));
  assert.ok(ctas.includes('Change budget'));
});

test('Try 1 BR and budget change create new search signatures', () => {
  const profile = marinaRentProfile();
  assert.equal(classifyFromProfile('Try 1 BR', profile), SEARCH_TURN.FILTER_UPDATE);
  assert.deepEqual(parseEmptyResultChoice('Try 1 BR'), { bedrooms: { exact: 1 } });

  const oneBed = copySearchFilters(profile.lastSearchFilters);
  applyBedroomChoice(oneBed, { exact: 1 });
  const bedPlan = planFromProfile('Try 1 BR', profile, oneBed);
  assert.equal(bedPlan.turnKind, SEARCH_TURN.FILTER_UPDATE);
  assert.equal(bedPlan.resetShown, true);
  assert.deepEqual(bedPlan.excludeIds, []);
  assert.equal(bedPlan.signature, 'Rent|apartment|dubai marina|1 BR');
  assert.notEqual(bedPlan.signature, profile.lastSearchSignature);

  assert.deepEqual(parseEmptyResultChoice('Change budget'), { budget: true });
  const withBudget = copySearchFilters(profile.lastSearchFilters);
  applyBudgetChoice(withBudget, { budgetMax: 150000 });
  const budgetPlan = planFromProfile('under 150000 AED', profile, withBudget);
  assert.equal(budgetPlan.turnKind, SEARCH_TURN.FILTER_UPDATE);
  assert.equal(budgetPlan.resetShown, true);
  assert.equal(budgetPlan.signature, 'Rent|apartment|dubai marina|2 BR|150000');
  assert.notEqual(budgetPlan.signature, profile.lastSearchSignature);
});

test('CTA labels map to distinct search intents', () => {
  const profile = marinaRentProfile();
  assert.equal(isSimilarPropertyRequest('See similar properties'), true);
  assert.equal(isShowMoreRequest('See similar properties'), false);
  assert.equal(classifyFromProfile('See similar properties', profile), SEARCH_TURN.SIMILAR);

  assert.deepEqual(parseEmptyResultChoice('Nearby areas'), { nearby: true });
  assert.equal(isShowMoreRequest('Nearby areas'), false);
  assert.equal(isSimilarPropertyRequest('Nearby areas'), false);

  assert.equal(classifyFromProfile('Try 1 BR', profile), SEARCH_TURN.FILTER_UPDATE);
  assert.equal(classifyFromProfile('JBR', profile), SEARCH_TURN.NEW_AREA);
  assert.equal(classifyFromProfile('show me more', profile), SEARCH_TURN.CONTINUATION);
  assert.equal(classifyFromProfile('Tell me more about this property.', profile), SEARCH_TURN.PROPERTY_DETAILS);
});

test('repeated show-more clicks keep excluding shownPropertyIds', () => {
  const profile = marinaRentProfile({ shownPropertyIds: ['RO-R-1', 'RO-R-2'] });
  const first = planFromProfile('show me more', profile);
  const second = planFromProfile('show me more', profile);
  assert.equal(first.turnKind, SEARCH_TURN.CONTINUATION);
  assert.equal(second.turnKind, SEARCH_TURN.CONTINUATION);
  assert.deepEqual(first.excludeIds, ['RO-R-1', 'RO-R-2']);
  assert.deepEqual(second.excludeIds, first.excludeIds);
  assert.equal(first.sameSearch, true);
  assert.equal(first.resetShown, false);
  const opts = listingQueryOpts(
    { ...profile.lastSearchFilters, excludeRefNos: first.excludeIds },
    profile.lastSearchFilters.location
  );
  assert.deepEqual(opts.filters.excludeRefNos, ['RO-R-1', 'RO-R-2']);
});

