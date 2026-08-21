const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isListingFollowUp,
  isGeneralKnowledgeQuery,
  shouldSkipPropertySearch,
  parseLocationFromMessage,
  rankRelatedContentSources,
  isHomepageUrl,
} = require('./chat.tools');

test('general questions after a search must not reuse listing filters', () => {
  const general = [
    'golden visa eligibility',
    'what are the buying costs?',
    'tell me about property management',
    'flexi rent',
    'ok next need to know about flexi rent payable options',
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

test('Golden Visa related buttons: blog first, off-plan second, never homepage', () => {
  const ranked = rankRelatedContentSources(
    [
      { title: 'Home', url: 'https://www.rockyrealestate.com/' },
      { title: 'Random FAQ', url: 'https://www.rockyrealestate.com/faqs/something' },
    ],
    'golden visa eligibility'
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].url, 'https://www.rockyrealestate.com/blogs/dubai-investor-visa');
  assert.equal(ranked[0].title, 'Dubai Updates Investor Visa: Key Information for You');
  assert.equal(ranked[1].url, 'https://www.rockyrealestate.com/off-plan-properties/in-dubai');
  assert.equal(ranked[1].title, 'Golden Visa Eligibility');
  assert.equal(ranked.every((s) => !isHomepageUrl(s.url)), true);
});

test('non-visa content sources rank blog before listing and drop homepage', () => {
  const ranked = rankRelatedContentSources(
    [
      { title: 'Home', url: 'https://www.rockyrealestate.com/' },
      { title: 'Buy in Dubai', url: 'https://www.rockyrealestate.com/properties/buy/in-dubai', sourceType: 'service' },
      { title: 'Buying guide', url: 'https://www.rockyrealestate.com/blogs/buying-guide', sourceType: 'blog' },
      { title: 'Another blog', url: 'https://www.rockyrealestate.com/blogs/another', sourceType: 'blog' },
    ],
    'what are the buying costs?'
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].title, 'Buying guide');
  assert.equal(ranked[1].title, 'Buy in Dubai');
  assert.equal(ranked.some((s) => isHomepageUrl(s.url)), false);
});
