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
} = require('./chat.tools');
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

test('natural language extracts buy, 2 BHK, apartment, and Dubai South without clarification', () => {
  const msg = 'I need a 2 BHK apartment in Dubai South to buy.';
  assert.equal(parsePurposeFromMessage(msg), 'Buy');
  assert.equal(parseConversationIntent(msg), CONVERSATION_INTENTS.BUY);
  assert.deepEqual(parseBedroomChoice(msg), parseBedroomChoice('2 BR'));
  assert.equal(parseBedroomChoice(msg).exact, 2);
  assert.equal(parseLocationFromMessage(msg), 'Dubai South');

  const profile = startFreshIntent(CONVERSATION_INTENTS.BUY, msg, {});
  assert.equal(profile.intent, CONVERSATION_INTENTS.BUY);
  assert.equal(profile.lastSearchFilters.purpose, 'Buy');
  assert.equal(profile.lastSearchFilters.bedrooms, 2);
  assert.equal(profile.lastSearchFilters.type, 'Apartment');
  assert.equal(profile.lastSearchFilters.location, 'Dubai South');
  assert.equal(isBedroomsResolved(profile.lastSearchFilters), true);
  assert.equal(needsListingIntake(profile.lastSearchFilters), false);
  assert.equal(listingStartReply(CONVERSATION_INTENTS.BUY, profile, msg), null);
  assert.equal(purposeClarificationReply(), 'What are you looking for?');
  assert.equal(bedroomsClarificationReply(), 'How many bedrooms?');
});

test('extracts max budget from a full listing sentence', () => {
  const msg = 'I need a 2 BHK apartment in Dubai South to buy under AED 1.5M.';
  const filters = applyMessageToSearchFilters(emptySearchFilters(), msg);
  assert.equal(filters.purpose, 'Buy');
  assert.equal(filters.bedrooms, 2);
  assert.equal(filters.type, 'Apartment');
  assert.equal(filters.location, 'Dubai South');
  assert.equal(filters.budgetMax, 1500000);
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
  assert.deepEqual(result.options, ['Nearby areas', 'Studio', '1 BR', 'Change budget']);
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
  assert.deepEqual(result.options, ['Nearby areas', 'Change bedrooms', 'Property type']);
});

test('listings are returned immediately when no budget is supplied', async (t) => {
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
    }
  );

  assert.equal(result.searchOutcome, SEARCH_OUTCOME.MATCHES_FOUND);
  assert.equal(result.needsPurpose, undefined);
  assert.equal(result.needsBedrooms, undefined);
  assert.equal((result.propertyCards || []).length > 0, true);
  assert.equal(/what is your (maximum )?budget/i.test(result.replyOverride || ''), false);
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
  assert.equal(formatAed(1700000), 'AED 1.7M');
  assert.equal(formatAed(2000000), 'AED 2M');
  assert.equal(formatAed(12500000), 'AED 12.5M');
});


