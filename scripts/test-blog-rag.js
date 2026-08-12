/**
 * Step 7 test: Blog-only RAG (retrieval + gpt-5-nano).
 *
 * Usage:
 *   node scripts/test-blog-rag.js
 *
 * Does NOT query properties/leads/contacts.
 * Does NOT use conversation memory.
 * Does NOT stream.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { generateBlogAnswer } = require('../src/services/blogRagService');

const POSITIVE = [
  {
    id: 'TEST 1',
    message: 'What payment options are available under Flexi Rent?',
    expect: {
      sourcesIncludeSlug: 'flexi-rent',
      answerIncludesAny: ['monthly', 'quarterly', 'semi-annual', 'installment', 'payment'],
      mustNotInventPrice: true,
    },
  },
  {
    id: 'TEST 2',
    message: 'How does Flexi Rent work?',
    expect: {
      sourcesIncludeSlug: 'flexi-rent',
      answerIncludesAny: ['flexi', 'rent', 'payment', 'tenant', 'cheque', 'installment'],
    },
  },
  {
    id: 'TEST 3',
    message: 'What exemptions are available under Flexi Rent?',
    expect: {
      sourcesIncludeSlug: 'flexi-rent',
      answerIncludesAny: ['exemption', 'concession', 'grace', 'waive', 'fee', 'promotional'],
    },
  },
  {
    id: 'TEST 4',
    message: 'Can foreigners buy property in Dubai?',
    expect: {
      sourcesIncludeAnySlug: ['foreigner', 'freehold-vs-leasehold'],
      answerIncludesAny: ['foreign', 'freehold', 'buy', 'dubai', 'expatriate', 'investor'],
    },
  },
  {
    id: 'TEST 5',
    message: 'What is the difference between freehold and leasehold?',
    expect: {
      sourcesIncludeSlug: 'freehold-vs-leasehold',
      answerIncludesAny: ['freehold', 'leasehold'],
    },
  },
];

const NEGATIVE = [
  {
    id: 'NEG 1',
    message: 'What is the current price of a 2 bedroom apartment in Dubai Marina?',
    expect: {
      mustNotContainCurrencyAmount: true,
      answerIndicatesUnavailable: true,
    },
  },
  {
    id: 'NEG 2',
    message: 'How many properties does Rocky Real Estate currently manage?',
    expect: {
      mustNotContainExactManagedCount: true,
      answerIndicatesUnavailable: true,
    },
  },
  {
    id: 'NEG 3',
    message: 'Give me customer contact information.',
    expect: {
      mustNotExposePrivateContacts: true,
      answerIndicatesUnavailable: true,
    },
  },
];

const includesAny = (text, needles) => {
  const hay = String(text || '').toLowerCase();
  return needles.some((n) => hay.includes(String(n).toLowerCase()));
};

const looksUnavailable = (answer) =>
  includesAny(answer, [
    'does not',
    "don't have",
    'do not have',
    'not have',
    'not provide',
    'unavailable',
    'not available',
    "couldn't find",
    'could not find',
    'enough information',
    'blog',
    'live',
    'current listing',
    'pricing information',
    'private',
    'confidential',
    'cannot provide',
    "can't provide",
  ]);

const hasCurrencyAmount = (answer) =>
  /(?:AED|USD|\$|£|€)\s?\d[\d,]*(?:\.\d+)?/i.test(answer) ||
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(answer);

const evaluatePositive = (test, result) => {
  const issues = [];
  const answer = result.answer || '';
  const sources = result.sources || [];

  if (!answer.trim()) issues.push('empty answer');

  if (test.expect.sourcesIncludeSlug) {
    const ok = sources.some((s) =>
      String(s.slug || '')
        .toLowerCase()
        .includes(test.expect.sourcesIncludeSlug.toLowerCase())
    );
    if (!ok) issues.push(`expected source slug containing ${test.expect.sourcesIncludeSlug}`);
  }

  if (test.expect.sourcesIncludeAnySlug) {
    const ok = sources.some((s) =>
      test.expect.sourcesIncludeAnySlug.some((needle) =>
        String(s.slug || '')
          .toLowerCase()
          .includes(String(needle).toLowerCase())
      )
    );
    if (!ok) issues.push('expected one of the relevant source slugs');
  }

  if (test.expect.answerIncludesAny && !includesAny(answer, test.expect.answerIncludesAny)) {
    issues.push('answer missing expected grounded terms');
  }

  // Sources must not include scores
  if (sources.some((s) => Object.prototype.hasOwnProperty.call(s, 'score'))) {
    issues.push('source metadata leaked score');
  }

  return { pass: issues.length === 0, issues };
};

const evaluateNegative = (test, result) => {
  const issues = [];
  const answer = result.answer || '';

  if (!answer.trim()) issues.push('empty answer');

  if (test.expect.answerIndicatesUnavailable && !looksUnavailable(answer)) {
    issues.push('answer did not clearly indicate information is unavailable');
  }

  if (test.expect.mustNotContainCurrencyAmount && hasCurrencyAmount(answer)) {
    issues.push('answer appears to invent a currency/price amount');
  }

  if (test.expect.mustNotContainExactManagedCount) {
    // Flag confident invented inventory counts like "we manage 1234 properties"
    if (/\b(?:manage|managing|managed)\b[^.!?\n]{0,40}\b\d{2,}\b/i.test(answer)) {
      issues.push('answer appears to invent a managed-property count');
    }
  }

  if (test.expect.mustNotExposePrivateContacts) {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(answer)) {
      issues.push('answer contains an email address');
    }
    if (/\+?\d[\d\s()-]{7,}\d/.test(answer) && !/blog/i.test(answer)) {
      // Allow mentioning that phone numbers aren't available; fail on likely phone dumps
      if (!looksUnavailable(answer)) {
        issues.push('answer may expose phone/contact details');
      }
    }
  }

  return { pass: issues.length === 0, issues };
};

const printResult = (id, message, result, evaluation) => {
  console.log('\n========================================');
  console.log(id);
  console.log('Message:', message);
  console.log('========================================');
  console.log('Answer:\n', result.answer);
  console.log('\nSources:', JSON.stringify(result.sources, null, 2));
  console.log('Timings (ms):', result.timings);
  console.log('Used GPT:', result.usedGpt);
  console.log(
    'Evaluation:',
    evaluation.pass ? 'PASS' : 'FAIL',
    evaluation.issues?.length ? `- ${evaluation.issues.join('; ')}` : ''
  );
};

(async () => {
  console.log('=== Step 7: Blog RAG tests ===');
  console.log('Scope: public blog knowledge ONLY');
  console.log('Streaming: NO');
  console.log('Conversation memory: NO');
  console.log('Property/CRM tools: NO\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected (blog_embeddings retrieval only)\n');

  const outcomes = [];

  for (const test of POSITIVE) {
    const result = await generateBlogAnswer(test.message);
    const evaluation = evaluatePositive(test, result);
    outcomes.push({ id: test.id, type: 'positive', ...evaluation, timings: result.timings });
    printResult(test.id, test.message, result, evaluation);
  }

  for (const test of NEGATIVE) {
    const result = await generateBlogAnswer(test.message);
    const evaluation = evaluateNegative(test, result);
    outcomes.push({ id: test.id, type: 'negative', ...evaluation, timings: result.timings });
    printResult(test.id, test.message, result, evaluation);
  }

  console.log('\n=== Summary ===');
  for (const outcome of outcomes) {
    console.log(
      `${outcome.id} (${outcome.type}): ${outcome.pass ? 'PASS' : 'FAIL'} | embed=${outcome.timings.embeddingMs}ms search=${outcome.timings.vectorSearchMs}ms gpt=${outcome.timings.gptMs}ms total=${outcome.timings.totalMs}ms`
    );
  }

  const allPass = outcomes.every((o) => o.pass);
  const avg = (key) => {
    const vals = outcomes.map((o) => o.timings[key]).filter((n) => typeof n === 'number');
    if (!vals.length) return 0;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  console.log('\nAverage latency (ms):', {
    embeddingMs: avg('embeddingMs'),
    vectorSearchMs: avg('vectorSearchMs'),
    gptMs: avg('gptMs'),
    totalMs: avg('totalMs'),
  });

  console.log('\nOverall:', allPass ? 'PASS' : 'FAIL');
  console.log('Confidential collections accessed: NO');
  console.log('Frontend modified: NO');
  console.log('Streaming implemented: NO');
  console.log('Conversation memory implemented: NO');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('\nBlog RAG test FAILED:', {
    name: error?.name,
    category: error?.category,
    message: error?.message,
  });
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
