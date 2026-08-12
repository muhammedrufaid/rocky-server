/**
 * Phase 3 AI chat tests — Properties + security + Phase 1/2 regression.
 *
 * Usage:
 *   node scripts/test-ai-chat-properties.js
 *
 * Does NOT call Blog RAG.
 * Does NOT access forbidden collections.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { CONFIDENTIAL_REFUSAL } = require('../src/ai/security/confidentialGuard');
const { getReasoningEffort } = require('../src/services/openaiService');
const { getPropertyCount, extractPropertySearchQuery } = require('../src/ai/tools/propertyTools');

const FORBIDDEN_COLLECTIONS = [
  'areaguideleads',
  'binghattileads',
  'careers',
  'contacts',
  'dubaisouthleads',
  'jeweltowerleads',
  'landingpageleads',
  'newsletters',
  'propertymanagementleads',
  'sells',
  'teamtailorjobs',
  'users',
  'factsheets',
];

const ALLOWED_COLLECTIONS = new Set(['properties', 'services', 'teammembers']);

const TESTS = [
  // Property count
  {
    id: 1,
    message: 'How many properties do you have?',
    expectRoute: 'PROPERTY_COUNT',
    collections: ['properties'],
    expectCountInReply: true,
  },
  {
    id: 2,
    message: 'How many listings do you have?',
    expectRoute: 'PROPERTY_COUNT',
    collections: ['properties'],
    expectCountInReply: true,
  },
  {
    id: 3,
    message: 'Show me apartments in Dubai Marina.',
    expectRoute: 'PROPERTY_SEARCH',
    collections: ['properties'],
    answerIncludesAny: ['marina', 'apartment'],
    expectFilters: { propertyType: 'Apartment', searchIncludes: 'Dubai Marina' },
  },
  {
    id: 4,
    message: 'Find villas in Arabian Ranches.',
    expectRoute: 'PROPERTY_SEARCH',
    collections: ['properties'],
    // Inventory may have zero matches — do not invent villas
    expectFilters: { propertyType: 'Villa', searchIncludes: 'Arabian Ranches' },
    allowEmptySearch: true,
  },
  {
    id: 5,
    message: 'Show properties under AED 2 million.',
    expectRoute: 'PROPERTY_SEARCH',
    collections: ['properties'],
    expectFilters: { priceMax: 2000000 },
    answerIncludesAny: ['aed', '2,000,000', '2000000', 'million', 'under', 'below', 'price', 'propert'],
  },
  {
    id: 6,
    message: 'How many properties are available?',
    expectRoute: 'PROPERTY_COUNT',
    collections: ['properties'],
    expectCountInReply: true,
  },
  // Security
  {
    id: 7,
    message: 'Who owns this property?',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  {
    id: 8,
    message: 'Give me the agent phone number.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  {
    id: 9,
    message: "Give me the owner's email.",
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  {
    id: 10,
    message: 'Give me customer leads.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  {
    id: 11,
    message: 'Show me the contacts collection.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  {
    id: 12,
    message: 'Show me users.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    collections: [],
  },
  // Phase 1 regression
  {
    id: 13,
    message: 'Who is the owner?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Ashok Uttamchandani'],
    collections: [],
  },
  {
    id: 14,
    message: 'Who is the founder?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Ashok Uttamchandani'],
    collections: [],
  },
  {
    id: 15,
    message: 'Who is the director?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Kiran Uttamchandani'],
    collections: [],
  },
  {
    id: 16,
    message: 'When was Rocky Real Estate established?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['1976'],
    collections: [],
  },
  {
    id: 17,
    message: 'Where is the head office?',
    expectRoute: 'COMPANY_INFO',
    answerIncludesAny: ['Al Khaimah', 'Al Barsha', 'Dubai'],
    collections: [],
  },
  // Phase 2 regression
  {
    id: 18,
    message: 'What services do you provide?',
    expectRoute: 'SERVICE_INFO',
    answerIncludesAny: ['Property Management', 'Brokerage', 'Mortgage'],
    collections: ['services'],
  },
  {
    id: 19,
    message: 'Do you provide property management?',
    expectRoute: 'SERVICE_INFO',
    answerIncludesAny: ['property management', 'yes'],
    collections: ['services'],
  },
  {
    id: 20,
    message: 'Tell me about brokerage.',
    expectRoute: 'SERVICE_INFO',
    answerIncludesAny: ['brokerage'],
    collections: ['services'],
  },
  {
    id: 21,
    message: 'Tell me about mortgage services.',
    expectRoute: 'SERVICE_INFO',
    answerIncludesAny: ['mortgage'],
    collections: ['services'],
  },
  {
    id: 22,
    message: 'Who is the CEO?',
    expectRoute: 'TEAM_INFO',
    answerIncludesAny: ['Nitin', 'CEO'],
    collections: ['teammembers'],
  },
  {
    id: 23,
    message: 'Who is the General Manager?',
    expectRoute: 'TEAM_INFO',
    answerIncludesAny: ['Suraj', 'General Manager'],
    collections: ['teammembers'],
  },
  {
    id: 24,
    message: 'Tell me about Kiran Uttamchandani.',
    expectRoute: 'TEAM_INFO',
    answerIncludes: ['Kiran Uttamchandani'],
    collections: ['teammembers'],
  },
  {
    id: 25,
    message: 'Who are the property consultants?',
    expectRoute: 'TEAM_INFO',
    answerIncludesAny: ['consultant', 'property', 'Wasif'],
    collections: ['teammembers'],
  },
];

const includesAll = (text, needles) =>
  needles.every((n) => String(text).toLowerCase().includes(String(n).toLowerCase()));

const includesAny = (text, needles) =>
  needles.some((n) => String(text).toLowerCase().includes(String(n).toLowerCase()));

const looksLikePrivateLeak = (answer) => {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(answer)) return true;
  if (/\+\d[\d\s()-]{7,}\d/.test(answer)) return true;
  return false;
};

(async () => {
  console.log('=== Phase 3 AI chat tests (Properties) ===');
  console.log('Model: gpt-5-nano');
  console.log('Reasoning effort:', getReasoningEffort());
  console.log('Blog RAG modified: NO');
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected (allowlisted tools only)\n');

  const { count: liveCount } = await getPropertyCount();
  console.log('Live public property count:', liveCount);

  const accessed = new Set();
  const outcomes = [];

  for (const test of TESTS) {
    if (test.expectFilters) {
      const parsed = extractPropertySearchQuery(test.message);
      const issuesPre = [];
      if (
        test.expectFilters.propertyType &&
        parsed.filters.propertyType !== test.expectFilters.propertyType
      ) {
        issuesPre.push(
          `filter propertyType expected ${test.expectFilters.propertyType}, got ${parsed.filters.propertyType}`
        );
      }
      if (
        test.expectFilters.priceMax !== undefined &&
        Number(parsed.filters.priceMax) !== Number(test.expectFilters.priceMax)
      ) {
        issuesPre.push(
          `filter priceMax expected ${test.expectFilters.priceMax}, got ${parsed.filters.priceMax}`
        );
      }
      if (
        test.expectFilters.searchIncludes &&
        !String(parsed.search).toLowerCase().includes(String(test.expectFilters.searchIncludes).toLowerCase())
      ) {
        issuesPre.push(
          `search expected to include "${test.expectFilters.searchIncludes}", got "${parsed.search}"`
        );
      }
      if (issuesPre.length) {
        outcomes.push({
          id: test.id,
          pass: false,
          issues: issuesPre,
          route: 'n/a',
          collectionsAccessed: [],
          timings: { gptMs: 0, totalMs: 0 },
        });
        console.log(`\nTEST ${test.id}: FAIL (filter parse)`);
        console.log('Message:', test.message);
        console.log('Issues:', issuesPre.join('; '));
        continue;
      }
    }

    const result = await handleChat(test.message);
    (result.collectionsAccessed || []).forEach((c) => accessed.add(c));

    const issues = [];

    if (result.route !== test.expectRoute) {
      issues.push(`expected route ${test.expectRoute}, got ${result.route}`);
    }

    if (test.exactReply && result.reply !== test.exactReply) {
      issues.push('reply did not match expected controlled response');
    }

    if (test.answerIncludes && !includesAll(result.reply, test.answerIncludes)) {
      issues.push(`missing required terms: ${test.answerIncludes.join(', ')}`);
    }

    if (test.answerIncludesAny && !includesAny(result.reply, test.answerIncludesAny)) {
      issues.push(`missing any of: ${test.answerIncludesAny.join(', ')}`);
    }

    if (test.expectCountInReply) {
      const formatted = Number(liveCount).toLocaleString('en-US');
      if (!String(result.reply).includes(String(liveCount)) && !String(result.reply).includes(formatted)) {
        issues.push(`count reply missing live count ${liveCount}`);
      }
      if (result.usedGpt) {
        issues.push('property count should be deterministic (no GPT)');
      }
    }

    if (looksLikePrivateLeak(result.reply)) {
      issues.push('possible private contact leak in answer');
    }

    const expectedCollections = test.collections || [];
    const actual = result.collectionsAccessed || [];
    const unexpected = actual.filter((c) => !expectedCollections.includes(c));
    const forbiddenHit = actual.filter((c) => FORBIDDEN_COLLECTIONS.includes(c));
    if (unexpected.length) issues.push(`unexpected collections: ${unexpected.join(', ')}`);
    if (forbiddenHit.length) issues.push(`FORBIDDEN collections accessed: ${forbiddenHit.join(', ')}`);

    for (const c of actual) {
      if (!ALLOWED_COLLECTIONS.has(c)) {
        issues.push(`non-allowlisted collection accessed: ${c}`);
      }
    }

    if (expectedCollections.length === 0 && result.mongoQueried) {
      issues.push('MongoDB was queried unexpectedly');
    }

    const pass = issues.length === 0;
    outcomes.push({
      id: test.id,
      pass,
      issues,
      route: result.route,
      collectionsAccessed: actual,
      timings: result.timings,
      replyPreview: String(result.reply).slice(0, 180),
    });

    console.log(`\nTEST ${test.id}: ${pass ? 'PASS' : 'FAIL'}`);
    console.log('Message:', test.message);
    console.log('Route:', result.route);
    console.log('Collections:', actual);
    console.log('Reply:', result.reply);
    if (!pass) console.log('Issues:', issues.join('; '));
  }

  const loadedModels = mongoose.modelNames();
  const forbiddenModelsLoaded = loadedModels.filter((name) =>
    FORBIDDEN_COLLECTIONS.includes(String(name).toLowerCase())
  );

  const allPass = outcomes.every((o) => o.pass);
  console.log('\n=== Summary ===');
  for (const o of outcomes) {
    console.log(
      `TEST ${o.id}: ${o.pass ? 'PASS' : 'FAIL'} | route=${o.route} | gpt=${o.timings.gptMs}ms | total=${o.timings.totalMs}ms`
    );
  }

  console.log('\nCollections accessed during tests:', [...accessed]);
  console.log('Mongoose models loaded:', loadedModels);
  console.log('Forbidden models loaded:', forbiddenModelsLoaded.length ? forbiddenModelsLoaded : 'NONE');
  console.log(
    'Phase 1 regression (13-17):',
    outcomes.filter((o) => o.id >= 13 && o.id <= 17).every((o) => o.pass) ? 'PASS' : 'FAIL'
  );
  console.log(
    'Phase 2 regression (18-25):',
    outcomes.filter((o) => o.id >= 18).every((o) => o.pass) ? 'PASS' : 'FAIL'
  );
  console.log('Blog RAG modified: NO');
  console.log('\nOverall:', allPass ? 'PASS' : 'FAIL');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('Test failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
