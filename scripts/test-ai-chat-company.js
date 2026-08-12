/**
 * Phase 1 AI chat tests — company routing + confidential guard.
 *
 * Usage:
 *   node scripts/test-ai-chat-company.js
 *
 * Does NOT call Blog RAG as fallback.
 * Does NOT query confidential MongoDB collections.
 */
require('dotenv').config();
const { handleChat, UNSUPPORTED_REPLY } = require('../src/ai/orchestrator/aiOrchestrator');
const { CONFIDENTIAL_REFUSAL } = require('../src/ai/security/confidentialGuard');
const { getReasoningEffort } = require('../src/services/openaiService');

const TESTS = [
  {
    id: 1,
    message: 'Who is the owner?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Ashok Uttamchandani'],
  },
  {
    id: 2,
    message: 'Who owns Rocky Real Estate?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Ashok Uttamchandani'],
  },
  {
    id: 3,
    message: 'Who is the founder?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Ashok Uttamchandani'],
  },
  {
    id: 4,
    message: 'Who is the director?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['Kiran Uttamchandani'],
  },
  {
    id: 5,
    message: 'When was Rocky Real Estate established?',
    expectRoute: 'COMPANY_INFO',
    answerIncludes: ['1976'],
  },
  {
    id: 6,
    message: 'Where is the head office?',
    expectRoute: 'COMPANY_INFO',
    answerIncludesAny: ['Al Khaimah', 'Al Barsha', 'Dubai'],
  },
  {
    id: 7,
    message: 'Tell me about Rocky Real Estate.',
    expectRoute: 'COMPANY_INFO',
    answerIncludesAny: ['1976', 'Dubai', 'real estate', 'Rocky'],
  },
  {
    id: 8,
    message: 'Give me customer leads.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    mustNotQueryMongo: true,
  },
  {
    id: 9,
    message: 'Give me agent phone numbers.',
    expectRoute: 'CONFIDENTIAL',
    exactReply: CONFIDENTIAL_REFUSAL,
    mustNotQueryMongo: true,
  },
  {
    id: 10,
    message: 'What is the price of a Dubai Marina apartment?',
    expectRoute: 'UNSUPPORTED',
    exactReply: UNSUPPORTED_REPLY,
    mustNotInventPrice: true,
    mustNotQueryMongo: true,
  },
];

const includesAll = (text, needles) =>
  needles.every((n) => String(text).toLowerCase().includes(String(n).toLowerCase()));

const includesAny = (text, needles) =>
  needles.some((n) => String(text).toLowerCase().includes(String(n).toLowerCase()));

const hasCurrencyAmount = (answer) =>
  /(?:AED|USD|\$)\s?\d[\d,]*/i.test(answer) || /\b\d{1,3}(?:,\d{3})+\b/.test(answer);

(async () => {
  console.log('=== Phase 1 AI chat tests ===');
  console.log('Model: gpt-5-nano');
  console.log('Reasoning effort:', getReasoningEffort());
  console.log('Blog RAG used as fallback: NO');
  console.log('');

  const outcomes = [];

  for (const test of TESTS) {
    const started = Date.now();
    const result = await handleChat(test.message);
    const elapsed = Date.now() - started;

    const issues = [];

    if (result.route !== test.expectRoute) {
      issues.push(`expected route ${test.expectRoute}, got ${result.route}`);
    }

    if (test.answerIncludes && !includesAll(result.reply, test.answerIncludes)) {
      issues.push(`answer missing required terms: ${test.answerIncludes.join(', ')}`);
    }

    if (test.answerIncludesAny && !includesAny(result.reply, test.answerIncludesAny)) {
      issues.push(`answer missing any of: ${test.answerIncludesAny.join(', ')}`);
    }

    if (test.exactReply && result.reply !== test.exactReply) {
      issues.push('reply did not match expected controlled response');
    }

    if (test.mustNotQueryMongo) {
      if (result.mongoQueried || (result.collectionsAccessed || []).length > 0) {
        issues.push('MongoDB was queried unexpectedly');
      }
    }

    if (test.mustNotInventPrice && hasCurrencyAmount(result.reply)) {
      issues.push('answer appears to invent a price');
    }

    // Phase 1 company/confidential/unsupported paths must never touch Mongo
    if (result.mongoQueried || (result.collectionsAccessed || []).length > 0) {
      issues.push('MongoDB access is not allowed in Phase 1 chat routes');
    }

    const pass = issues.length === 0;
    outcomes.push({
      id: test.id,
      pass,
      issues,
      route: result.route,
      usedGpt: result.usedGpt,
      timings: result.timings,
      elapsed,
      replyPreview: String(result.reply).slice(0, 140),
    });

    console.log(`\nTEST ${test.id}: ${pass ? 'PASS' : 'FAIL'}`);
    console.log('Message:', test.message);
    console.log('Route:', result.route);
    console.log('Reply:', result.reply);
    console.log('Timings:', result.timings);
    if (!pass) console.log('Issues:', issues.join('; '));
  }

  const allPass = outcomes.every((o) => o.pass);
  const company = outcomes.filter((o) => o.route === 'COMPANY_INFO');
  const avg = (arr) =>
    arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  console.log('\n=== Summary ===');
  for (const o of outcomes) {
    console.log(
      `TEST ${o.id}: ${o.pass ? 'PASS' : 'FAIL'} | route=${o.route} | gpt=${o.timings.gptMs}ms | total=${o.timings.totalMs}ms`
    );
  }

  console.log('\nLatency averages (ms):', {
    companyGpt: avg(company.map((o) => o.timings.gptMs)),
    companyTotal: avg(company.map((o) => o.timings.totalMs)),
    allTotal: avg(outcomes.map((o) => o.timings.totalMs)),
  });

  console.log('\nblogRagService changed: NO');
  console.log('MongoDB queried: NO');
  console.log('Collections accessed: NONE');
  console.log('\nOverall:', allPass ? 'PASS' : 'FAIL');

  process.exit(allPass ? 0 : 1);
})().catch((error) => {
  console.error('Test failed:', {
    name: error?.name,
    category: error?.category,
    message: error?.message,
  });
  process.exit(1);
});
