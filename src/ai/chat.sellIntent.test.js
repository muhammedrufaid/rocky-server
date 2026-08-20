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
