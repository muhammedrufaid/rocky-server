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
  SELL_OPTIONS,
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
  for (const phrase of ['show me villas there', 'find another villa in Dubai South', 'Try 1 BR']) {
    assert.equal(isListingFollowUp(phrase), true, phrase);
    assert.equal(shouldSkipPropertySearch(phrase), false, phrase);
  }
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
  assert.deepEqual(sellFlowOptions(listing, contact), SELL_OPTIONS);
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

test('multi-property service question is PM, not general content', () => {
  const msg = 'i have 20 properties i need to know what type of services you are providing';
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
