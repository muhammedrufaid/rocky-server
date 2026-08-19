const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLocationFromMessage,
  parseLocationReply,
  wantsDifferentLocation,
  parseDesiredPropertyType,
  parsePropertyTypeChange,
} = require('./chat.tools');

test('does not treat unspecified location phrases as real places', () => {
  const phrases = [
    'but this is apartment i need villa in another locations',
    'show me villas in another area',
    'I need a villa somewhere else',
    'change to villas in another location',
    'I want villas in a different area',
  ];
  for (const phrase of phrases) {
    assert.equal(wantsDifferentLocation(phrase), true, phrase);
    assert.equal(parseLocationFromMessage(phrase), null, phrase);
  }
});

test('still extracts a real named location', () => {
  assert.equal(parseLocationFromMessage('Show me villas in Dubai Hills'), 'Dubai Hills');
  assert.equal(parseLocationFromMessage('apartments in Dubai Marina'), 'Dubai Marina');
  assert.equal(wantsDifferentLocation('Show me villas in Dubai Hills'), false);
});

test('type change prefers villa after "i need" even if apartment is mentioned first', () => {
  assert.equal(
    parsePropertyTypeChange('but this is apartment i need villa in another locations'),
    'Villa'
  );
  assert.equal(parseDesiredPropertyType('show me villas in another area'), 'Villa');
  assert.equal(parsePropertyTypeChange('change to villas in another location'), 'Villa');
  assert.equal(parsePropertyTypeChange('actually show me villas'), 'Villa');
});

test('parseLocationReply accepts a standalone community name', () => {
  assert.equal(parseLocationReply('Dubai South'), 'Dubai South');
  assert.equal(parseLocationReply('Arabian Ranches'), 'Arabian Ranches');
  assert.equal(parseLocationReply('another location'), null);
  assert.equal(parseLocationReply('Buy'), null);
});
