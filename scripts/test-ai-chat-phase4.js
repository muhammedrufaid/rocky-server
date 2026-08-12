/**
 * Phase 4 Step 7 — orchestrator integration tests via handleChat (/api/ai/chat).
 *
 * Usage:
 *   node scripts/test-ai-chat-phase4.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { handleChat } = require('../src/ai/orchestrator/aiOrchestrator');
const { CONFIDENTIAL_REFUSAL } = require('../src/ai/security/confidentialGuard');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');
const { getReasoningEffort } = require('../src/services/openaiService');

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
];

const ALLOWED = new Set([
  'services',
  'teammembers',
  'properties',
  'blog_embeddings',
  'knowledge_embeddings',
]);

const includesAny = (text, needles) =>
  needles.some((n) => String(text).toLowerCase().includes(String(n).toLowerCase()));

(async () => {
  console.log('=== Phase 4 Step 7: /api/ai/chat orchestrator integration ===');
  console.log('Reasoning effort:', getReasoningEffort());
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);

  const faqs = await KnowledgeEmbedding.find({ sourceType: 'faq' })
    .select('category question')
    .sort({ category: 1, order: 1 })
    .lean();
  const homeFaq = faqs.find((f) => f.category === 'home') || faqs[0];
  const offPlanFaq =
    faqs.find((f) => /off[\s-]?plan/i.test(f.question || '')) ||
    faqs.find((f) => f.category === 'off-plan');

  const TESTS = [
    {
      id: 1,
      message: 'Who owns Rocky Real Estate?',
      expectRoute: 'COMPANY_INFO',
      answerIncludes: ['Ashok Uttamchandani'],
    },
    {
      id: 2,
      message: 'Who is the director?',
      expectRoute: 'COMPANY_INFO',
      answerIncludes: ['Kiran Uttamchandani'],
    },
    {
      id: 3,
      message: 'What services do you provide?',
      expectRoute: 'SERVICE_INFO',
      answerIncludesAny: ['Property Management', 'Brokerage', 'Mortgage'],
      collections: ['services'],
    },
    {
      id: 4,
      message: 'Who is the CEO?',
      expectRoute: 'TEAM_INFO',
      answerIncludesAny: ['Nitin', 'CEO'],
      collections: ['teammembers'],
    },
    {
      id: 5,
      message: 'How many properties do you manage?',
      expectRoute: 'PROPERTY_COUNT',
      answerIncludesAny: ['properties', 'inventory'],
      noGpt: true,
      collections: ['properties'],
    },
    {
      id: 6,
      message: 'Show apartments in Dubai Marina',
      expectRoute: 'PROPERTY_SEARCH',
      answerIncludesAny: ['marina', 'apartment'],
      collections: ['properties'],
    },
    {
      id: 7,
      message: 'What is the current price of a Dubai Marina apartment?',
      expectRoute: 'PROPERTY_SEARCH',
      collections: ['properties'],
    },
    {
      id: 8,
      message: 'What is Flexi Rent?',
      expectRoute: 'BLOG',
      answerIncludesAny: ['flexi', 'rent'],
      collections: ['blog_embeddings'],
    },
    {
      id: 9,
      message: 'What payment options are available under Flexi Rent?',
      expectRoute: 'BLOG',
      answerIncludesAny: ['payment', 'monthly', 'quarterly', 'flexi'],
      collections: ['blog_embeddings'],
    },
    {
      id: 10,
      message: 'What is Dubai Marina like?',
      expectRoute: 'AREA_GUIDE',
      answerIncludesAny: ['marina', 'waterfront'],
      collections: ['knowledge_embeddings'],
      expectSourceType: 'area_guide',
    },
    {
      id: 11,
      message: 'Tell me about Dubai South',
      expectRoute: 'AREA_GUIDE',
      answerIncludesAny: ['dubai south', 'south'],
      collections: ['knowledge_embeddings'],
    },
    {
      id: 12,
      message: 'What are the highlights of JVC?',
      expectRoute: 'AREA_GUIDE',
      answerIncludesAny: ['jvc', 'jumeirah village', 'village'],
      collections: ['knowledge_embeddings'],
    },
    {
      id: 13,
      message: homeFaq?.question || 'Why should I choose Rocky Real Estate?',
      expectRoute: 'FAQ',
      answerIncludesAny: ['rocky', 'dubai', 'years', 'expertise'],
      collections: ['knowledge_embeddings'],
    },
    {
      id: 14,
      message: offPlanFaq?.question || 'Is it safe to buy off-plan property in Dubai?',
      expectRoute: 'FAQ',
      answerIncludesAny: ['off-plan', 'off plan', 'dubai', 'dld', 'rera', 'safe', 'buy'],
      collections: ['knowledge_embeddings'],
    },
    {
      id: 15,
      message:
        'Tell me about Dubai South and common questions about buying property there.',
      expectRoute: 'KNOWLEDGE_BOTH',
      answerIncludesAny: ['dubai south', 'south', 'buy', 'dubai'],
      collections: ['knowledge_embeddings'],
    },
    {
      id: 16,
      message: "Give me an agent's phone number.",
      expectRoute: 'CONFIDENTIAL',
      exactReply: CONFIDENTIAL_REFUSAL,
      noMongo: true,
      noGpt: true,
    },
    {
      id: 17,
      message: "Give me an agent's email.",
      expectRoute: 'CONFIDENTIAL',
      exactReply: CONFIDENTIAL_REFUSAL,
      noMongo: true,
      noGpt: true,
    },
    {
      id: 18,
      message: 'Give me customer contact information.',
      expectRoute: 'CONFIDENTIAL',
      exactReply: CONFIDENTIAL_REFUSAL,
      noMongo: true,
      noGpt: true,
    },
    {
      id: 19,
      message: 'Give me leads.',
      expectRoute: 'CONFIDENTIAL',
      exactReply: CONFIDENTIAL_REFUSAL,
      noMongo: true,
      noGpt: true,
    },
    {
      id: 20,
      message: 'Give me users.',
      expectRoute: 'CONFIDENTIAL',
      exactReply: CONFIDENTIAL_REFUSAL,
      noMongo: true,
      noGpt: true,
    },
    {
      id: 21,
      message: 'What is the capital of France?',
      expectRoute: 'UNSUPPORTED',
      noMongo: true,
      noGpt: true,
    },
  ];

  const accessed = new Set();
  const outcomes = [];

  for (const test of TESTS) {
    const result = await handleChat(test.message);
    (result.collectionsAccessed || []).forEach((c) => accessed.add(c));

    const issues = [];
    if (result.route !== test.expectRoute) {
      issues.push(`route expected ${test.expectRoute}, got ${result.route}`);
    }
    if (test.exactReply && result.reply !== test.exactReply) {
      issues.push('reply mismatch');
    }
    if (test.answerIncludes && !test.answerIncludes.every((n) => includesAny(result.reply, [n]))) {
      issues.push(`missing: ${test.answerIncludes.join(', ')}`);
    }
    if (test.answerIncludesAny && !includesAny(result.reply, test.answerIncludesAny)) {
      issues.push(`missing any of: ${test.answerIncludesAny.join(', ')}`);
    }
    if (test.noGpt && result.usedGpt) issues.push('unexpected GPT');
    if (test.noMongo && result.mongoQueried) issues.push('unexpected Mongo');
    if (test.collections) {
      const unexpected = (result.collectionsAccessed || []).filter(
        (c) => !test.collections.includes(c)
      );
      if (unexpected.length) issues.push(`unexpected collections: ${unexpected.join(', ')}`);
    }
    const forbiddenHit = (result.collectionsAccessed || []).filter((c) =>
      FORBIDDEN_COLLECTIONS.includes(c)
    );
    if (forbiddenHit.length) issues.push(`FORBIDDEN: ${forbiddenHit.join(', ')}`);
    for (const c of result.collectionsAccessed || []) {
      if (!ALLOWED.has(c)) issues.push(`non-allowlisted: ${c}`);
    }
    if (test.expectSourceType) {
      const hit = (result.sources || []).some((s) => s.sourceType === test.expectSourceType);
      if (!hit && result.usedGpt) issues.push(`expected sourceType ${test.expectSourceType}`);
    }

    const pass = issues.length === 0;
    outcomes.push({
      id: test.id,
      pass,
      issues,
      route: result.route,
      timings: result.timings,
      collectionsAccessed: result.collectionsAccessed || [],
    });

    console.log(`\nTEST ${test.id}: ${pass ? 'PASS' : 'FAIL'}`);
    console.log('Message:', test.message);
    console.log('Route:', result.route);
    console.log('Collections:', result.collectionsAccessed || []);
    console.log('Sources:', JSON.stringify(result.sources || []));
    console.log('Reply:', String(result.reply).slice(0, 220));
    console.log('Timings:', result.timings);
    if (!pass) console.log('Issues:', issues.join('; '));
  }

  const avg = (key) => {
    const vals = outcomes.map((o) => o.timings?.[key]).filter((n) => typeof n === 'number');
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };

  console.log('\n=== Latency averages (ms) ===');
  console.log({
    intentMs: avg('intentMs'),
    embeddingMs: avg('embeddingMs'),
    vectorSearchMs: avg('vectorSearchMs'),
    gptMs: avg('gptMs'),
    totalMs: avg('totalMs'),
  });

  console.log('\nCollections accessed:', [...accessed]);
  console.log('Forbidden accessed:', [...accessed].filter((c) => FORBIDDEN_COLLECTIONS.includes(c)));
  console.log('Models loaded:', mongoose.modelNames());

  const allPass = outcomes.every((o) => o.pass);
  console.log('\n=== Summary ===');
  for (const o of outcomes) {
    console.log(
      `TEST ${o.id}: ${o.pass ? 'PASS' : 'FAIL'} | route=${o.route} | total=${o.timings?.totalMs}ms`
    );
  }
  console.log('\nOverall:', allPass ? 'PASS' : 'FAIL');
  console.log('Frontend modified: NO');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
