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
  buildSellLeadIntent,
  sellFlowOptions,
  SELL_SERVICE_LOCATION_OPTIONS,
  isSellServiceTransitionQuery,
  isMultiPropertyServiceQuery,
  parseSellServiceLocationChoice,
  sellServiceLocationReply,
  isGeneralKnowledgeQuery,
  isServiceInquiryMessage,
  matchesServiceInquiryPhrase,
  serviceContactPromptBlock,
  serviceContactReply,
  seedServiceInquiry,
  hasServiceContact,
  parseServiceContactDetails,
  SELL_OPTIONS,
} = require('./chat.tools');

test('sell intent is not treated as Buy search', () => {
  assert.equal(parseSellIntent('I need to sell my property'), true);
  assert.equal(parsePurposeFromMessage('I need to sell my property'), null);
  assert.equal(shouldSkipPropertySearch('I need to sell my property'), true);
  assert.equal(isListingFollowUp('I need to sell my property'), false);
});

test('buy intent is unchanged', () => {
  assert.equal(parsePurposeFromMessage('Buy'), 'Buy');
  assert.equal(parsePurposeFromMessage('I want to buy'), 'Buy');
  assert.equal(parseSellIntent('Show me villas in Dubai Hills'), false);
});

test('sell details parse type, Barsha location, and discuss-later price', () => {
  const details = parseSellListingDetails('villa, Barsha, amount we can discuss in call', {});
  assert.equal(details.type, 'Villa');
  assert.equal(details.location, 'Al Barsha');
  assert.equal(details.priceNote, 'discuss');
  assert.equal(details.purpose, null);
  const reply = sellClarificationReply(details, 'villa, Barsha, amount we can discuss in call');
  assert.match(reply, /villa in Al Barsha/i);
  assert.doesNotMatch(reply, /bedroom/i);
});

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

test('Test A: sell → villa + Al Barsha → contact → i already shared preserves state', () => {
  const { listing, reply } = runSellTurns([
    'I need to sell my property',
    'al barsha, villa',
    'Ahmed Ali, ahmed@test.com, 0501234567',
    'i already shared',
  ]);
  assert.equal(listing.intent, 'sell');
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.equal(listing.email, 'ahmed@test.com');
  assert.ok(listing.phone);
  assert.ok(listing.name);
  assert.equal(isAlreadySharedDetails('i already shared'), true);
  assert.match(reply, /I have your details/i);
  assert.doesNotMatch(reply, /What type is it/i);
});

test('Test B: get a valuation does not reset sell state or search', () => {
  const { listing, reply } = runSellTurns([
    'I need to sell my property',
    'al barsha, villa',
    'Ahmed Ali, ahmed@test.com, 0501234567',
    'Get a valuation',
  ]);
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.equal(shouldSkipPropertySearch('Get a valuation'), true);
  assert.equal(isSellCta('Get a valuation'), true);
  assert.match(reply, /listing agent for a valuation/i);
  assert.doesNotMatch(reply, /What type is it/i);
});

test('CTA Talk to an agent uses persisted labeled contact, not the CTA message', () => {
  const contact = 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890';
  const { listing, reply } = runSellTurns([
    'Sell My Property',
    'al barsha, villa',
    contact,
    'Talk to an agent',
  ]);
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.match(listing.name, /test ruf/i);
  assert.equal(listing.email, 'testruf@gmail.com');
  assert.ok(listing.phone);
  assert.match(reply, /I have your details/i);
  assert.doesNotMatch(reply, /I still need your name/i);
  assert.doesNotMatch(reply, /What type is it/i);
});

test('CTA Get a valuation uses persisted labeled contact', () => {
  const contact = 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890';
  const { listing, reply } = runSellTurns([
    'Sell My Property',
    'al barsha, villa',
    contact,
    'Get a valuation',
  ]);
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.match(listing.name, /test ruf/i);
  assert.match(reply, /I have your details/i);
  assert.doesNotMatch(reply, /Please share your name, phone, and email/i);
});

test('Talk to an agent with name+email only asks for phone', () => {
  const { listing, reply } = runSellTurns([
    'Sell My Property',
    'al barsha, villa',
    'name: test ruf\nemail: testruf@gmail.com',
    'Talk to an agent',
  ]);
  assert.equal(listing.phone, null);
  assert.equal(listing.email, 'testruf@gmail.com');
  assert.match(reply, /phone number/i);
  assert.doesNotMatch(reply, /I still need your name/i);
});

test('Test C: talk to an agent does not reset sell state or search', () => {
  const { listing, reply } = runSellTurns([
    'I need to sell my property',
    'al barsha, villa',
    'Ahmed Ali, ahmed@test.com, 0501234567',
    'Talk to an agent',
  ]);
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.equal(shouldSkipPropertySearch('Talk to an agent'), true);
  assert.match(reply, /listing agent/i);
  assert.doesNotMatch(reply, /I still need your name/i);
  assert.doesNotMatch(reply, /What type is it/i);
});

test('Talk to an agent recovers labeled contact from history when sellListing contact is empty', () => {
  const history = [
    { role: 'user', content: 'Sell My Property' },
    { role: 'user', content: 'al barsha, villa' },
    { role: 'user', content: 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890' },
  ];
  const listing = advanceSellListing(
    'Talk to an agent',
    { intent: 'sell', type: 'Villa', location: 'Al Barsha' },
    history
  );
  const reply = sellClarificationReply(listing, 'Talk to an agent');
  assert.match(listing.name, /test ruf/i);
  assert.equal(listing.email, 'testruf@gmail.com');
  assert.ok(listing.phone);
  assert.equal(listing.type, 'Villa');
  assert.equal(listing.location, 'Al Barsha');
  assert.match(reply, /I have your details/i);
  assert.doesNotMatch(reply, /I still need your name/i);
});

test('Test D: missing phone asks only for phone', () => {
  let listing = advanceSellListing('al barsha, villa', { intent: 'sell' });
  listing = advanceSellListing('my name is Ahmed, ahmed@test.com', listing);
  const reply = sellClarificationReply(listing, 'Get a valuation');
  assert.equal(listing.name, 'Ahmed');
  assert.equal(listing.email, 'ahmed@test.com');
  assert.equal(listing.phone, null);
  assert.match(reply, /phone/i);
  assert.doesNotMatch(reply, /What type is it/i);
  assert.doesNotMatch(reply, /name, phone, and email/i);
});

test('shouldCaptureSellLead fires on CTA or already-shared when contact is complete', () => {
  const listing = {
    intent: 'sell',
    type: 'Villa',
    location: 'Al Barsha',
    name: 'test ruf',
    email: 'testruf@gmail.com',
    phone: '1234567890',
  };
  assert.equal(hasSellContact(listing), true);
  assert.equal(shouldCaptureSellLead('Talk to an agent', listing), true);
  assert.equal(shouldCaptureSellLead('Get a valuation', listing), true);
  assert.equal(shouldCaptureSellLead('i already shared', listing), true);
  assert.equal(shouldCaptureSellLead('al barsha, villa', listing), false);
  assert.equal(
    buildSellLeadIntent('Talk to an agent', listing),
    'Sell listing - Villa in Al Barsha'
  );
  assert.equal(
    buildSellLeadIntent('Get a valuation', listing),
    'Sell valuation - Villa in Al Barsha'
  );
});

test('partial contact does not trigger sell lead capture', () => {
  const listing = {
    intent: 'sell',
    type: 'Villa',
    location: 'Al Barsha',
    name: 'test ruf',
    email: 'testruf@gmail.com',
    phone: null,
  };
  assert.equal(hasSellContact(listing), false);
  assert.equal(shouldCaptureSellLead('Talk to an agent', listing), false);
});

test('after Talk to an agent with full contact, do not repeat sell chips', () => {
  const contact = 'name: test ruf\nemail: testruf@gmail.com\nphone: 1234567890';
  const { listing, reply } = runSellTurns([
    'Sell My Property',
    'al barsha, villa',
    contact,
    'Talk to an agent',
  ]);
  assert.match(reply, /I'll connect you with a listing agent/i);
  assert.equal(sellFlowOptions(listing, 'Talk to an agent'), null);
  assert.deepEqual(
    sellFlowOptions(listing, contact),
    SELL_OPTIONS,
    'chips should still appear after contact is shared, before CTA'
  );
});

test('after Get a valuation with full contact, do not repeat sell chips', () => {
  const listing = {
    intent: 'sell',
    type: 'Villa',
    location: 'Al Barsha',
    name: 'test ruf',
    email: 'testruf@gmail.com',
    phone: '1234567890',
  };
  assert.equal(sellFlowOptions(listing, 'Get a valuation'), null);
  assert.equal(sellFlowOptions(listing, 'i already shared'), null);
});

test('partial contact does not show sell chips while asking for missing field', () => {
  const listing = {
    intent: 'sell',
    type: 'Villa',
    location: 'Al Barsha',
    name: 'test ruf',
    email: 'testruf@gmail.com',
    phone: null,
  };
  assert.equal(sellFlowOptions(listing, 'Talk to an agent'), null);
});

test('after sell, Property Management asks same vs different location', () => {
  const listing = { intent: 'sell', type: 'Villa', location: 'Al Barsha' };
  assert.equal(isSellServiceTransitionQuery('Property Management'), true);
  assert.match(sellServiceLocationReply(listing), /Al Barsha villa/i);
  assert.match(sellServiceLocationReply(listing), /different area/i);
  assert.deepEqual(SELL_SERVICE_LOCATION_OPTIONS, ['Same property', 'Different location']);
});

test('parseSellServiceLocationChoice recognizes chip answers', () => {
  assert.equal(parseSellServiceLocationChoice('Same property'), 'same');
  assert.equal(parseSellServiceLocationChoice('Different location'), 'different');
});

test('service inquiry with 20 properties is detected without general-knowledge phrasing', () => {
  const msg = 'i have 20 properties i need to know what type of services you are providing';
  assert.equal(isSellServiceTransitionQuery(msg), true);
  assert.equal(isGeneralKnowledgeQuery(msg), false);
  assert.equal(isMultiPropertyServiceQuery(msg), true);
});

test('golden visa after sell does not require same-location chip', () => {
  assert.equal(isSellServiceTransitionQuery('golden visa eligibility'), false);
  assert.equal(isGeneralKnowledgeQuery('golden visa eligibility'), true);
});

test('typo service question is detected after sell context', () => {
  const msg = 'i have 20 properties i need to know whta type of services you are provding?';
  assert.equal(isServiceInquiryMessage(msg), true);
  assert.equal(matchesServiceInquiryPhrase(msg), true);
});

test('PM flow asks same vs different location when sell location exists', () => {
  const listing = { type: 'Villa', location: 'Al Barsha' };
  const inquiry = { propertyNote: '20 properties' };
  assert.match(sellServiceLocationReply(listing, inquiry), /20 properties/i);
  assert.match(sellServiceLocationReply(listing, inquiry), /Al Barsha/i);
});

test('service contact prompt includes whatsapp and optional email', () => {
  assert.match(serviceContactPromptBlock(), /whatsapp:/i);
  assert.match(serviceContactPromptBlock(), /optional/i);
});

test('reuses sell contact and asks only for whatsapp when phone exists', () => {
  const inquiry = seedServiceInquiry(
    {},
    { name: 'test ruf', email: 'test@test.com', phone: '0501234567', location: 'Al Barsha' },
    [],
    'Property Management'
  );
  inquiry.locationScope = 'same';
  const reply = serviceContactReply(inquiry);
  assert.equal(reply, 'Can you provide your WhatsApp number?');
});

test('same number reuses phone as whatsapp', () => {
  const inquiry = parseServiceContactDetails('same number', {
    intent: 'property_management',
    name: 'test ruf',
    phone: '0501234567',
    whatsapp: null,
  });
  assert.equal(inquiry.whatsapp, '0501234567');
  assert.equal(hasServiceContact(inquiry), true);
});

test('Test E: I already gave you my details does not repeat the contact ask when complete', () => {
  const { listing, reply } = runSellTurns([
    'I need to sell my property',
    'al barsha, villa',
    'Ahmed Ali, ahmed@test.com, 0501234567',
    'I already gave you my details',
  ]);
  assert.ok(listing.email);
  assert.match(reply, /I have your details/i);
  assert.doesNotMatch(reply, /Please share your name, phone, and email/i);
  assert.doesNotMatch(reply, /What type is it/i);
});
