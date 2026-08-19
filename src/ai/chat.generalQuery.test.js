const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isListingFollowUp,
  isGeneralKnowledgeQuery,
  shouldSkipPropertySearch,
  parseLocationFromMessage,
} = require('./chat.tools');

test('general questions after a search must not reuse listing filters', () => {
  const general = [
    'golden visa eligibility',
    'what are the buying costs?',
    'tell me about property management',
  ];
  for (const phrase of general) {
    assert.equal(isGeneralKnowledgeQuery(phrase), true, phrase);
    assert.equal(shouldSkipPropertySearch(phrase), true, phrase);
    assert.equal(isListingFollowUp(phrase), false, phrase);
    assert.equal(parseLocationFromMessage(phrase), null, phrase);
  }
});

test('listing follow-ups still continue the property search', () => {
  const listing = [
    'show me villas there',
    'find another villa in Dubai South',
    'actually show me villas',
    'Try 1 BR',
    'under 2 million',
  ];
  for (const phrase of listing) {
    assert.equal(isListingFollowUp(phrase), true, phrase);
    assert.equal(shouldSkipPropertySearch(phrase), false, phrase);
    assert.equal(isGeneralKnowledgeQuery(phrase), false, phrase);
  }
});
