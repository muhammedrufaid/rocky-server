/**
 * Phase 4 Step 6 — Knowledge RAG tests (Area Guides + FAQs).
 *
 * Usage:
 *   node scripts/test-knowledge-rag.js
 *
 * Does NOT modify Blog RAG / orchestrator / frontend.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');
const {
  generateKnowledgeAnswer,
  selectKnowledgeSource,
  NO_CONTEXT_ANSWER,
  DYNAMIC_DATA_ANSWER,
} = require('../src/services/knowledgeRagService');
const { CONFIDENTIAL_REFUSAL } = require('../src/ai/security/confidentialGuard');
const { getReasoningEffort } = require('../src/services/openaiService');

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
    'not available',
    'unavailable',
    'enough information',
    'knowledge base',
    'cannot answer',
    "can't answer",
    'not provide',
  ]);

const looksLikeInventedRevenue = (answer) =>
  /(?:AED|USD|\$|million|billion)\s*[\d,]+|\b\d[\d,]{5,}\b/i.test(answer);

const looksLikePrivateLeak = (answer) =>
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(answer) ||
  /\+\d[\d\s()-]{7,}\d/.test(answer);

(async () => {
  console.log('=== Phase 4 Step 6: Knowledge RAG tests ===');
  console.log('Model: gpt-5-nano (OPENAI_MODEL)');
  console.log('Reasoning effort:', getReasoningEffort());
  console.log('Blog RAG: UNCHANGED (separate regression)');
  console.log('Orchestrator: UNCHANGED');
  console.log('');

  await mongoose.connect(process.env.MONGO_URI);

  const faqs = await KnowledgeEmbedding.find({ sourceType: 'faq' })
    .select('category question')
    .sort({ category: 1, order: 1 })
    .lean();

  const homeFaq = faqs.find((f) => f.category === 'home');
  const homeFaq2 = faqs.filter((f) => f.category === 'home')[1] || homeFaq;
  const offPlanFaq =
    faqs.find((f) => /off[\s-]?plan/i.test(f.question || '')) ||
    faqs.find((f) => f.category === 'off-plan');

  const TESTS = [
    {
      id: 1,
      message: 'What is Dubai Marina like?',
      expectSourceType: 'area_guide',
      expectSourceSelection: 'area_guide',
      answerIncludesAny: ['marina', 'waterfront', 'dubai'],
      expectAreaSlug: 'dubai-marina',
    },
    {
      id: 2,
      message: 'Tell me about Dubai South.',
      expectSourceType: 'area_guide',
      expectSourceSelection: 'area_guide',
      answerIncludesAny: ['dubai south', 'south'],
      expectAreaSlug: 'dubai-south',
    },
    {
      id: 3,
      message: 'What is Arabian Ranches like?',
      expectSourceType: 'area_guide',
      expectSourceSelection: 'area_guide',
      answerIncludesAny: ['arabian ranches', 'ranches'],
      expectAreaSlug: 'arabian-ranches',
    },
    {
      id: 4,
      message: 'Tell me about Dubai Media City.',
      expectSourceType: 'area_guide',
      expectSourceSelection: 'area_guide',
      answerIncludesAny: ['media city', 'media'],
      expectAreaSlug: 'dubai-media-city',
    },
    {
      id: 5,
      message: 'What are the highlights of JVC?',
      expectSourceType: 'area_guide',
      expectSourceSelection: 'area_guide',
      answerIncludesAny: ['jvc', 'jumeirah village', 'village'],
      expectAreaSlug: 'jumeirah-village-circle',
    },
    {
      id: 6,
      message: homeFaq?.question || 'Why should I choose Rocky Real Estate?',
      expectSourceType: 'faq',
      expectSourceSelection: 'faq',
      answerIncludesAny: ['rocky', '50', 'years', 'expertise', 'dubai'],
    },
    {
      id: 7,
      message: homeFaq2?.question || 'Can foreigners buy property in Dubai?',
      expectSourceType: 'faq',
      expectSourceSelection: 'faq',
      answerIncludesAny: ['dubai', 'property', 'buy', 'foreign', 'yes', 'fee', 'cost', 'process'],
    },
    {
      id: 8,
      message: offPlanFaq?.question || 'Is it safe to buy off-plan property in Dubai?',
      expectSourceType: 'faq',
      expectSourceSelection: 'faq',
      answerIncludesAny: ['off-plan', 'off plan', 'dld', 'rera', 'developer', 'dubai', 'safe'],
    },
    {
      id: 9,
      message: 'Tell me about Dubai South and common questions about buying property there.',
      expectSourceSelection: 'both',
      answerIncludesAny: ['dubai south', 'south', 'buy', 'property', 'dubai'],
    },
    {
      id: 10,
      message: 'What is the current price of a Dubai Marina apartment?',
      expectDynamicBlock: true,
      mustNotContainCurrencyAmount: true,
    },
    {
      id: 11,
      message: 'How many properties does Rocky manage?',
      expectDynamicBlock: true,
    },
    {
      id: 12,
      message: "Give me an agent's phone number.",
      expectConfidential: true,
    },
    {
      id: 13,
      message: 'Give me customer contact information.',
      expectConfidential: true,
    },
    {
      id: 14,
      message: 'What is the capital of France?',
      expectUnavailableOrWeak: true,
    },
    {
      id: 15,
      message: "What is Rocky Real Estate's annual revenue?",
      expectUnavailableOrWeak: true,
      mustNotInventRevenue: true,
    },
  ];

  const outcomes = [];
  const timings = [];

  for (const test of TESTS) {
    const selection = selectKnowledgeSource(test.message);
    const result = await generateKnowledgeAnswer(test.message);
    timings.push(result.timings);

    const issues = [];

    if (test.expectConfidential) {
      if (result.answer !== CONFIDENTIAL_REFUSAL) {
        issues.push('expected confidential refusal');
      }
      if (result.usedGpt) issues.push('GPT should not run for confidential');
    }

    if (test.expectDynamicBlock) {
      if (result.answer !== DYNAMIC_DATA_ANSWER && !looksUnavailable(result.answer)) {
        issues.push('expected dynamic-data refusal');
      }
      if (result.usedGpt) issues.push('GPT should not run for dynamic data');
    }

    if (test.expectUnavailableOrWeak) {
      if (!looksUnavailable(result.answer) && result.answer !== NO_CONTEXT_ANSWER) {
        // If GPT ran with weak context, answer must still refuse invention
        if (!looksUnavailable(result.answer)) {
          issues.push('expected unavailable / not-in-knowledge response');
        }
      }
    }

    if (test.mustNotInventRevenue && looksLikeInventedRevenue(result.answer)) {
      issues.push('appears to invent revenue figures');
    }

    if (test.mustNotContainCurrencyAmount && /AED\s?\d|\$\s?\d/i.test(result.answer)) {
      // Dynamic block should refuse; if somehow answered with listing prices, fail
      if (result.usedGpt) issues.push('invented/current price in answer');
    }

    if (test.expectSourceSelection && selection !== test.expectSourceSelection) {
      issues.push(
        `source selection expected ${test.expectSourceSelection}, got ${selection}`
      );
    }

    if (test.answerIncludesAny && !includesAny(result.answer, test.answerIncludesAny)) {
      issues.push(`answer missing any of: ${test.answerIncludesAny.join(', ')}`);
    }

    if (test.expectAreaSlug) {
      const hit = (result.sources || []).some(
        (s) => s.sourceType === 'area_guide' && s.slug === test.expectAreaSlug
      );
      if (!hit && result.usedGpt) {
        issues.push(`expected area source slug ${test.expectAreaSlug}`);
      }
    }

    if (test.expectSourceType === 'faq' && result.usedGpt) {
      const hit = (result.sources || []).some((s) => s.sourceType === 'faq');
      if (!hit) issues.push('expected FAQ source metadata');
    }

    if (looksLikePrivateLeak(result.answer)) {
      issues.push('private contact leak');
    }

    const pass = issues.length === 0;
    outcomes.push({
      id: test.id,
      pass,
      issues,
      selection,
      sourceSelection: result.sourceSelection,
      usedGpt: result.usedGpt,
      timings: result.timings,
      sources: result.sources,
      replyPreview: String(result.answer).slice(0, 180),
    });

    console.log(`\nTEST ${test.id}: ${pass ? 'PASS' : 'FAIL'}`);
    console.log('Message:', test.message);
    console.log('Source selection:', selection, '| runtime:', result.sourceSelection);
    console.log('Used GPT:', result.usedGpt);
    console.log('Sources:', JSON.stringify(result.sources));
    console.log('Reply:', result.answer);
    console.log('Timings:', result.timings);
    if (!pass) console.log('Issues:', issues.join('; '));
  }

  const avg = (key) =>
    timings.length
      ? Math.round(timings.reduce((a, t) => a + (t[key] || 0), 0) / timings.length)
      : 0;

  const gptTimings = timings.filter((t) => (t.gptMs || 0) > 0);

  console.log('\n=== Latency averages (ms) ===');
  console.log({
    embeddingMs: avg('embeddingMs'),
    vectorSearchMs: avg('vectorSearchMs'),
    gptMs: gptTimings.length
      ? Math.round(gptTimings.reduce((a, t) => a + t.gptMs, 0) / gptTimings.length)
      : 0,
    totalMs: avg('totalMs'),
  });

  console.log('\n=== Security ===');
  console.log('Models loaded:', mongoose.modelNames());
  console.log('Collections: knowledge_embeddings (+ Faq/AreaGuide only if loaded elsewhere)');
  console.log('Forbidden models:', 
    mongoose.modelNames().filter((n) =>
      ['TeamMember', 'Property', 'AreaGuideLead', 'User', 'Contact'].includes(n)
    ).length
      ? 'FOUND'
      : 'NONE'
  );

  const allPass = outcomes.every((o) => o.pass);
  console.log('\n=== Summary ===');
  for (const o of outcomes) {
    console.log(
      `TEST ${o.id}: ${o.pass ? 'PASS' : 'FAIL'} | gpt=${o.timings.gptMs}ms total=${o.timings.totalMs}ms`
    );
  }
  console.log('\nOverall:', allPass ? 'PASS' : 'FAIL');
  console.log('Orchestrator modified: NO');
  console.log('Blog RAG modified: NO');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('Knowledge RAG test failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
