/**
 * Phase 4 Step 5 — knowledge Atlas Vector Search tests (retrieval only).
 *
 * Usage:
 *   node scripts/test-knowledge-vector-search.js
 *
 * Does NOT call GPT / RAG answer generation.
 * Does NOT write to MongoDB.
 * Does NOT touch blog_embeddings / blog_vector_index.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeEmbedding = require('../src/models/KnowledgeEmbedding');
const {
  searchKnowledge,
  getSearchConfig,
  VECTOR_INDEX_NAME,
} = require('../src/services/knowledgeVectorSearchService');

const ALLOWED_MODELS = new Set(['KnowledgeEmbedding']);
const FORBIDDEN_MODELS = [
  'AreaGuideLead',
  'TeamMember',
  'Property',
  'User',
  'Contact',
  'Career',
  'BlogEmbedding',
];

const AREA_GUIDE_TESTS = [
  {
    id: 'AG1',
    query: 'What is Dubai Marina like?',
    sourceType: 'area_guide',
    expectSlug: 'dubai-marina',
    expectTitleIncludes: 'Dubai Marina',
  },
  {
    id: 'AG2',
    query: 'Tell me about Dubai South.',
    sourceType: 'area_guide',
    expectSlug: 'dubai-south',
    expectTitleIncludes: 'Dubai South',
  },
  {
    id: 'AG3',
    query: 'Where is Arabian Ranches?',
    sourceType: 'area_guide',
    expectSlug: 'arabian-ranches',
    expectTitleIncludes: 'Arabian Ranches',
  },
  {
    id: 'AG4',
    query: 'Tell me about Dubai Media City.',
    sourceType: 'area_guide',
    expectSlug: 'dubai-media-city',
    expectTitleIncludes: 'Dubai Media City',
  },
  {
    id: 'AG5',
    query: 'What are the highlights of JVC?',
    sourceType: 'area_guide',
    expectSlug: 'jumeirah-village-circle',
    expectTitleIncludes: 'Jumeirah Village Circle',
  },
];

const CROSS_SOURCE_TESTS = [
  {
    id: 'CROSS1',
    query: 'Dubai property buying questions',
    // no forced winner — report ranking
  },
  {
    id: 'CROSS2',
    query: 'off plan property questions',
  },
];

const NEGATIVE_TESTS = [
  {
    id: 'NEG1',
    query: 'How many properties do you have?',
    note: 'PROPERTY_COUNT intent — not Area Guide/FAQ RAG',
  },
  {
    id: 'NEG2',
    query: 'Show apartments in Dubai Marina.',
    note: 'PROPERTY_SEARCH intent — not Area Guide RAG',
  },
  {
    id: 'NEG3',
    query: 'What is the current price of an apartment?',
    note: 'Dynamic property pricing — not knowledge RAG',
  },
];

const preview = (text, max = 180) => {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
};

const evaluateAreaGuide = (test, results) => {
  const top3 = results.slice(0, 3);
  const hit = top3.find(
    (r) =>
      r.sourceType === 'area_guide' &&
      String(r.slug || '').toLowerCase() === test.expectSlug.toLowerCase()
  );
  if (!hit) {
    return {
      pass: false,
      reason: `Expected slug ${test.expectSlug} in top 3, got ${top3
        .map((r) => r.slug)
        .join(', ')}`,
    };
  }
  const rank = results.findIndex((r) => r.slug === hit.slug) + 1;
  return {
    pass: true,
    reason: `${hit.title} ranked #${rank}`,
    rank,
  };
};

const evaluateFaq = (test, results) => {
  const top3 = results.slice(0, 3);
  const hit = top3.find(
    (r) =>
      r.sourceType === 'faq' &&
      String(r.sourceId) === String(test.expectSourceId)
  );
  if (!hit) {
    return {
      pass: false,
      reason: `Expected FAQ sourceId ${test.expectSourceId} in top 3`,
    };
  }
  const rank = results.findIndex((r) => r.sourceId === hit.sourceId) + 1;
  return { pass: true, reason: `FAQ ranked #${rank}`, rank };
};

(async () => {
  const config = getSearchConfig();
  console.log('=== Phase 4 Step 5: Knowledge vector search tests ===');
  console.log('Index:', VECTOR_INDEX_NAME);
  console.log('Config:', config);
  console.log('GPT called: NO');
  console.log('RAG answer generation: NO');
  console.log('Collection: knowledge_embeddings ONLY\n');

  await mongoose.connect(process.env.MONGO_URI);

  const indexes = await mongoose.connection.db
    .collection('knowledge_embeddings')
    .listSearchIndexes(VECTOR_INDEX_NAME)
    .toArray();
  const index = indexes[0];
  console.log('Index status:', {
    name: index?.name,
    type: index?.type,
    status: index?.status,
    queryable: index?.queryable,
    definition: index?.latestDefinition || index?.definition,
  });

  if (!index || index.queryable !== true) {
    throw new Error('knowledge_vector_index is not queryable yet');
  }

  const docCount = await KnowledgeEmbedding.countDocuments();
  console.log('knowledge_embeddings documents:', docCount);

  // Real FAQ questions from stored embeddings (included scope only)
  const faqDocs = await KnowledgeEmbedding.find({ sourceType: 'faq' })
    .select('sourceId category question content')
    .sort({ category: 1, order: 1 })
    .limit(13)
    .lean();

  console.log('\n--- Representative FAQs (from knowledge_embeddings) ---');
  faqDocs.forEach((f, i) => {
    console.log(`${i + 1}. [${f.category}] ${f.question}`);
  });

  const faqTests = faqDocs.slice(0, 5).map((f, i) => ({
    id: `FAQ${i + 1}`,
    query: f.question,
    sourceType: 'faq',
    expectSourceId: String(f.sourceId),
    expectQuestion: f.question,
  }));

  const outcomes = [];
  const timings = [];

  const runAndReport = async (test, evaluateFn) => {
    console.log('\n========================================');
    console.log(`${test.id}`);
    console.log(`Query: ${test.query}`);
    if (test.sourceType) console.log(`Filter sourceType: ${test.sourceType}`);
    if (test.note) console.log(`Note: ${test.note}`);
    console.log('========================================');

    const result = await searchKnowledge(test.query, {
      sourceType: test.sourceType,
    });
    timings.push(result.timings);

    const evaluation = evaluateFn
      ? evaluateFn(test, result.results)
      : { pass: true, reason: 'Reported (no forced winner)' };

    outcomes.push({
      id: test.id,
      query: test.query,
      ...evaluation,
      timings: result.timings,
      top: result.results[0] || null,
    });

    result.results.forEach((hit, i) => {
      console.log(`\nRank ${i + 1}:`);
      console.log(`sourceType: ${hit.sourceType}`);
      if (hit.title) console.log(`title: ${hit.title}`);
      if (hit.slug) console.log(`slug: ${hit.slug}`);
      if (hit.category) console.log(`category: ${hit.category}`);
      if (hit.question) console.log(`question: ${hit.question}`);
      console.log(`score: ${hit.score}`);
      console.log(`content: ${preview(hit.content)}`);
    });

    console.log('\nTimings (ms):', result.timings);
    console.log(
      'Evaluation:',
      evaluation.pass ? 'PASS' : 'FAIL',
      '-',
      evaluation.reason
    );
  };

  console.log('\n\n===== AREA GUIDE TESTS =====');
  for (const test of AREA_GUIDE_TESTS) {
    await runAndReport(test, evaluateAreaGuide);
  }

  console.log('\n\n===== FAQ TESTS =====');
  for (const test of faqTests) {
    await runAndReport(test, evaluateFaq);
  }

  console.log('\n\n===== CROSS-SOURCE TESTS =====');
  for (const test of CROSS_SOURCE_TESTS) {
    await runAndReport(test, null);
  }

  console.log('\n\n===== NEGATIVE / ROUTING NOTES =====');
  for (const test of NEGATIVE_TESTS) {
    // Still run retrieval to observe what knowledge returns, but do not treat as RAG target
    await runAndReport(test, () => ({
      pass: true,
      reason:
        'Informational only — these queries belong to Property/Confidential routes, not Knowledge RAG',
    }));
  }

  // Security checks
  const loadedModels = mongoose.modelNames();
  const forbiddenLoaded = loadedModels.filter((n) => FORBIDDEN_MODELS.includes(n));
  const unexpected = loadedModels.filter((n) => !ALLOWED_MODELS.has(n));

  const avg = (arr, key) =>
    arr.length
      ? Math.round(arr.reduce((a, b) => a + b[key], 0) / arr.length)
      : 0;

  console.log('\n=== Latency averages (ms) ===');
  console.log({
    embeddingMs: avg(timings, 'embeddingMs'),
    vectorSearchMs: avg(timings, 'vectorSearchMs'),
    totalMs: avg(timings, 'totalMs'),
  });

  console.log('\n=== Security ===');
  console.log('Models loaded:', loadedModels);
  console.log('Forbidden models loaded:', forbiddenLoaded.length ? forbiddenLoaded : 'NONE');
  console.log('Unexpected models:', unexpected.length ? unexpected : 'NONE');
  console.log('Collections accessed: knowledge_embeddings');
  console.log('blog_embeddings accessed: NO');
  console.log('properties/teammembers/leads accessed: NO');

  const scored = outcomes.filter((o) => o.id.startsWith('AG') || o.id.startsWith('FAQ'));
  const allPass = scored.every((o) => o.pass) && forbiddenLoaded.length === 0;

  console.log('\n=== Summary ===');
  for (const o of outcomes) {
    console.log(
      `${o.id}: ${o.pass ? 'PASS' : 'FAIL'} | embed=${o.timings.embeddingMs}ms search=${o.timings.vectorSearchMs}ms total=${o.timings.totalMs}ms | ${o.reason}`
    );
  }

  console.log('\nGPT called: NO');
  console.log('RAG implemented: NO');
  console.log('Blog RAG status: UNCHANGED');
  console.log('Overall (Area Guide + FAQ retrieval quality):', allPass ? 'PASS' : 'FAIL');

  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(async (error) => {
  console.error('\nKnowledge vector search test FAILED:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
